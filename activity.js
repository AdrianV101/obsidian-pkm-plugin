import Database from "better-sqlite3";
import fs from "fs/promises";
import path from "path";

const MAX_ARG_CHARS = 200;
// Top-level arguments whose value is a vault path. The same names inside free-text containers
// (frontmatter, fields, custom_fields, variables) are user content and are summarised.
const PATH_KEYS = new Set(["path", "source", "destination", "folder", "target", "old_path", "new_path"]);
const DEFAULT_RETENTION_DAYS = 90;
const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const MIN_DATE_MS = -8.64e15;

function summarizeValue(value, isPath = false) {
  if (typeof value === "string") {
    return value.length > MAX_ARG_CHARS && !isPath ? `<${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(item => summarizeValue(item));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarizeValue(v);
    return out;
  }
  return value;
}

/** A vault_add_links entry: its `target` is a vault path, the rest is free text. */
function summarizeLink(link) {
  if (link === null || typeof link !== "object" || Array.isArray(link)) return summarizeValue(link);
  const out = {};
  for (const [k, v] of Object.entries(link)) out[k] = summarizeValue(v, k === "target");
  return out;
}

/**
 * Shrink tool arguments before they are stored: any string longer than 200 chars becomes
 * "<N chars>", at any nesting depth, except vault paths: the top-level path arguments
 * (`path`, `source`, `destination`, `folder`, `target`, `old_path`, `new_path`) and
 * `links[].target`. Returns a new value; the input (which the handler still uses) is never mutated.
 * @param {unknown} args
 * @returns {unknown}
 */
export function summarizeArgs(args) {
  if (args === null || args === undefined) return {};
  if (typeof args !== "object" || Array.isArray(args)) return summarizeValue(args);
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = key === "links" && Array.isArray(value)
      ? value.map(summarizeLink)
      : summarizeValue(value, PATH_KEYS.has(key));
  }
  return out;
}

function parseArgsJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The vault path an activity row is about: `path`, else `old_path` (vault_move), else `folder`. */
function activityPath(args) {
  for (const key of ["path", "old_path", "folder"]) {
    const value = args?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function normalizeRetentionDays(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return DEFAULT_RETENTION_DAYS;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_DAYS;
}

/**
 * Build the SELECT for ActivityLog.query.
 * @param {Object} [opts] - same options as ActivityLog.query
 * @returns {{ sql: string, params: Array<string|number> }}
 */
export function buildActivityQuery({ limit = 50, tool, session, since, before, path: pathFilter } = {}) {
  let sql = "SELECT * FROM activity WHERE 1=1";
  const params = [];

  if (tool) {
    sql += " AND tool_name = ?";
    params.push(tool);
  }
  if (session) {
    sql += " AND session_id LIKE ? ESCAPE '\\'";
    const escaped = session.replace(/[%_\\]/g, "\\$&");
    params.push(escaped + "%");
  }
  if (since) {
    sql += " AND timestamp >= ?";
    params.push(since);
  }
  if (before) {
    sql += " AND timestamp <= ?";
    params.push(before);
  }
  const folder = pathFilter ? pathFilter.replace(/\/+$/, "") : "";
  if (folder) {
    // Range instead of LIKE: LIKE cannot use the BINARY index and would need %/_ escaping.
    // Every string starting with "<folder>/" sorts within ["<folder>/", "<folder>0") since "0" follows "/".
    sql += " AND (path = ? OR (path >= ? AND path < ?))";
    params.push(folder, folder + "/", folder + "0");
  }

  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);
  return { sql, params };
}

/**
 * Persistent activity log backed by SQLite.
 * Records every MCP tool call with timestamps and session IDs,
 * enabling cross-session memory for Claude conversations.
 */
export class ActivityLog {
  /**
   * @param {Object} opts
   * @param {string} opts.vaultPath - absolute path to vault root
   * @param {string} opts.sessionId - UUID for the current session
   * @param {number|string} [opts.retentionDays] - days of history kept at startup; 0 keeps everything.
   *   Defaults to VAULT_PKM_ACTIVITY_RETENTION_DAYS, else 90. Invalid values fall back to 90.
   */
  constructor({ vaultPath, sessionId, retentionDays = process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS }) {
    this.vaultPath = vaultPath;
    this.sessionId = sessionId;
    this.retentionDays = normalizeRetentionDays(retentionDays);
    this.dbPath = path.join(vaultPath, ".obsidian", "activity-log.db");
    this.db = null;
  }

  /** Open (or create) the database, migrate it, apply retention and reclaim free pages. */
  async initialize() {
    const dbDir = path.dirname(this.dbPath);
    await fs.mkdir(dbDir, { recursive: true });

    this.db = new Database(this.dbPath);
    try {
      // Must precede journal_mode: it only takes effect on a brand-new file before its header is written.
      // Existing files switch at the one-time VACUUM in #reclaimSpace.
      this.db.pragma("auto_vacuum = INCREMENTAL");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("journal_size_limit = 32000000");
      // Deleted content is overwritten with zeros, so what the migration, retention or clear()
      // drops does not linger in the file even if the one-time VACUUM below fails.
      this.db.pragma("secure_delete = ON");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_activity_session ON activity(session_id);
        CREATE INDEX IF NOT EXISTS idx_activity_tool ON activity(tool_name);
        CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
      `);
      this.#migrate();
      this.#applyRetention();
      this.#reclaimSpace();
    } catch (e) {
      this.db.close();
      this.db = null;
      throw e;
    }
  }

  #migrate() {
    const db = this.db;
    // IMMEDIATE takes the write lock before reading user_version, so two servers starting
    // on the same vault cannot both run the migration.
    db.transaction(() => {
      if (db.pragma("user_version", { simple: true }) >= SCHEMA_VERSION) return;

      const columns = db.prepare("PRAGMA table_info(activity)").all().map(c => c.name);
      if (!columns.includes("path")) db.exec("ALTER TABLE activity ADD COLUMN path TEXT");
      db.exec(`
        UPDATE activity SET path = CASE
          WHEN json_type(args_json, '$.path') = 'text' AND json_extract(args_json, '$.path') <> ''
            THEN json_extract(args_json, '$.path')
          WHEN json_type(args_json, '$.old_path') = 'text' AND json_extract(args_json, '$.old_path') <> ''
            THEN json_extract(args_json, '$.old_path')
          WHEN json_type(args_json, '$.folder') = 'text' AND json_extract(args_json, '$.folder') <> ''
            THEN json_extract(args_json, '$.folder')
        END
        WHERE json_valid(args_json);
        CREATE INDEX IF NOT EXISTS idx_activity_path ON activity(path);
      `);

      // Drops note bodies (e.g. content of since-trashed notes) that older versions logged verbatim.
      // Batched by id: better-sqlite3 cannot run the UPDATE while a SELECT iterator is open,
      // and .all() over the whole table could be hundreds of MB on an old log.
      const page = db.prepare("SELECT id, args_json FROM activity WHERE id > ? ORDER BY id LIMIT 500");
      const update = db.prepare("UPDATE activity SET args_json = ? WHERE id = ?");
      let lastId = 0;
      for (let rows = page.all(lastId); rows.length > 0; rows = page.all(lastId)) {
        for (const row of rows) {
          const summarized = JSON.stringify(summarizeArgs(parseArgsJson(row.args_json)));
          if (summarized !== row.args_json) update.run(summarized, row.id);
          lastId = row.id;
        }
      }

      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  }

  #applyRetention() {
    if (this.retentionDays === 0) return;
    const cutoffMs = Date.now() - this.retentionDays * DAY_MS;
    // A window reaching back before the earliest representable date keeps everything.
    if (!(cutoffMs >= MIN_DATE_MS)) return;
    this.db.prepare("DELETE FROM activity WHERE timestamp < ?").run(new Date(cutoffMs).toISOString());
  }

  #reclaimSpace() {
    if (this.db.pragma("auto_vacuum", { simple: true }) === 2) {
      this.db.pragma("incremental_vacuum");
    } else {
      // One-time rebuild that applies auto_vacuum = INCREMENTAL to a database created before it was set.
      // VACUUM is atomic (it builds a copy and swaps it in), so a failure (e.g. a peer process
      // holding the file, or a full disk) leaves the database valid and only skips the space
      // reclamation; the next start retries. It must not disable the activity log.
      try {
        this.db.exec("VACUUM");
      } catch (e) {
        console.error(`[activity] VACUUM skipped: ${e.message}`);
      }
      // Until a checkpoint, the database file still holds the pre-migration pages (note bodies).
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    }
  }

  /**
   * Record a tool invocation. Arguments are summarized before storage.
   * @param {string} toolName - MCP tool name
   * @param {Object} [args] - tool arguments (not modified)
   */
  log(toolName, args) {
    if (!this.db) return;

    this.db.prepare(
      "INSERT INTO activity (timestamp, session_id, tool_name, args_json, path) VALUES (?, ?, ?, ?, ?)"
    ).run(
      new Date().toISOString(),
      this.sessionId,
      toolName,
      JSON.stringify(summarizeArgs(args)),
      activityPath(args)
    );
  }

  /**
   * Query activity entries with optional filters. args_json is always returned summarized,
   * including rows written by older versions that stored full arguments.
   * @param {Object} [opts]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.tool] - filter by tool name
   * @param {string} [opts.session] - filter by session ID prefix
   * @param {string} [opts.since] - ISO timestamp lower bound
   * @param {string} [opts.before] - ISO timestamp upper bound
   * @param {string} [opts.path] - exact note path, or a folder (matches everything beneath it)
   * @returns {Object[]} matching activity rows
   */
  query(opts = {}) {
    if (!this.db) return [];
    const { sql, params } = buildActivityQuery(opts);
    return this.db.prepare(sql).all(...params).map(row => ({
      ...row,
      args_json: JSON.stringify(summarizeArgs(parseArgsJson(row.args_json))),
    }));
  }

  /**
   * Delete activity entries, optionally filtered.
   * @param {Object} [opts]
   * @param {string} [opts.session] - delete only this session
   * @param {string} [opts.tool] - delete only this tool
   * @param {string} [opts.before] - delete entries before this timestamp
   * @returns {number} number of deleted rows
   */
  clear({ session, tool, before } = {}) {
    if (!this.db) return 0;

    let sql = "DELETE FROM activity WHERE 1=1";
    const params = [];

    if (session) {
      sql += " AND session_id LIKE ? ESCAPE '\\'";
      const escaped = session.replace(/[%_\\]/g, "\\$&");
      params.push(escaped + "%");
    }
    if (tool) {
      sql += " AND tool_name = ?";
      params.push(tool);
    }
    if (before) {
      sql += " AND timestamp < ?";
      params.push(before);
    }

    const result = this.db.prepare(sql).run(...params);
    return result.changes;
  }

  /** Close the database connection. */
  shutdown() {
    if (this.db) {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.close();
      this.db = null;
    }
  }
}
