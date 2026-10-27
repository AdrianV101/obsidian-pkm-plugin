import fs from "fs/promises";
import os from "os";
import path from "path";
import { loadTemplates } from "./helpers.js";
import { resolveProject, describeVia } from "./hooks/resolve-project.js";
import { healthFromStats, describeHealth } from "./semantic-health.js";

const SETTINGS_LABEL = "~/.claude/settings.json";
// Same precedence as the server's key lookup in index.js.
const KEY_NAMES = ["VAULT_PKM_OPENAI_KEY", "OBSIDIAN_PKM_OPENAI_KEY", "OPENAI_API_KEY"];

const isNonEmptyString = (v) => typeof v === "string" && v !== "";
// An unexpanded "${VAR}" placeholder means the variable was never set.
const isUsableKey = (v) => isNonEmptyString(v) && !v.startsWith("${");

/**
 * Read the `env` block of Claude Code's user settings. Claude Code applies it to
 * the MCP server, but a terminal running `obsidian-pkm doctor` never sees it.
 * @param {string} homeDir
 * @returns {Promise<{ env: Record<string, unknown>, error: string|null }>}
 */
async function readSettingsEnv(homeDir) {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(homeDir, ".claude", "settings.json"), "utf-8"));
    const env = settings && typeof settings.env === "object" && settings.env !== null ? settings.env : {};
    return { env, error: null };
  } catch (e) {
    if (e.code === "ENOENT") return { env: {}, error: null };
    // JSON.parse messages can embed a snippet of the file, which may hold an API key.
    return { env: {}, error: e instanceof SyntaxError ? "not valid JSON" : e.message };
  }
}

/**
 * Look a variable up in the process environment, then in the settings.json env block.
 * @param {string} name
 * @param {Record<string, unknown>} settingsEnv
 * @param {(v: unknown) => boolean} isUsable
 * @returns {{ value: string, source: string, shadowsDifferent: boolean } | null}
 *   shadowsDifferent: the environment won while settings.json holds another usable value for the same name
 */
function lookup(name, settingsEnv, isUsable) {
  if (isUsable(process.env[name])) {
    const shadowsDifferent = isUsable(settingsEnv[name]) && String(settingsEnv[name]) !== String(process.env[name]);
    return { value: String(process.env[name]), source: "environment", shadowsDifferent };
  }
  if (isUsable(settingsEnv[name])) return { value: String(settingsEnv[name]), source: SETTINGS_LABEL, shadowsDifferent: false };
  return null;
}

export async function runDoctor() {
  let passed = 0;
  let warnings = 0;
  let failed = 0;

  console.log("\nobsidian-pkm doctor\n");

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major >= 20) {
    ok(`Node.js v${nodeVersion} (required: >= 20)`);
    passed++;
  } else {
    fail(`Node.js v${nodeVersion} — requires >= 20`);
    failed++;
  }

  const settings = await readSettingsEnv(os.homedir());
  if (settings.error) {
    warn(`Could not read ${SETTINGS_LABEL}: ${settings.error}`);
    warnings++;
  }

  // 2. VAULT_PATH set
  const vaultSetting = lookup("VAULT_PATH", settings.env, isNonEmptyString);
  const vaultPath = vaultSetting ? vaultSetting.value : (os.homedir() + "/Documents/PKM");
  if (vaultSetting) {
    ok(`VAULT_PATH: ${vaultPath} (from ${vaultSetting.source})`);
    passed++;
    if (vaultSetting.shadowsDifferent) {
      warn(`VAULT_PATH differs between the environment and ${SETTINGS_LABEL}; using the environment value`);
      warnings++;
    }
  } else {
    warn(`VAULT_PATH not set in the environment or ${SETTINGS_LABEL}, using default: ${vaultPath}`);
    warnings++;
  }

  // 3. Vault is a directory
  let vaultOk = false;
  try {
    const stat = await fs.stat(vaultPath);
    if (stat.isDirectory()) {
      ok("Vault is a directory");
      passed++;
      vaultOk = true;
    } else {
      fail(`VAULT_PATH is not a directory: ${vaultPath}`);
      failed++;
    }
  } catch (e) {
    if (e.code === "ENOENT") {
      fail(`Vault directory does not exist: ${vaultPath}`);
    } else {
      fail(`Cannot access vault: ${e.message}`);
    }
    failed++;
  }

  // 3b. The project this folder resolves to
  if (vaultOk) {
    const cwd = process.cwd();
    const resolution = await resolveProject(cwd, vaultPath);
    if (resolution.projectPath) {
      ok(`Project for ${cwd}: ${resolution.projectPath} (${describeVia(resolution)})`);
      passed++;
    } else {
      warn(`Project for ${cwd}: not linked (${resolution.reason})`);
      warnings++;
    }
  }

  // 4. Templates
  try {
    const templates = await loadTemplates(vaultPath);
    const vaultTemplates = [...templates.values()].filter((t) => t.source === "vault").length;
    if (vaultTemplates > 0) {
      ok(`${vaultTemplates} template${vaultTemplates === 1 ? "" : "s"} in 05-Templates/`);
      passed++;
    } else {
      warn("No templates found in 05-Templates/ \u2014 run 'npx obsidian-pkm init' to install");
      warnings++;
    }
  } catch {
    warn("Could not load templates (05-Templates/ may not exist)");
    warnings++;
  }

  // 5. OpenAI key
  let apiKey = null;
  let keyName = null;
  for (const name of KEY_NAMES) {
    apiKey = lookup(name, settings.env, isUsableKey);
    if (apiKey) {
      keyName = name;
      break;
    }
  }
  if (apiKey) {
    ok(`VAULT_PKM_OPENAI_KEY set (from ${apiKey.source}${keyName === KEY_NAMES[0] ? "" : ` as ${keyName}`}; semantic search enabled)`);
    passed++;
    if (apiKey.shadowsDifferent) {
      warn(`${keyName} differs between the environment and ${SETTINGS_LABEL}; using the environment value`);
      warnings++;
    }
    if (keyName === "OBSIDIAN_PKM_OPENAI_KEY") {
      warn("OBSIDIAN_PKM_OPENAI_KEY is deprecated — rename to VAULT_PKM_OPENAI_KEY");
      warnings++;
    }
  } else {
    warn("VAULT_PKM_OPENAI_KEY not set (semantic search disabled)");
    warnings++;
  }

  // 5b. Semantic index health, as last reported by the MCP server
  if (apiKey) {
    let stats = null;
    try {
      stats = JSON.parse(await fs.readFile(path.join(vaultPath, ".obsidian", "semantic-stats.json"), "utf-8"));
    } catch {
      // missing or unreadable: reported below
    }
    const health = healthFromStats(stats);
    if (!stats) {
      warn("Semantic index has not reported yet (no .obsidian/semantic-stats.json); start the MCP server once");
      warnings++;
    } else if (!health) {
      ok(`Semantic index: ${stats.indexed_files}/${stats.vault_files} notes indexed (health not reported by this server version)`);
      passed++;
    } else if (health.status === "disabled") {
      warn(`Semantic index ${describeHealth(health)}`);
      warnings++;
    } else {
      ok(`Semantic index ${describeHealth(health)} (${stats.indexed_files}/${stats.vault_files} notes indexed, last success ${health.lastSuccessAt ?? "never"})`);
      passed++;
    }
  }

  // 6. better-sqlite3
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    ok("better-sqlite3 loaded");
    passed++;
  } catch (e) {
    fail(`better-sqlite3 failed: ${e.message}`);
    failed++;
  }

  // 7. sqlite-vec
  try {
    const { default: Database } = await import("better-sqlite3");
    const sqliteVec = await import("sqlite-vec");
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.close();
    ok("sqlite-vec loaded");
    passed++;
  } catch (e) {
    fail(`sqlite-vec failed: ${e.message}`);
    failed++;
  }

  // Summary
  console.log("");
  const parts = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
  if (failed > 0) parts.push(`${failed} failed`);
  console.log(parts.join(", ") + ".");

  if (failed > 0) process.exit(1);
}

function ok(msg) { console.log(`  \u2713 ${msg}`); }
function warn(msg) { console.log(`  \u26A0 ${msg}`); }
function fail(msg) { console.log(`  \u2717 ${msg}`); }
