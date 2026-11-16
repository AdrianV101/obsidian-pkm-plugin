// Detects the upgrade steps a 3.x setup left behind, for session start and doctor.
// Hooks import this module, so it uses only relative and node: imports.

/**
 * @typedef {object} UpgradeStep
 * @property {import("./upgrade-dismissals.js").StepId} id
 * @property {boolean} required true for devlog-template and devlog-migration
 * @property {string|null} target as in DismissalKey
 * @property {"left"|"done"|"dismissed"} state dismissed: left, but dismissed on this device for this vault and target
 * @property {string} summary one sentence: what is left and why it matters; "" when done
 * @property {string} fix one or two sentences telling Claude how to finish it, commands spelled out; "" when done
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

/**
 * @param {CheckOptions} options
 * @returns {Promise<UpgradeReport>}
 */
export async function checkUpgrade(options) {
  throw new Error("not implemented");
}

/**
 * The npm spec the plugin starts its server with, from .claude-plugin/plugin.json.
 * @param {string} [pluginRoot] defaults to this module's folder
 * @returns {Promise<string|null>}
 */
export async function readPackageSpec(pluginRoot) {
  throw new Error("not implemented");
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  throw new Error("not implemented");
}

/**
 * @param {{ vaultPath: string, packageSpec: string }} where
 * @param {...string} args
 * @returns {string}
 */
export function cliCommand(where, ...args) {
  throw new Error("not implemented");
}
