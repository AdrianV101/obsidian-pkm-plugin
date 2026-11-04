import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { cacheDir } from "./local-paths.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const SCHEMA_VERSION = 1;

/**
 * @typedef {Object} LocalIndex
 * @property {import("better-sqlite3").Database} db
 * @property {{ schemaVersion: number, model: string, dims: number }} meta
 * @property {string} dbPath
 * @property {() => void} close
 */

function readMeta(db) {
  const rows = db.prepare("SELECT key, value FROM meta").all();
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (!("schemaVersion" in m) || !("model" in m) || !("dims" in m)) return null;
  return { schemaVersion: Number(m.schemaVersion), model: m.model, dims: Number(m.dims) };
}

/**
 * Open (creating if needed) the per-machine local index. The database is a regenerable cache:
 * when the recorded model, dimensions or schema version differ from the requested ones, the
 * embedding tables are dropped and rebuilt empty; other tables are left alone.
 * `dbPath`, `env` and the meta overrides exist so tests can stay out of the real cache folder.
 * @param {Object} opts
 * @param {string} opts.vaultPath
 * @param {string} [opts.dbPath]
 * @param {Object} [opts.env] - see cacheDir
 * @param {string} [opts.model]
 * @param {number} [opts.dims]
 * @param {number} [opts.schemaVersion]
 * @returns {LocalIndex}
 */
export function openLocalIndex({
  vaultPath, dbPath, env,
  model = EMBEDDING_MODEL, dims = EMBEDDING_DIMENSIONS, schemaVersion = SCHEMA_VERSION,
}) {
  const file = dbPath || path.join(cacheDir(vaultPath, env), "index.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  try {
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    db.pragma("journal_size_limit = 32000000");

    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const wanted = { schemaVersion, model, dims };
    const stored = readMeta(db);
    if (!stored || stored.schemaVersion !== schemaVersion || stored.model !== model || stored.dims !== dims) {
      db.transaction(() => {
        db.exec("DROP TABLE IF EXISTS vec_chunks; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files;");
        const put = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(wanted)) put.run(k, String(v));
      })();
    }

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[${dims}]
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        content_preview TEXT NOT NULL,
        chunk_hash TEXT NOT NULL,
        UNIQUE(file_path, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    `);

    return {
      db,
      meta: wanted,
      dbPath: file,
      close() {
        if (!db.open) return;
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.close();
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
