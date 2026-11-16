// Records the upgrade steps a user said "never" to, per device. Session start and
// `obsidian-pkm upgrade` must read the same file, and a command Claude runs may not
// see $CLAUDE_PLUGIN_DATA, so the file sits at a fixed place under ~/.claude.
// Hooks import this module, so it uses only relative and node: imports.

import os from "node:os";
import path from "node:path";

/** @typedef {"devlog-template" | "devlog-migration" | "claude-md-section"} StepId */

/** @type {readonly StepId[]} */
export const STEP_IDS = ["devlog-template", "devlog-migration", "claude-md-section"];

/**
 * @typedef {object} DismissalKey
 * @property {StepId} step
 * @property {string} vault absolute vault folder
 * @property {string|null} target null for devlog-template (the vault itself); the vault-relative
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

/**
 * @param {{ step: string, vault: string, target: string|null }} key
 * @returns {string|null} why the key is invalid, or null
 */
export function validateDismissal(key) {
  throw new Error("not implemented");
}

/**
 * @param {{ home?: string }} [options]
 * @returns {Promise<DismissalRead>}
 */
export async function readDismissals(options) {
  throw new Error("not implemented");
}

/**
 * @param {DismissalKey} key
 * @param {{ home?: string, now?: Date }} [options]
 * @returns {Promise<{ replaced: string|null }>} replaced: the read error of an unreadable file it overwrote
 */
export async function addDismissal(key, options) {
  throw new Error("not implemented");
}

/**
 * @param {{ home?: string }} [options]
 * @returns {Promise<number>} how many dismissals were removed
 */
export async function clearDismissals(options) {
  throw new Error("not implemented");
}

/**
 * @param {Dismissal[]} dismissals
 * @param {DismissalKey} key
 * @returns {boolean}
 */
export function isDismissed(dismissals, key) {
  throw new Error("not implemented");
}
