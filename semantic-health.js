// Dependency-free: imported by hooks/session-start.js, which runs without node_modules.

/**
 * @typedef {Object} SemanticHealth
 * @property {"ok"|"syncing"|"disabled"} status
 * @property {string|null} reason - why the index is disabled (null unless disabled)
 * @property {string|null} since - ISO timestamp when the index was disabled
 * @property {number} staleFiles - notes changed or missing since they were last indexed
 * @property {string|null} lastSuccessAt - ISO timestamp of the last successful embedding request
 */

function day(iso) {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "an unknown date";
}

/**
 * Error text returned by semantic tools while the index is disabled.
 * @param {SemanticHealth} health
 * @returns {string}
 */
export function formatDisabledMessage(health) {
  return `Semantic search disabled since ${day(health.since)}: ${health.reason}`;
}

/**
 * One-line health summary for logs, the session-start summary and doctor.
 * @param {SemanticHealth} health
 * @returns {string}
 */
export function describeHealth(health) {
  const n = health.staleFiles;
  const stale = n > 0 ? `, ${n} note${n === 1 ? "" : "s"} stale` : "";
  if (health.status === "disabled") {
    return `disabled since ${day(health.since)} (${health.reason})${stale}`;
  }
  return `${health.status}${stale}`;
}

/**
 * Footer appended to semantic search output when some notes are not yet re-indexed.
 * @param {number} staleFiles
 * @returns {string}
 */
export function formatStaleFooter(staleFiles) {
  if (!(staleFiles > 0)) return "";
  const subject = staleFiles === 1 ? "1 note has" : `${staleFiles} notes have`;
  return `\n\n*${subject} changed since last indexed; results may be stale.*`;
}

/**
 * Convert the semantic-stats.json payload into a SemanticHealth.
 * @param {Object|null} stats - parsed semantic-stats.json
 * @returns {SemanticHealth|null} null when the file predates health reporting (no `status`)
 */
export function healthFromStats(stats) {
  if (!stats || typeof stats.status !== "string") return null;
  return {
    status: stats.status,
    reason: stats.reason ?? null,
    since: stats.since ?? null,
    staleFiles: Number(stats.stale_files) || 0,
    lastSuccessAt: stats.last_success_at ?? null,
  };
}
