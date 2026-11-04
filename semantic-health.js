// Dependency-free: imported by hooks/session-start.js, which runs without node_modules.

/**
 * @typedef {Object} SemanticHealth
 * @property {"ok"|"syncing"|"disabled"} status
 * @property {string|null} reason - why the index is disabled (null unless disabled)
 * @property {string|null} since - ISO timestamp when the index was disabled
 * @property {number} staleFiles - notes changed or missing since they were last indexed
 * @property {string|null} lastSuccessAt - ISO timestamp of the last successful embedding request
 * @property {number|null} [notesTotal] - notes with a non-empty body; null when not reported yet
 * @property {number|null} [notesEmbedded] - notes whose chunks all have stored vectors; null when not reported yet
 * @property {number} [chunksWaiting] - chunks waiting for another machine's vectors before being embedded here
 * @property {string|null} [oldestWaitSince] - ISO time the longest-waiting chunk was first seen
 * @property {boolean|null} [sharedCache] - whether this machine reads and writes embedding packs
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
 * The coverage line shown in search results and doctor.
 * @param {SemanticHealth} health
 * @returns {string|null} null when coverage is complete and embedding is enabled, or when counts are not reported yet
 */
export function formatCoverageLine(health) {
  const { notesTotal, notesEmbedded } = health;
  if (typeof notesTotal !== "number" || typeof notesEmbedded !== "number") return null;
  const waiting = health.chunksWaiting > 0 ? health.chunksWaiting : 0;
  if (notesEmbedded >= notesTotal && waiting === 0 && health.status !== "disabled") return null;
  const line = `Semantic index: ${notesEmbedded} of ${notesTotal} notes embedded`;
  return waiting > 0 ? `${line}; ${waiting} chunks waiting` : line;
}

/**
 * @param {SemanticHealth} health
 * @returns {string} the coverage line after a blank line, or "" when there is none
 */
export function formatCoverageFooter(health) {
  const line = formatCoverageLine(health);
  return line ? `\n\n${line}` : "";
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
    notesTotal: Number.isFinite(stats.notes_total) ? stats.notes_total : null,
    notesEmbedded: Number.isFinite(stats.notes_embedded) ? stats.notes_embedded : null,
    chunksWaiting: Number(stats.chunks_waiting) || 0,
    oldestWaitSince: stats.oldest_wait_since ?? null,
    sharedCache: typeof stats.shared_cache === "boolean" ? stats.shared_cache : null,
  };
}
