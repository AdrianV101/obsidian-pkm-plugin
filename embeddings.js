import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { getAllMarkdownFiles } from "./utils.js";
import { splitFrontmatter } from "./markdown.js";
import { formatDisabledMessage, formatStaleFooter } from "./semantic-health.js";
import { toVaultRel } from "./vault-fs.js";

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 3072;
const MAX_CHARS_PER_CHUNK = 8000; // ~2000 tokens
// OpenAI embeddings API: max 2048 inputs, max 300k tokens summed, 8192 tokens per input.
// At MAX_CHARS_PER_CHUNK=8000 (~2000 tokens), 128 chunks ≈ 256k tokens — safely under the
// 300k cap even when every chunk is at the max size. 256 would exceed the cap on full-size
// chunks; smaller values waste round-trips. Note: BATCH_SIZE only fires when a single file
// produces >this many chunks, which is rare with the current per-file embedding flow.
const BATCH_SIZE = 128;
const REINDEX_BATCH_SIZE = 10; // files per batch during startup sync
const DEBOUNCE_MS = 2000;
const WATCHER_RESTART_BASE_MS = 1000;
const MAX_WATCHER_RESTARTS = 5;
// sqlite-vec rejects KNN queries with k above this.
const MAX_KNN_K = 4096;
// A too_large input shorter than this is not split further.
const MIN_SPLIT_CHARS = 200;
const MAX_ATTEMPTS = 3;
// A rate-limit reset further away than this is not waited for: the call fails and the
// note stays stale until the next sync or write notification.
const MAX_RETRY_WAIT_MS = 30000;
const RETRYABLE_KINDS = new Set(["rate_limit", "transient"]);
const DISABLING_KINDS = new Set(["auth", "quota"]);
const TOO_LARGE_RE = /maximum context length|context_length_exceeded|max_tokens_per_request|\bmax(?:imum)?\s+\d+\s+tokens\b|too many tokens/i;

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** An OpenAI embeddings failure, classified so callers can decide to retry, disable or split. */
export class EmbeddingError extends Error {
  /**
   * @param {string} message
   * @param {Object} opts
   * @param {"auth"|"quota"|"rate_limit"|"transient"|"too_large"|"other"} opts.kind
   * @param {number|null} [opts.retryAfterMs]
   * @param {number|null} [opts.status] - HTTP status, null for network failures
   * @param {unknown} [opts.cause]
   */
  constructor(message, { kind, retryAfterMs = null, status = null, cause }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EmbeddingError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

function parseDurationMs(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(s)) return null;
  const unitMs = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total = 0;
  for (const [, num, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(num) * unitMs[unit];
  }
  return Math.round(total);
}

function parseRetryAfterMs(headers, now) {
  const get = (name) => headers?.get?.(name) ?? null;
  const retryAfter = get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const s = retryAfter.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const resets = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map(name => parseDurationMs(get(name)))
    .filter(ms => ms !== null);
  return resets.length > 0 ? Math.max(...resets) : null;
}

/**
 * Classify a failed embeddings request.
 * @param {number|null} status - HTTP status; null for a network failure or timeout
 * @param {string|null} bodyText - response body (or the network error message)
 * @param {{ get(name: string): string|null }|null|undefined} headers - response headers
 * @param {number} [now] - clock for HTTP-date Retry-After values
 * @returns {{ kind: "auth"|"quota"|"rate_limit"|"transient"|"too_large"|"other", retryAfterMs: number|null }}
 */
export function classifyEmbeddingError(status, bodyText, headers, now = Date.now()) {
  const body = bodyText ?? "";
  if (status === 401 || status === 403) return { kind: "auth", retryAfterMs: null };
  if (status === 429) {
    if (/insufficient_quota/.test(body)) return { kind: "quota", retryAfterMs: null };
    return { kind: "rate_limit", retryAfterMs: parseRetryAfterMs(headers, now) };
  }
  if (status === null || status === undefined || status >= 500) {
    return { kind: "transient", retryAfterMs: parseRetryAfterMs(headers, now) };
  }
  if (status === 400 && TOO_LARGE_RE.test(body)) return { kind: "too_large", retryAfterMs: null };
  return { kind: "other", retryAfterMs: null };
}

function disabledReason(err) {
  if (err.kind === "quota") return "OpenAI quota exhausted. Add credits; it re-enables automatically.";
  return `OpenAI rejected the API key (HTTP ${err.status}). Check VAULT_PKM_OPENAI_KEY; it re-enables automatically once a request succeeds.`;
}

/**
 * Semantic similarity search over vault notes using OpenAI embeddings.
 * Stores embeddings in SQLite + sqlite-vec for fast KNN lookups.
 * Automatically indexes on startup and watches for file changes.
 */
export class SemanticIndex {
  /**
   * @param {Object} opts
   * @param {string} opts.vaultPath - absolute path to vault root
   * @param {string} opts.openaiApiKey - OpenAI API key for embeddings
   * @param {string} [opts.dbPath] - override path for the SQLite database
   * @param {string} [opts.statsPath] - override path for semantic-stats.json
   * @param {(ms: number) => Promise<void>} [opts.sleep] - delay used between retries and watcher restarts
   * @param {typeof fsSync.watch} [opts.watch] - file watcher factory
   * @param {number} [opts.debounceMs] - delay before a changed path is reindexed
   * @param {number} [opts.maxKnnK] - largest k sent to a sqlite-vec KNN query
   */
  constructor({
    vaultPath, openaiApiKey, dbPath, statsPath, sleep = defaultSleep,
    watch = fsSync.watch, debounceMs = DEBOUNCE_MS, maxKnnK = MAX_KNN_K,
  }) {
    this.vaultPath = vaultPath;
    this.openaiApiKey = openaiApiKey;
    this.dbPath = dbPath || path.join(vaultPath, ".obsidian", "semantic-index.db");
    this.statsPath = statsPath || path.join(vaultPath, ".obsidian", "semantic-stats.json");
    this.db = null;
    this.watcher = null;
    this._sleep = sleep;
    this._watch = watch;
    this._debounceMs = debounceMs;
    this._maxKnnK = maxKnnK;
    this._debounced = new Map(); // rel -> { timer, done, resolve }
    this._pendingEvents = new Set(); // paths changed while a sync was running
    this._pathLocks = new Map(); // rel -> tail promise of that path's reindex queue
    this._watcherRestarts = 0;
    this._lifecycle = 0; // bumped by initialize() and shutdown(); stale restart timers compare it
    this._initPromise = null;
    this._syncState = { syncing: false, total: 0, done: 0 };
    this._syncPromise = null;
    this._inflight = new Set();
    this._abortController = null;
    this._lastKnownVaultFiles = 0;
    this._disabled = null; // { reason, since } while auth/quota failures block embedding
    this._lastSuccessAt = null;
    this._stale = new Set();
    this._probePromise = null;
    this._closing = false;
    this._pauseSync = false; // a long rate limit stops the current sync; files stay stale
    this._scanned = false;
    this._staleCarry = 0; // persisted stale count, reported until the first scan completes
  }

  get isAvailable() {
    return this.db !== null && !!this.openaiApiKey && this._disabled === null;
  }

  /** @returns {import("./semantic-health.js").SemanticHealth} */
  health() {
    /** @type {"ok"|"syncing"|"disabled"} */
    let status = "ok";
    if (this._disabled) status = "disabled";
    else if (this._syncState.syncing) status = "syncing";
    return {
      status,
      reason: this._disabled?.reason ?? null,
      since: this._disabled?.since ?? null,
      staleFiles: this._scanned ? this._stale.size : this._staleCarry,
      lastSuccessAt: this._lastSuccessAt,
    };
  }

  initialize() {
    this._initPromise = this._initialize();
    return this._initPromise;
  }

  async _initialize() {
    // A shut-down instance may be initialised again: start from a clean lifecycle.
    this._closing = false;
    this._lifecycle++;
    this._syncState = { syncing: false, total: 0, done: 0 };
    this._syncPromise = null;
    this._scanned = false;
    this._pauseSync = false;
    this._stale = new Set();
    this._watcherRestarts = 0;

    // Ensure .obsidian dir exists
    const dbDir = path.dirname(this.dbPath);
    await fs.mkdir(dbDir, { recursive: true });
    // shutdown() may have run while the directory was being created: open nothing.
    if (this._closing) return;

    // Open DB and load sqlite-vec
    this.db = new Database(this.dbPath);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("journal_size_limit = 32000000");

    // Create schema
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        embedding float[${EMBEDDING_DIMENSIONS}]
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        content_preview TEXT NOT NULL,
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

    // A disabled state outlives restarts so "disabled since" stays truthful.
    const persisted = this._readPersistedStats();
    if (persisted?.status === "disabled" && persisted.reason && persisted.since) {
      this._disabled = { reason: persisted.reason, since: persisted.since };
    }
    this._staleCarry = Number(persisted?.stale_files) || 0;
    this._lastKnownVaultFiles = Number(persisted?.vault_files) || 0;
    this._lastSuccessAt = persisted?.last_success_at
      ?? this.db.prepare("SELECT MAX(updated_at) AS t FROM files").get().t
      ?? null;

    this._writeStats();

    // Start background sync (non-blocking)
    this._abortController = new AbortController();
    this._startSync();

    // Start file watcher
    this._startWatcher();
  }

  async shutdown() {
    this._closing = true;
    this._lifecycle++;
    if (this._initPromise) await this._initPromise.catch(() => {});
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const entry of this._debounced.values()) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    this._debounced.clear();
    this._pendingEvents.clear();
    if (this._syncPromise) await this._syncPromise;
    if (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
    if (this.db) {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.close();
      this.db = null;
    }
  }

  /** Resolves with the latest sync's summary ({ updated, failed, skipped }) once it finishes. */
  whenSynced() {
    return this._syncPromise ?? Promise.resolve(null);
  }

  /** Resolves once debounced events, in-flight reindexes, probes and any running sync have drained. */
  async whenIdle() {
    for (;;) {
      const pending = [...this._inflight, ...[...this._debounced.values()].map(e => e.done)];
      if (this._syncState.syncing && this._syncPromise) pending.push(this._syncPromise);
      if (this._probePromise) pending.push(this._probePromise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * A write tool changed (or created) this note or folder; reindex it after the debounce.
   * @param {string} relativePath - vault-relative path
   */
  notifyChanged(relativePath) {
    if (!this.db || this._closing) return;
    this._enqueue(toVaultRel(relativePath));
  }

  /**
   * A write tool removed this note; drop its rows (no API call).
   * @param {string} relativePath - vault-relative path
   * @returns {Promise<void>}
   */
  async notifyRemoved(relativePath) {
    if (!this.db || this._closing) return;
    const rel = toVaultRel(relativePath);
    await this._runExclusive(rel, async () => this.removeFile(rel));
    this._writeStats();
  }

  /**
   * A write tool moved a note or folder; carry its rows over to the new path (no API call),
   * then verify the new path against disk.
   * @param {string} oldRelativePath
   * @param {string} newRelativePath
   */
  notifyMoved(oldRelativePath, newRelativePath) {
    if (!this.db || this._closing) return;
    const from = toVaultRel(oldRelativePath);
    const to = toVaultRel(newRelativePath);
    const moved = this.db.prepare("SELECT path FROM files WHERE path = ? OR substr(path, 1, ?) = ?")
      .all(from, from.length + 1, from + "/")
      .map(row => row.path);
    const txn = this.db.transaction(() => {
      for (const oldPath of moved) {
        const newPath = to + oldPath.slice(from.length);
        this._deleteChunks(newPath);
        this.db.prepare("DELETE FROM files WHERE path = ?").run(newPath);
        this.db.prepare("UPDATE chunks SET file_path = ? WHERE file_path = ?").run(newPath, oldPath);
        this.db.prepare("UPDATE files SET path = ? WHERE path = ?").run(newPath, oldPath);
      }
    });
    txn();
    for (const oldPath of moved) {
      if (this._stale.delete(oldPath)) this._stale.add(to + oldPath.slice(from.length));
    }
    this._enqueue(to);
  }

  /**
   * Send one embedding request. While disabled, success re-enables the index and
   * starts a sync; failure keeps it disabled. Concurrent callers share one request.
   * @returns {Promise<boolean>} whether the request succeeded
   */
  probe() {
    if (!this.db || !this.openaiApiKey) return Promise.resolve(false);
    if (!this._probePromise) {
      this._probePromise = this._runProbe().finally(() => { this._probePromise = null; });
    }
    return this._probePromise;
  }

  async _runProbe() {
    try {
      await getEmbeddings(["ping"], this.openaiApiKey, { maxAttempts: 1, sleep: this._sleep });
    } catch (err) {
      this._noteFailure(err);
      return false;
    }
    this._noteSuccess();
    if (this._disabled) {
      this._disabled = null;
      console.error("Semantic index: re-enabled after a successful probe");
      this._writeStats();
      if (!this._closing) this._startSync();
    }
    return true;
  }

  _noteSuccess() {
    this._lastSuccessAt = new Date().toISOString();
  }

  _noteFailure(err) {
    if (!(err instanceof EmbeddingError) || !DISABLING_KINDS.has(err.kind)) return;
    if (this._disabled) {
      // Keep the original date; the cause may have changed (quota, then an invalid key).
      const reason = disabledReason(err);
      if (reason !== this._disabled.reason) {
        this._disabled.reason = reason;
        this._writeStats();
      }
      return;
    }
    this._disabled = { reason: disabledReason(err), since: new Date().toISOString() };
    console.error(`Semantic index: ${formatDisabledMessage(this.health())}`);
    this._writeStats();
  }

  /** Track a reindexFile call so shutdown() can await it. */
  _trackedReindex(relativePath) {
    const p = this.reindexFile(relativePath).finally(() => {
      this._inflight.delete(p);
    });
    this._inflight.add(p);
    return p;
  }

  /**
   * Search for semantically similar notes and return formatted results.
   * @param {Object} opts
   * @param {string} opts.query - natural language search query
   * @param {number} [opts.limit=5] - max results
   * @param {string} [opts.folder] - restrict to folder prefix
   * @param {number} [opts.threshold] - minimum similarity score (0-1)
   * @param {(path: string) => string} [opts.formatPath] - transform path for display (e.g. obsidian:// link)
   * @returns {Promise<string>} formatted results text
   */
  async search({ query, limit = 5, folder, threshold, formatPath }) {
    const results = await this.searchRaw({ query, limit, folder, threshold });
    const fmt = formatPath || (p => p);

    // Format output
    let syncNote = "";
    if (this._syncState.syncing) {
      syncNote = `\n\n*Index syncing (${this._syncState.done}/${this._syncState.total} files)...*`;
    }
    const footer = syncNote + formatStaleFooter(this._stale.size);

    if (results.length === 0) {
      return `No semantically related notes found.${footer}`;
    }

    const formatted = results.map(r => {
      const heading = r.heading ? ` > ${r.heading}` : "";
      return `**${fmt(r.path)}**${heading} (score: ${r.score})\n${r.preview}`;
    }).join("\n\n");

    return `Found ${results.length} semantically related note${results.length === 1 ? "" : "s"}:\n\n${formatted}${footer}`;
  }

  /**
   * Search for semantically similar notes and return raw result objects.
   * @param {Object} opts
   * @param {string} opts.query - natural language search query
   * @param {number} [opts.limit=5] - max results
   * @param {string} [opts.folder] - restrict to folder prefix
   * @param {number} [opts.threshold] - minimum similarity score (0-1)
   * @param {Set<string>} [opts.excludeFiles] - file paths to exclude
   * @returns {Promise<Array<{path: string, heading: string|null, score: number, preview: string}>>}
   */
  async searchRaw({ query, limit = 5, folder, threshold, excludeFiles }) {
    if (!this.isAvailable) {
      if (this._disabled) throw new Error(formatDisabledMessage(this.health()));
      throw new Error("Semantic index not available");
    }

    let queryEmbedding;
    try {
      [queryEmbedding] = await getEmbeddings([query], this.openaiApiKey, { sleep: this._sleep });
    } catch (err) {
      this._noteFailure(err);
      if (this._disabled) throw new Error(formatDisabledMessage(this.health()), { cause: err });
      throw err;
    }
    this._noteSuccess();

    const queryVec = new Float32Array(queryEmbedding);
    const prefix = folder ? (folder.endsWith("/") ? folder : folder + "/") : null;
    if (!prefix) {
      return this._collectResults(this._knn(queryVec, Math.min(limit * 3, 50)), { limit, threshold, excludeFiles });
    }

    // Folder-scoped: the folder's chunks may rank far down the global KNN list, so widen k
    // until enough of them pass the filter or k covers every chunk.
    const folderFiles = this.db.prepare("SELECT COUNT(*) AS n FROM files WHERE substr(path, 1, ?) = ?").get(prefix.length, prefix).n;
    if (folderFiles < limit) {
      // The folder cannot fill the limit, so no amount of widening would end the search early:
      // score its chunks directly.
      return this._collectResults(this._folderScan(queryVec, prefix), { limit, threshold, excludeFiles, prefix });
    }
    const totalChunks = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n;
    let k = Math.max(limit * 5, 50);
    for (;;) {
      const capped = Math.min(k, this._maxKnnK);
      const results = this._collectResults(this._knn(queryVec, capped), { limit, threshold, excludeFiles, prefix });
      if (results.length >= limit || capped >= totalChunks) return results;
      if (capped === this._maxKnnK) {
        return this._collectResults(this._folderScan(queryVec, prefix), { limit, threshold, excludeFiles, prefix });
      }
      k *= 2;
    }
  }

  _knn(queryVec, k) {
    return this.db.prepare(`
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(queryVec, k);
  }

  /** Exact distances for every chunk under `prefix`, nearest first. */
  _folderScan(queryVec, prefix) {
    return this.db.prepare(`
      SELECT c.id AS rowid, vec_distance_l2(v.embedding, ?) AS distance
      FROM chunks c JOIN vec_chunks v ON v.rowid = c.id
      WHERE substr(c.file_path, 1, ?) = ?
      ORDER BY distance
    `).all(queryVec, prefix.length, prefix);
  }

  /**
   * @param {Array<{rowid: number|bigint, distance: number}>} vecResults - nearest first
   * @param {{ limit: number, threshold?: number, excludeFiles?: Set<string>, prefix?: string }} opts
   */
  _collectResults(vecResults, { limit, threshold, excludeFiles, prefix }) {
    const results = [];
    const getChunk = this.db.prepare(`
      SELECT file_path, chunk_index, heading, content_preview
      FROM chunks WHERE id = ?
    `);

    const seenFiles = new Set();
    for (const { rowid, distance } of vecResults) {
      if (results.length >= limit) break;

      const chunk = getChunk.get(rowid);
      if (!chunk) continue;

      if (prefix && !chunk.file_path.startsWith(prefix)) continue;

      // L2 distance for normalized embeddings ranges 0-2; convert to 0-1 similarity
      const score = Math.max(0, Math.min(1, 1 - distance / 2));
      if (threshold && score < threshold) continue;

      if (excludeFiles?.has(chunk.file_path)) continue;

      if (seenFiles.has(chunk.file_path)) continue;
      seenFiles.add(chunk.file_path);

      results.push({
        path: chunk.file_path,
        heading: chunk.heading,
        score: Math.round(score * 1000) / 1000,
        preview: chunk.content_preview
      });
    }

    return results;
  }

  /**
   * (Re-)index a single file: chunk it, embed it, store in SQLite.
   * Reindexes of the same path run one at a time.
   * Rejects when embedding fails; the file then counts as stale.
   * @param {string} relativePath - vault-relative file path
   */
  async reindexFile(relativePath) {
    if (!this.db) return;
    return this._runExclusive(relativePath, () => this._reindexNow(relativePath));
  }

  async _reindexNow(relativePath) {
    if (!this.db) return;

    const absPath = path.resolve(this.vaultPath, relativePath);
    let content;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") {
        this.removeFile(relativePath);
        return;
      }
      throw e;
    }

    const hash = contentHash(content);
    const stat = await fs.stat(absPath);
    const mtimeMs = Math.floor(stat.mtimeMs);

    // Unchanged content: at most the mtime moved (touch, sync client), so no API call.
    const existing = this.db.prepare("SELECT content_hash, mtime_ms FROM files WHERE path = ?").get(relativePath);
    if (existing && existing.content_hash === hash) {
      if (existing.mtime_ms !== mtimeMs) {
        this.db.prepare("UPDATE files SET mtime_ms = ? WHERE path = ?").run(mtimeMs, relativePath);
      }
      this._stale.delete(relativePath);
      return;
    }

    const chunks = chunkNote(content, relativePath);
    if (chunks.length === 0) {
      // Nothing to embed: record the file so it does not count as stale.
      this._storeFile(relativePath, mtimeMs, hash, [], []);
      return;
    }

    if (this._disabled) {
      this._stale.add(relativePath);
      throw new Error(formatDisabledMessage(this.health()));
    }

    let embeddings;
    try {
      embeddings = await getEmbeddings(chunks.map(c => c.text), this.openaiApiKey, { sleep: this._sleep });
    } catch (err) {
      this._stale.add(relativePath);
      this._noteFailure(err);
      if (err instanceof EmbeddingError && err.kind === "rate_limit" && (err.retryAfterMs ?? 0) > MAX_RETRY_WAIT_MS) {
        this._pauseSync = true;
      }
      throw err;
    }
    this._noteSuccess();

    this._storeFile(relativePath, mtimeMs, hash, chunks, embeddings);
  }

  _storeFile(relativePath, mtimeMs, hash, chunks, embeddings) {
    const absPath = path.resolve(this.vaultPath, relativePath);
    const txn = this.db.transaction(() => {
      // The note may have changed, or been indexed by another server process, while its
      // embeddings were in flight: only content that is still on disk gets stored.
      let currentHash;
      try {
        currentHash = contentHash(fsSync.readFileSync(absPath, "utf-8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        this._deleteChunks(relativePath);
        this.db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
        return "current";
      }
      if (currentHash !== hash) {
        const row = this.db.prepare("SELECT content_hash FROM files WHERE path = ?").get(relativePath);
        return row?.content_hash === currentHash ? "current" : "stale";
      }

      this._deleteChunks(relativePath);

      const insertChunk = this.db.prepare(`
        INSERT INTO chunks (file_path, chunk_index, heading, content_preview)
        VALUES (?, ?, ?, ?)
      `);
      const insertVec = this.db.prepare(`
        INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)
      `);
      for (let i = 0; i < chunks.length; i++) {
        const result = insertChunk.run(relativePath, i, chunks[i].heading || null, chunks[i].preview);
        insertVec.run(BigInt(result.lastInsertRowid), new Float32Array(embeddings[i]));
      }

      this.db.prepare(`
        INSERT OR REPLACE INTO files (path, mtime_ms, content_hash, chunk_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(relativePath, mtimeMs, hash, chunks.length, new Date().toISOString());
      return "current";
    });
    if (txn() === "stale") this._stale.add(relativePath);
    else this._stale.delete(relativePath);
  }

  _deleteChunks(relativePath) {
    const oldChunks = this.db.prepare("SELECT id FROM chunks WHERE file_path = ?").all(relativePath);
    if (oldChunks.length === 0) return;
    const deleteVec = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
    const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    for (const { id } of oldChunks) {
      deleteVec.run(BigInt(id));
      deleteChunk.run(id);
    }
  }

  /**
   * Remove all chunks and metadata for a file from the index.
   * @param {string} relativePath - vault-relative file path
   */
  removeFile(relativePath) {
    if (!this.db) return;

    const txn = this.db.transaction(() => {
      this._deleteChunks(relativePath);
      this.db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
    });

    txn();
    this._stale.delete(relativePath);
  }

  // --- Private methods ---

  _readPersistedStats() {
    try {
      return JSON.parse(fsSync.readFileSync(this.statsPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Write embedding stats and health to a JSON sidecar file for the session-start hook and doctor.
   * Fire-and-forget — errors are logged but never thrown.
   */
  _writeStats() {
    try {
      if (!this.db) return;
      const { indexed_files } = this.db.prepare("SELECT COUNT(*) as indexed_files FROM files").get();
      const { total_chunks } = this.db.prepare("SELECT COUNT(*) as total_chunks FROM chunks").get();
      const health = this.health();
      const stats = {
        indexed_files,
        total_chunks,
        vault_files: this._lastKnownVaultFiles,
        status: health.status,
        reason: health.reason,
        since: health.since,
        last_success_at: health.lastSuccessAt,
        stale_files: health.staleFiles,
        updated_at: new Date().toISOString(),
      };
      fsSync.mkdirSync(path.dirname(this.statsPath), { recursive: true });
      const tmp = this.statsPath + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify(stats));
      fsSync.renameSync(tmp, this.statsPath);
    } catch (e) {
      console.error(`Semantic index: failed to write stats: ${e.message}`);
    }
  }

  _startSync() {
    if (!this.db || this._closing) return Promise.resolve(null);
    if (!this._syncState.syncing) {
      this._syncPromise = this._startupSync().catch(err => {
        console.error(`Semantic index startup sync error: ${err.message}`);
        return null;
      });
    }
    return this._syncPromise;
  }

  /** Compare disk with the index: drop deleted notes, return notes whose mtime changed or that are unindexed. */
  async _scan() {
    const vaultFiles = await getAllMarkdownFiles(this.vaultPath);
    const indexedFiles = new Map();
    for (const row of this.db.prepare("SELECT path, mtime_ms, content_hash FROM files").all()) {
      indexedFiles.set(row.path, row);
    }
    this._lastKnownVaultFiles = vaultFiles.length;

    const toReindex = [];
    const vaultFileSet = new Set(vaultFiles);
    for (const relPath of vaultFiles) {
      try {
        const stat = await fs.stat(path.resolve(this.vaultPath, relPath));
        const indexed = indexedFiles.get(relPath);
        const mtimeMs = Math.floor(stat.mtimeMs);
        if (indexed && mtimeMs === indexed.mtime_ms) continue;
        if (indexed) {
          // Only the mtime moved (touch, sync client)? Then the stored vectors are still right.
          const content = await fs.readFile(path.resolve(this.vaultPath, relPath), "utf-8");
          if (contentHash(content) === indexed.content_hash) {
            this.db.prepare("UPDATE files SET mtime_ms = ? WHERE path = ?").run(mtimeMs, relPath);
            continue;
          }
        }
        toReindex.push(relPath);
      } catch {
        // File disappeared between listing and stat or read
      }
    }
    for (const indexedPath of indexedFiles.keys()) {
      if (!vaultFileSet.has(indexedPath)) this.removeFile(indexedPath);
    }
    this._stale = new Set(toReindex);
    this._scanned = true;
    return toReindex;
  }

  async _startupSync() {
    this._syncState.syncing = true;
    this._pauseSync = false;
    const summary = { updated: 0, failed: 0, skipped: 0 };

    try {
      const toReindex = await this._scan();
      if (toReindex.length === 0) {
        console.error("Semantic index: up to date");
        return summary;
      }

      if (this._disabled && !(await this.probe())) {
        summary.skipped = toReindex.length;
        console.error(`Semantic index: ${formatDisabledMessage(this.health())} (${toReindex.length} notes stale)`);
        return summary;
      }

      this._syncState.total = toReindex.length;
      this._syncState.done = 0;
      console.error(`Semantic index: syncing ${toReindex.length} files...`);

      for (let i = 0; i < toReindex.length; i += REINDEX_BATCH_SIZE) {
        if (this._closing || this._abortController?.signal.aborted) {
          console.error("Semantic index: startup sync aborted");
          break;
        }
        if (this._disabled) break;
        if (this._pauseSync) {
          console.error("Semantic index: sync paused, OpenAI rate limit resets too far ahead; notes stay stale until the next sync");
          break;
        }
        const batch = toReindex.slice(i, i + REINDEX_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(f => this._trackedReindex(f)));
        for (const r of results) {
          if (r.status === "fulfilled") summary.updated++;
          else summary.failed++;
        }
        this._syncState.done += batch.length;
        console.error(`Semantic index: syncing ${this._syncState.done}/${this._syncState.total} files...`);
      }

      summary.skipped = toReindex.length - summary.updated - summary.failed;
      const counts = `${summary.updated} updated, ${summary.failed} failed`
        + (summary.skipped > 0 ? `, ${summary.skipped} not attempted` : "");
      console.error(this._disabled
        ? `Semantic index: sync stopped: ${formatDisabledMessage(this.health())} (${counts})`
        : `Semantic index: sync complete (${counts})`);
      return summary;
    } finally {
      this._syncState.syncing = false;
      this._writeStats();
      for (const rel of this._pendingEvents) this._schedule(rel);
      this._pendingEvents.clear();
    }
  }

  /** @returns {Error|null} the error when the watcher could not be started */
  _startWatcher() {
    try {
      this.watcher = this._watch(this.vaultPath, { recursive: true }, (_eventType, filename) => this._onWatchEvent(filename));
      this.watcher.on("error", (err) => this._onWatcherError(err));
      return null;
    } catch (err) {
      console.error(`Could not start file watcher: ${err.message}`);
      return err;
    }
  }

  _onWatchEvent(filename) {
    if (!filename) return;
    const rel = toVaultRel(String(filename));
    // Dot paths include the index's own DB files under .obsidian/.
    if (!rel || rel.split("/").some(p => p.startsWith("."))) return;
    this._enqueue(rel);
  }

  _onWatcherError(err) {
    console.error(`File watcher error: ${err.message}`);
    try {
      this.watcher?.close();
    } catch {
      // already closed
    }
    this.watcher = null;
    if (this._closing) return;
    if (this._watcherRestarts >= MAX_WATCHER_RESTARTS) {
      console.error(`File watcher: giving up after ${MAX_WATCHER_RESTARTS} restarts; write notifications and the startup sync still update the index`);
      return;
    }
    this._watcherRestarts++;
    const delay = WATCHER_RESTART_BASE_MS * 2 ** (this._watcherRestarts - 1);
    console.error(`File watcher: restarting in ${delay}ms (restart ${this._watcherRestarts}/${MAX_WATCHER_RESTARTS})`);
    const lifecycle = this._lifecycle;
    this._sleep(delay).then(() => {
      if (this._closing || !this.db || lifecycle !== this._lifecycle) return;
      const failure = this._startWatcher();
      if (failure) {
        this._onWatcherError(failure);
        return;
      }
      // Catch up on changes made while no watcher was running.
      this._startSync();
    });
  }

  /** Queue a changed path; while a sync runs, hold it (deduplicated) until the sync ends. */
  _enqueue(rel) {
    if (this._syncState.syncing) {
      this._pendingEvents.add(rel);
      return;
    }
    this._schedule(rel);
  }

  _schedule(rel) {
    let entry = this._debounced.get(rel);
    if (entry) {
      clearTimeout(entry.timer);
    } else {
      let resolve;
      const done = new Promise(r => { resolve = r; });
      entry = { timer: null, done, resolve };
      this._debounced.set(rel, entry);
    }
    entry.timer = setTimeout(() => {
      this._debounced.delete(rel);
      const work = this._processEvent(rel);
      this._inflight.add(work);
      work.finally(() => {
        this._inflight.delete(work);
        entry.resolve();
      });
    }, this._debounceMs);
  }

  async _processEvent(rel) {
    try {
      if (rel.endsWith(".md")) await this.reindexFile(rel);
      else await this._reconcileSubtree(rel);
    } catch (e) {
      if (!this._disabled) console.error(`Semantic index: update failed for ${rel}: ${e.message}`);
    } finally {
      this._writeStats();
    }
  }

  /**
   * A non-.md path changed (folder created, renamed or deleted): drop index rows under it
   * that are gone from disk and reindex notes under it that are new or have a new mtime.
   */
  async _reconcileSubtree(relDir) {
    if (!this.db) return;
    const absDir = path.join(this.vaultPath, relDir);
    let onDisk = [];
    try {
      if (!(await fs.stat(absDir)).isDirectory()) return;
      onDisk = (await getAllMarkdownFiles(absDir)).map(f => toVaultRel(path.join(relDir, f)));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    const prefix = relDir + "/";
    const indexed = new Map(
      this.db.prepare("SELECT path, mtime_ms FROM files WHERE substr(path, 1, ?) = ?")
        .all(prefix.length, prefix)
        .map(row => [row.path, row.mtime_ms])
    );
    const present = new Set(onDisk);
    for (const rel of indexed.keys()) {
      if (!present.has(rel)) await this._runExclusive(rel, async () => this.removeFile(rel));
    }

    const changed = [];
    for (const rel of onDisk) {
      try {
        const stat = await fs.stat(path.join(this.vaultPath, rel));
        if (indexed.get(rel) !== Math.floor(stat.mtimeMs)) changed.push(rel);
      } catch {
        // removed again since the listing
      }
    }
    for (let i = 0; i < changed.length; i += REINDEX_BATCH_SIZE) {
      if (this._closing || this._abortController?.signal.aborted || this._disabled || this._pauseSync) break;
      await Promise.allSettled(changed.slice(i, i + REINDEX_BATCH_SIZE).map(rel => this.reindexFile(rel)));
    }
  }

  /** Run `fn` after every earlier task queued for the same path has settled. */
  _runExclusive(rel, fn) {
    const previous = this._pathLocks.get(rel) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.catch(() => {});
    this._pathLocks.set(rel, tail);
    tail.then(() => {
      if (this._pathLocks.get(rel) === tail) this._pathLocks.delete(rel);
    });
    return run;
  }
}

// --- Module-level helpers ---

function chunkNote(content, filePath) {
  const body = splitFrontmatter(content).body.trim();

  if (!body) return [];

  // Derive title from file path
  const title = path.basename(filePath, ".md");

  // Short note: single chunk
  if (body.length <= MAX_CHARS_PER_CHUNK) {
    return [{
      text: `# ${title}\n\n${body}`,
      heading: null,
      preview: getPreview(body)
    }];
  }

  // Long note: split at ## headings
  const sections = splitByHeadings(body);
  const chunks = [];

  for (const section of sections) {
    const sectionText = section.text.trim();
    if (!sectionText) continue;

    if (sectionText.length <= MAX_CHARS_PER_CHUNK) {
      chunks.push({
        text: `# ${title}\n\n${sectionText}`,
        heading: section.heading,
        preview: getPreview(sectionText)
      });
    } else {
      // Further split at paragraph breaks
      const paragraphChunks = splitByParagraphs(sectionText, MAX_CHARS_PER_CHUNK);
      for (let i = 0; i < paragraphChunks.length; i++) {
        chunks.push({
          text: `# ${title}\n\n${paragraphChunks[i]}`,
          heading: section.heading ? `${section.heading} (${i + 1})` : null,
          preview: getPreview(paragraphChunks[i])
        });
      }
    }
  }

  return chunks;
}

function splitByHeadings(body) {
  const lines = body.split("\n");
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join("\n") });
      }
      currentHeading = line.replace(/^##\s+/, "");
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n") });
  }

  return sections;
}

function splitByParagraphs(text, maxChars) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    // If a single paragraph exceeds maxChars, hard-split it
    if (para.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }

    if (current && (current.length + para.length + 2) > maxChars) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function getPreview(text) {
  // Strip markdown heading markers for preview
  const cleaned = text.replace(/^#+\s+/gm, "").trim();
  const words = cleaned.split(/\s+/);
  const preview = words.slice(0, 100).join(" ");
  return preview.length < cleaned.length ? preview + "..." : preview;
}

async function getEmbeddings(texts, apiKey, opts = {}) {
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedAdaptive(batch, apiKey, opts);
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}

/**
 * callEmbeddingAPI, but a too_large failure splits the batch in half, and a single
 * oversize input into two halves whose embeddings are length-weighted and re-normalised.
 */
async function embedAdaptive(texts, apiKey, opts) {
  try {
    return await callEmbeddingAPI(texts, apiKey, opts);
  } catch (err) {
    if (!(err instanceof EmbeddingError) || err.kind !== "too_large") throw err;
    if (texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const first = await embedAdaptive(texts.slice(0, mid), apiKey, opts);
      const second = await embedAdaptive(texts.slice(mid), apiKey, opts);
      return [...first, ...second];
    }
    const text = texts[0];
    if (text.length < MIN_SPLIT_CHARS * 2) throw err;
    let mid = Math.floor(text.length / 2);
    // Never cut between the two halves of a surrogate pair.
    const before = text.charCodeAt(mid - 1);
    if (before >= 0xD800 && before <= 0xDBFF) mid--;
    const [first] = await embedAdaptive([text.slice(0, mid)], apiKey, opts);
    const [second] = await embedAdaptive([text.slice(mid)], apiKey, opts);
    return [combineEmbeddings([first, second], [mid, text.length - mid])];
  }
}

function combineEmbeddings(vectors, weights) {
  const out = new Array(vectors[0].length).fill(0);
  vectors.forEach((vec, v) => {
    for (let i = 0; i < out.length; i++) out[i] += vec[i] * weights[v];
  });
  const norm = Math.sqrt(out.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? out.map(x => x / norm) : out;
}

/**
 * POST one batch to the OpenAI embeddings API. Retries rate_limit and transient
 * failures (honouring Retry-After / x-ratelimit-reset-*), throws EmbeddingError otherwise.
 * @param {string[]} texts
 * @param {string} apiKey
 * @param {Object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<number[][]>} embeddings in input order
 */
async function callEmbeddingAPI(texts, apiKey, { maxAttempts = MAX_ATTEMPTS, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    let error;
    let response = null;
    try {
      response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: texts
        }),
        signal: AbortSignal.timeout(30000)
      });
    } catch (e) {
      const { kind, retryAfterMs } = classifyEmbeddingError(null, e.message, null);
      error = new EmbeddingError(`OpenAI API request failed: ${e.message}`, { kind, retryAfterMs, cause: e });
    }

    if (response?.ok) {
      const data = await response.json();
      // Sort by index to maintain order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    }

    if (response) {
      const errBody = await response.text();
      const { kind, retryAfterMs } = classifyEmbeddingError(response.status, errBody, response.headers);
      error = new EmbeddingError(`OpenAI API error (${response.status}): ${errBody.slice(0, 200)}`, {
        kind, retryAfterMs, status: response.status,
      });
    }

    if (!RETRYABLE_KINDS.has(error.kind) || attempt >= maxAttempts) throw error;
    const delay = error.retryAfterMs ?? 1000 * 2 ** (attempt - 1);
    if (delay > MAX_RETRY_WAIT_MS) throw error;
    console.error(`OpenAI ${error.kind} error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})...`);
    await sleep(delay);
  }
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export { chunkNote, splitByHeadings, splitByParagraphs, getPreview, contentHash, callEmbeddingAPI };

