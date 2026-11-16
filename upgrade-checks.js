// Detects the upgrade steps a 3.x setup left behind, for session start and doctor.
// Hooks import this module, so it uses only relative and node: imports.

import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDevlog } from "./devlog.js";
import { parseHeadings } from "./markdown.js";
import { claudeFileDirs } from "./hooks/resolve-project.js";
import { readDismissals, isDismissed } from "./upgrade-dismissals.js";

/**
 * @typedef {object} UpgradeStep
 * @property {import("./upgrade-dismissals.js").StepId} id
 * @property {boolean} required true for devlog-template and devlog-migration
 * @property {string|null} target as in DismissalKey
 * @property {"left"|"done"|"dismissed"} state dismissed: left, but dismissed on this device for this vault and target
 * @property {string} summary one sentence: what is left and why it matters; "" when done
 * @property {string} fix one or two sentences telling Claude how to finish it, commands spelled out; "" when done
 * @property {string} [shortFix] a shorter fix for when the session-start block runs out of room
 * @property {string} dismiss the command that dismisses it on this device
 */

/**
 * @typedef {object} UpgradeReport
 * @property {UpgradeStep[]} steps devlog-template, then devlog-migration (when projectPath), then
 *   claude-md-section (when cwd); a step whose check failed is left out
 * @property {string[]} otherProjects sorted "01-Projects/<name>" paths, never projectPath, whose devlog.md has
 *   no ```base line in its first 4,096 bytes and whose devlog-migration is not dismissed
 * @property {string} othersFix how to migrate the other projects, commands spelled out; "" when there are none
 * @property {string|null} dismissalError readDismissals' error
 * @property {string[]} errors "<step id>: <message>" for each check that failed
 */

/**
 * @typedef {object} CheckOptions
 * @property {string} vaultPath
 * @property {string|null} projectPath vault-relative, "/"-separated; null skips devlog-migration
 * @property {string|null} cwd null skips claude-md-section
 * @property {string} packageSpec e.g. "obsidian-pkm@^4"
 * @property {string} [home] for the dismissal file and the home exclusion (default os.homedir())
 * @property {string} [git]
 * @property {number} [timeoutMs]
 */

/** @typedef {{ vaultPath: string, packageSpec: string }} Where */

const PACKAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const BUNDLED_HUB = path.join(PACKAGE_ROOT, "templates", "devlog.md");
const PROJECTS_DIR = "01-Projects";
// Enough for a hub's frontmatter and title; the check reads no further, so large devlogs cost nothing.
const HEAD_BYTES = 4096;
const BASE_LINE = /^```base\r?$/m;
const PLAIN_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;
const SPEC = /^obsidian-pkm(@\S+)?$/;
const CLAUDE_FILES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md")];

/**
 * @param {CheckOptions} options
 * @returns {Promise<UpgradeReport>}
 */
export async function checkUpgrade({ vaultPath, projectPath, cwd, packageSpec, home, git, timeoutMs }) {
  const vault = path.resolve(vaultPath);
  /** @type {Where} */
  const where = { vaultPath: vault, packageSpec };
  const { dismissals, error: dismissalError } = await readDismissals({ home });

  /** @type {Array<[import("./upgrade-dismissals.js").StepId, () => Promise<UpgradeStep|null>]>} */
  const checks = [["devlog-template", () => templateStep(vault, where)]];
  if (projectPath !== null) checks.push(["devlog-migration", () => migrationStep(vault, projectPath, where)]);
  if (cwd !== null) checks.push(["claude-md-section", () => claudeMdStep(cwd, where, { home, git, timeoutMs })]);

  const [outcomes, otherProjects] = await Promise.all([
    Promise.all(checks.map(async ([id, run]) => {
      try {
        return { step: await run() };
      } catch (e) {
        return { error: `${id}: ${e.message}` };
      }
    })),
    unmigratedProjects(vault, projectPath, dismissals),
  ]);

  /** @type {UpgradeStep[]} */
  const steps = [];
  const errors = [];
  for (const outcome of outcomes) {
    if ("error" in outcome) errors.push(outcome.error);
    else if (outcome.step) steps.push(applyDismissal(outcome.step, dismissals, vault));
  }

  const othersFix = otherProjects.length === 0
    ? ""
    : `For each, once every device using this vault has the updated plugin: preview with \`${cliCommand(where, "migrate-devlog")} <project path>\`, then rerun it with --apply on the user's OK. Never: \`${cliCommand(where, "upgrade", "dismiss", "devlog-migration")} <project path>\`.`;
  return { steps, otherProjects, othersFix, dismissalError, errors };
}

/**
 * @param {UpgradeStep} step
 * @param {import("./upgrade-dismissals.js").Dismissal[]} dismissals
 * @param {string} vault
 * @returns {UpgradeStep}
 */
function applyDismissal(step, dismissals, vault) {
  if (step.state !== "left" || !isDismissed(dismissals, { step: step.id, vault, target: step.target })) return step;
  return { ...step, state: "dismissed" };
}

/**
 * @param {Omit<UpgradeStep, "state"|"summary"|"fix">} step
 * @returns {UpgradeStep}
 */
function done(step) {
  return { ...step, state: "done", summary: "", fix: "" };
}

/** @param {string} file @returns {Promise<string|null>} null when the file or a parent folder is missing */
async function readIfExists(file) {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/** @param {string} vault @param {Where} where @returns {Promise<UpgradeStep>} */
async function templateStep(vault, where) {
  const step = {
    id: /** @type {const} */ ("devlog-template"),
    required: true,
    target: null,
    dismiss: cliCommand(where, "upgrade", "dismiss", "devlog-template"),
  };
  const text = await readIfExists(path.join(vault, "05-Templates", "devlog.md"));
  if (text === null || BASE_LINE.test(text)) return done(step);
  return {
    ...step,
    state: "left",
    summary: "05-Templates/devlog.md is the old devlog template, so new hubs made from it lack their table.",
    fix: `Delete it (the bundled hub template then applies), or, if the user customised it, replace it with ${BUNDLED_HUB}.`,
    shortFix: "Delete it (the bundled hub template then applies).",
  };
}

/** @param {string} vault @param {string} projectPath @param {Where} where @returns {Promise<UpgradeStep>} */
async function migrationStep(vault, projectPath, where) {
  const target = projectPath.replace(/\/+$/, "");
  const step = {
    id: /** @type {const} */ ("devlog-migration"),
    required: true,
    target,
    dismiss: cliCommand(where, "upgrade", "dismiss", "devlog-migration", target),
  };
  const rel = `${target}/development/devlog.md`;
  const text = await readIfExists(path.join(vault, ...rel.split("/")));
  const count = text === null ? 0 : parseDevlog(text).entries.length;
  if (count === 0) return done(step);
  return {
    ...step,
    state: "left",
    summary: `${rel} still holds ${count} old-style ${count === 1 ? "entry" : "entries"}.`,
    fix: `Ask whether every device using this vault has the updated plugin, then preview with \`${cliCommand(where, "migrate-devlog", target)}\` and rerun it with --apply on the user's OK.`,
  };
}

/**
 * @param {string} cwd
 * @param {Where} where
 * @param {{ home?: string, git?: string, timeoutMs?: number }} options
 * @returns {Promise<UpgradeStep|null>} null when no folder applies (cwd is the home folder outside git)
 */
async function claudeMdStep(cwd, where, options) {
  const { dirs, repoRoot } = await claudeFileDirs(cwd, options);
  if (dirs.length === 0) return null;
  const target = repoRoot ?? dirs[0];
  const step = {
    id: /** @type {const} */ ("claude-md-section"),
    required: false,
    target,
    dismiss: cliCommand(where, "upgrade", "dismiss", "claude-md-section", target),
  };
  const files = [];
  for (const dir of dirs) {
    for (const name of CLAUDE_FILES) {
      const file = path.join(dir, name);
      let text;
      try {
        text = await fs.readFile(file, "utf-8");
      } catch {
        continue;
      }
      const headings = parseHeadings(text.replace(/^\uFEFF/, ""));
      if (headings.some((h) => h.level === 2 && h.text.trim() === "PKM Integration")) files.push(file);
    }
  }
  if (files.length === 0) return done(step);
  return {
    ...step,
    state: "left",
    summary: `${files.join(" and ")} ${files.length === 1 ? "has" : "have"} a "## PKM Integration" section, which the server instructions now replace.`,
    fix: 'Offer to remove it, from the heading to the next # or ## heading but keeping any "# PKM:" line; edit only with the user\'s OK.',
  };
}

/**
 * @param {string} vault
 * @param {string|null} projectPath
 * @param {import("./upgrade-dismissals.js").Dismissal[]} dismissals
 * @returns {Promise<string[]>}
 */
async function unmigratedProjects(vault, projectPath, dismissals) {
  let entries;
  try {
    entries = await fs.readdir(path.join(vault, PROJECTS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  const current = projectPath === null ? null : projectPath.replace(/\/+$/, "");
  const found = await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) return null;
    const rel = `${PROJECTS_DIR}/${entry.name}`;
    if (rel === current || isDismissed(dismissals, { step: "devlog-migration", vault, target: rel })) return null;
    const head = await readHead(path.join(vault, PROJECTS_DIR, entry.name, "development", "devlog.md"));
    return head !== null && !BASE_LINE.test(head) ? rel : null;
  }));
  return found.filter((rel) => rel !== null).sort();
}

/** @param {string} file @returns {Promise<string|null>} the first HEAD_BYTES, or null when it can't be read */
async function readHead(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The npm spec the plugin starts its server with, from .claude-plugin/plugin.json.
 * @param {string} [pluginRoot] defaults to this module's folder
 * @returns {Promise<string|null>}
 */
export async function readPackageSpec(pluginRoot = PACKAGE_ROOT) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8"));
    const args = manifest?.mcpServers?.["vault-pkm"]?.args;
    if (!Array.isArray(args)) return null;
    return args.find((arg) => typeof arg === "string" && SPEC.test(arg)) ?? null;
  } catch {
    return null;
  }
}

/**
 * POSIX shell quoting: plain words stay bare, anything else goes in single quotes.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  if (PLAIN_WORD.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A command that runs the plugin's server CLI with this vault, whatever the shell's directory and environment.
 * @param {Where} where
 * @param {...string} args
 * @returns {string}
 */
export function cliCommand({ vaultPath, packageSpec }, ...args) {
  return [`VAULT_PATH=${shellQuote(path.resolve(vaultPath))}`, "npx", "-y", shellQuote(packageSpec), ...args.map(shellQuote)].join(" ");
}
