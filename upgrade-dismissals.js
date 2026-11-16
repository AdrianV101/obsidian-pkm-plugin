// Records the upgrade steps a user said "never" to, per device. Session start and
// `obsidian-pkm upgrade` must read the same file, and a command Claude runs may not
// see $CLAUDE_PLUGIN_DATA, so the file sits at a fixed place under ~/.claude.
// Hooks import this module, so it uses only relative and node: imports.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** @typedef {"devlog-template" | "devlog-migration" | "claude-md-section" | "activity-retention"} StepId */

/** @type {readonly StepId[]} */
export const STEP_IDS = ["devlog-template", "devlog-migration", "claude-md-section", "activity-retention"];

/** Steps that apply to the whole vault, so their dismissals take no target. */
const VAULT_WIDE = new Set(["devlog-template", "activity-retention"]);

/**
 * @typedef {object} DismissalKey
 * @property {StepId} step
 * @property {string} vault absolute vault folder
 * @property {string|null} target null for devlog-template and activity-retention (the vault itself); the vault-relative
 *   project path for devlog-migration; the repo root for claude-md-section
 */
/** @typedef {DismissalKey & { at: string }} Dismissal at: ISO time it was recorded */
/** @typedef {{ dismissals: Dismissal[], error: string|null }} DismissalRead */

/**
 * @param {string} [home]
 * @returns {string}
 */
export function dismissalFile(home = os.homedir()) {
  return path.join(home, ".claude", "vault-pkm", "upgrade-dismissals.json");
}

const FORMAT_VERSION = 1;

/**
 * @param {{ step: string, vault: string, target: string|null }} key
 * @returns {string|null} why the key is invalid, or null
 */
export function validateDismissal(key) {
  const { step, vault, target } = key;
  if (!STEP_IDS.includes(/** @type {StepId} */ (step))) {
    return `Unknown step: ${step} (expected one of ${STEP_IDS.join(", ")})`;
  }
  if (typeof vault !== "string" || vault === "") return "The vault path is missing";
  if (VAULT_WIDE.has(step)) {
    return target === null ? null : `${step} applies to the whole vault and takes no target`;
  }
  if (typeof target !== "string" || target.trim() === "") {
    return `${step} needs a target: ${step === "devlog-migration" ? "the project path" : "the repo root"}`;
  }
  return null;
}

/**
 * The key as stored: vault and repo root resolved, the project path without trailing slashes.
 * A project given as a bare name is a folder under 01-Projects, as `migrate-devlog` reads it.
 * @param {DismissalKey} key
 * @returns {DismissalKey}
 */
function normalise({ step, vault, target }) {
  let normalTarget = null;
  if (step === "devlog-migration") {
    normalTarget = target.replace(/\/+$/, "");
    if (!normalTarget.includes("/")) normalTarget = `01-Projects/${normalTarget}`;
  } else if (step === "claude-md-section") normalTarget = path.resolve(target);
  return { step, vault: path.resolve(vault), target: normalTarget };
}

/** @param {unknown} entry @returns {entry is Dismissal} */
function isEntry(entry) {
  if (typeof entry !== "object" || entry === null) return false;
  const { step, vault, target, at } = /** @type {Record<string, unknown>} */ (entry);
  return (
    typeof vault === "string" &&
    typeof at === "string" &&
    (target === null || typeof target === "string") &&
    validateDismissal({ step: String(step), vault, target: /** @type {string|null} */ (target) }) === null
  );
}

/**
 * @param {{ home?: string }} [options]
 * @returns {Promise<DismissalRead>}
 */
export async function readDismissals({ home } = {}) {
  let text;
  try {
    text = await fs.readFile(dismissalFile(home), "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return { dismissals: [], error: null };
    return { dismissals: [], error: e.message };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { dismissals: [], error: "not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data) || data.version !== FORMAT_VERSION || !Array.isArray(data.dismissed)) {
    return { dismissals: [], error: `not a version ${FORMAT_VERSION} dismissal file` };
  }
  return { dismissals: data.dismissed.filter(isEntry), error: null };
}

/**
 * Write through a temporary file, so a session reading at the same moment never sees half a file.
 * @param {string} file
 * @param {Dismissal[]} dismissals
 */
async function writeDismissals(file, dismissals) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: FORMAT_VERSION, dismissed: dismissals }, null, 2)}\n`);
  await fs.rename(tmp, file);
}

/**
 * @param {DismissalKey} key
 * @param {{ home?: string, now?: Date }} [options]
 * @returns {Promise<{ replaced: string|null }>} replaced: the read error of an unreadable file it overwrote
 */
export async function addDismissal(key, { home, now = new Date() } = {}) {
  const problem = validateDismissal(key);
  if (problem) throw new Error(problem);
  const { dismissals, error } = await readDismissals({ home });
  const normal = normalise(key);
  if (error === null && isDismissed(dismissals, normal)) return { replaced: null };
  await writeDismissals(dismissalFile(home), [...dismissals, { ...normal, at: now.toISOString() }]);
  return { replaced: error };
}

/**
 * @param {{ home?: string }} [options]
 * @returns {Promise<number>} how many dismissals were removed
 */
export async function clearDismissals({ home } = {}) {
  const file = dismissalFile(home);
  try {
    await fs.access(file);
  } catch {
    return 0;
  }
  const { dismissals } = await readDismissals({ home });
  await writeDismissals(file, []);
  return dismissals.length;
}

/**
 * @param {Dismissal[]} dismissals
 * @param {DismissalKey} key
 * @returns {boolean}
 */
export function isDismissed(dismissals, key) {
  if (validateDismissal(key) !== null) return false;
  const want = normalise(key);
  return dismissals.some((d) => {
    if (validateDismissal(d) !== null) return false;
    const have = normalise(d);
    return have.step === want.step && have.vault === want.vault && have.target === want.target;
  });
}
