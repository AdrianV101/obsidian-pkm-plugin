// The session-start block that tells Claude which upgrade steps are left.
// Hooks run without node_modules: relative and node: imports only.

export const UPGRADE_BLOCK_MAX = 1200;

/**
 * @param {import("../upgrade-checks.js").UpgradeReport} report
 * @param {{ doctorCommand: string, maxChars?: number }} options
 * @returns {string} "" when nothing is left
 */
export function formatUpgradeBlock(report, options) {
  throw new Error("not implemented");
}
