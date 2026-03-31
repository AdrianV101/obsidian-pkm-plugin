import fs from "fs/promises";
import os from "os";
import { loadTemplates } from "./helpers.js";

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

  // 2. VAULT_PATH set
  const vaultPath = process.env.VAULT_PATH || (os.homedir() + "/Documents/PKM");
  if (process.env.VAULT_PATH) {
    ok(`VAULT_PATH: ${vaultPath}`);
    passed++;
  } else {
    warn(`VAULT_PATH not set, using default: ${vaultPath}`);
    warnings++;
  }

  // 3. Vault is a directory
  try {
    const stat = await fs.stat(vaultPath);
    if (stat.isDirectory()) {
      ok("Vault is a directory");
      passed++;
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

  // 4. Templates
  try {
    const templates = await loadTemplates(vaultPath);
    if (templates.size > 0) {
      ok(`${templates.size} template${templates.size === 1 ? "" : "s"} in 05-Templates/`);
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
  const apiKey = process.env.OBSIDIAN_PKM_OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (apiKey && !apiKey.startsWith("${")) {
    ok("OBSIDIAN_PKM_OPENAI_KEY set (semantic search enabled)");
    passed++;
  } else {
    warn("OBSIDIAN_PKM_OPENAI_KEY not set (semantic search disabled)");
    warnings++;
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
