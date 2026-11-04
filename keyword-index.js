import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAllMarkdownFiles, toVaultRel } from "./vault-fs.js";

const DEBOUNCE_MS = 300;
const READ_BATCH = 50;
const MAX_QUERY_TOKENS = 64;
const WATCHER_RETRY_MS = 5000;

/**
 * Turn free text into an FTS5 MATCH expression that cannot be a syntax error: each run of
 * letters or digits becomes a quoted term, OR-ed so BM25 ranks notes that match more of them first.
 * @param {string} query
 * @returns {string|null} null when the text has no searchable word
 */
export function toMatchExpression(query) {
  const words = String(query ?? "").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  const unique = [...new Set(words.map(w => w.normalize("NFC")))].slice(0, MAX_QUERY_TOKENS);
  return unique.length === 0 ? null : unique.map(w => `"${w}"`).join(" OR ");
}

/**
 * Word index over note text in the local index's FTS5 tables. Only the lease holder writes rows,
 * from a startup scan and a vault watcher; every process can search. It needs no API key.
 */
export class KeywordIndex {
  /**
   * @param {Object} opts
   * @param {import("./local-index.js").LocalIndex} opts.localIndex
   * @param {string} opts.vaultPath - absolute path to the vault root
   * @param {{ isHolder: boolean, onAcquired: (fn: () => void) => void, onLost: (fn: () => void) => void }} opts.lease
   * @param {typeof fsSync.watch} [opts.watch] - file watcher factory
   * @param {number} [opts.debounceMs]
   * @param {number} [opts.watcherRetryMs] - wait before restarting a watcher that failed
   */
  constructor({ localIndex, vaultPath, lease, watch = fsSync.watch, debounceMs = DEBOUNCE_MS, watcherRetryMs = WATCHER_RETRY_MS }) {
    if (!localIndex) throw new Error("KeywordIndex requires a localIndex");
    if (!lease) throw new Error("KeywordIndex requires a lease");
    this.db = localIndex.db;
    this.vaultPath = vaultPath;
    this.lease = lease;
    this._watch = watch;
    this._debounceMs = debounceMs;
    this._watcherRetryMs = watcherRetryMs;
    this.watcher = null;
    this._retryTimer = null;
    this._timers = new Map(); // rel -> debounce timer
    this._tail = Promise.resolve(); // writes run one at a time
    /** @type {Promise<{ indexed: number, removed: number }|null>|null} */
    this._syncPromise = null;
    this._closed = false;
    lease.onAcquired(() => this._startHousekeeping());
    lease.onLost(() => this._stopHousekeeping());
  }

  /** Begin watching and catching up when this process holds the lease; otherwise wait for it to. */
  start() {
    if (this.lease.isHolder) this._startHousekeeping();
  }

  _startHousekeeping() {
    if (this._closed || !this.lease.isHolder) return;
    this.sync().catch(e => console.error(`Keyword index: startup sync failed: ${e.message}`));
    if (!this.watcher) this._startWatcher();
  }

  _stopHousekeeping() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  _startWatcher() {
    try {
      this.watcher = this._watch(this.vaultPath, { recursive: true }, (_type, filename) => this._onWatchEvent(filename));
      this.watcher.on("error", (err) => {
        console.error(`Keyword index: file watcher error: ${err.message}`);
        this.watcher?.close();
        this.watcher = null;
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          if (this._closed || !this.lease.isHolder) return;
          // Whatever changed while no watcher ran is picked up by the scan.
          this._startHousekeeping();
        }, this._watcherRetryMs);
        this._retryTimer.unref?.();
      });
    } catch (err) {
      console.error(`Keyword index: could not start file watcher: ${err.message}`);
    }
  }

  _onWatchEvent(filename) {
    if (!filename || this._closed) return;
    const rel = toVaultRel(String(filename));
    if (!rel || rel.split("/").some(p => p.startsWith("."))) return;
    clearTimeout(this._timers.get(rel));
    const timer = setTimeout(() => {
      this._timers.delete(rel);
      this.refresh(rel).catch(e => console.error(`Keyword index: update failed for ${rel}: ${e.message}`));
    }, this._debounceMs);
    this._timers.set(rel, timer);
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  _enqueue(fn) {
    const run = this._tail.then(fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  /** Resolves when the queued writes and any pending debounced events have run. */
  async whenIdle() {
    for (;;) {
      const tail = this._tail;
      await tail;
      if (this._timers.size === 0 && tail === this._tail) return;
      if (this._timers.size > 0) await new Promise(r => setTimeout(r, this._debounceMs + 5));
    }
  }

  /** Resolves with the latest startup sync's counts. */
  whenSynced() {
    return this._syncPromise ?? Promise.resolve(null);
  }

  /**
   * Bring the index in line with the vault: drop rows of deleted notes and index new or changed ones.
   * @returns {Promise<{ indexed: number, removed: number }|null>} null when this process is not the holder
   */
  sync() {
    if (!this.lease.isHolder) return Promise.resolve(null);
    this._syncPromise = this._enqueue(() => this._syncNow());
    return this._syncPromise;
  }

  async _syncNow() {
    const onDisk = await getAllMarkdownFiles(this.vaultPath);
    return this._reconcile(onDisk, null);
  }

  /**
   * Compare `present` notes with the rows under `prefix` (null for the whole vault).
   * Called from the write queue.
   */
  async _reconcile(present, prefix) {
    if (!this.lease.isHolder) return null;
    const rows = prefix === null
      ? this.db.prepare("SELECT path, mtime_ms, size FROM keyword_docs").all()
      : this.db.prepare("SELECT path, mtime_ms, size FROM keyword_docs WHERE substr(path, 1, ?) = ?").all(prefix.length, prefix);
    const known = new Map(rows.map(r => [r.path, r]));
    const seen = new Set(present);

    let removed = 0;
    this.db.transaction(() => {
      for (const p of known.keys()) {
        if (!seen.has(p)) { this._remove(p); removed++; }
      }
    })();

    const changed = [];
    await Promise.all(present.map(async (rel) => {
      try {
        const stat = await fs.stat(path.join(this.vaultPath, rel));
        const row = known.get(rel);
        if (!row || row.mtime_ms !== Math.floor(stat.mtimeMs) || row.size !== stat.size) changed.push(rel);
      } catch { /* gone since the listing */ }
    }));

    let indexed = 0;
    for (let i = 0; i < changed.length; i += READ_BATCH) {
      if (this._closed || !this.lease.isHolder) break;
      const loaded = await Promise.all(changed.slice(i, i + READ_BATCH).map(rel => this._load(rel)));
      this.db.transaction(() => {
        for (const doc of loaded) {
          if (doc) { this._put(doc); indexed++; }
        }
      })();
    }
    return { indexed, removed };
  }

  /** @returns {Promise<{ rel: string, text: string, mtimeMs: number, size: number }|null>} null when not a readable note */
  async _load(rel) {
    const abs = path.join(this.vaultPath, rel);
    try {
      if ((await fs.lstat(abs)).isSymbolicLink()) return null;
      const [body, stat] = await Promise.all([fs.readFile(abs, "utf-8"), fs.stat(abs)]);
      // The file name is searchable text too.
      return { rel, text: `${path.posix.basename(rel, ".md")}\n${body}`, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size };
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR") return null;
      throw e;
    }
  }

  _put({ rel, text, mtimeMs, size }) {
    const existing = this.db.prepare("SELECT id FROM keyword_docs WHERE path = ?").get(rel);
    let id;
    if (existing) {
      id = existing.id;
      this.db.prepare("DELETE FROM keyword_fts WHERE rowid = ?").run(id);
      this.db.prepare("UPDATE keyword_docs SET mtime_ms = ?, size = ? WHERE id = ?").run(mtimeMs, size, id);
    } else {
      id = Number(this.db.prepare("INSERT INTO keyword_docs (path, mtime_ms, size) VALUES (?, ?, ?)").run(rel, mtimeMs, size).lastInsertRowid);
    }
    this.db.prepare("INSERT INTO keyword_fts (rowid, text) VALUES (?, ?)").run(id, text);
  }

  _remove(rel) {
    const row = this.db.prepare("SELECT id FROM keyword_docs WHERE path = ?").get(rel);
    if (!row) return;
    this.db.prepare("DELETE FROM keyword_fts WHERE rowid = ?").run(row.id);
    this.db.prepare("DELETE FROM keyword_docs WHERE id = ?").run(row.id);
  }

  /**
   * Re-read one path: a note is indexed, updated or dropped; a folder is reconciled with its rows.
   * @param {string} relativePath - vault-relative path
   * @returns {Promise<void>}
   */
  refresh(relativePath) {
    if (!this.lease.isHolder) return Promise.resolve();
    const rel = toVaultRel(relativePath);
    return this._enqueue(async () => {
      if (this._closed || !this.lease.isHolder) return;
      if (rel.endsWith(".md")) {
        const doc = await this._load(rel);
        if (doc) this.db.transaction(() => this._put(doc))();
        else this._remove(rel);
        return;
      }
      const abs = path.join(this.vaultPath, rel);
      let present = [];
      try {
        if (!(await fs.stat(abs)).isDirectory()) return;
        present = (await getAllMarkdownFiles(abs)).map(f => toVaultRel(path.join(rel, f)));
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      }
      await this._reconcile(present, rel + "/");
    });
  }

  /**
   * BM25-ranked notes matching any word of `query`, best first. Safe for any text: only
   * letters and digits are used, so FTS5 syntax in the query is never interpreted.
   * `rank` is the 1-based position and `score` the positive BM25 weight.
   * @param {string} query
   * @param {{ limit?: number, folder?: string }} [options] - folder is a vault-relative path prefix
   * @returns {Array<{ path: string, rank: number, score: number }>}
   */
  keywordSearch(query, { limit = 10, folder } = {}) {
    const match = toMatchExpression(query);
    if (!match) return [];
    const prefix = folder ? toVaultRel(folder).replace(/\/+$/, "") + "/" : "";
    const rows = prefix
      ? this.db.prepare(
        `SELECT d.path AS path, bm25(keyword_fts) AS bm FROM keyword_fts JOIN keyword_docs d ON d.id = keyword_fts.rowid
         WHERE keyword_fts MATCH ? AND substr(d.path, 1, ?) = ? ORDER BY bm LIMIT ?`
      ).all(match, prefix.length, prefix, limit)
      : this.db.prepare(
        `SELECT d.path AS path, bm25(keyword_fts) AS bm FROM keyword_fts JOIN keyword_docs d ON d.id = keyword_fts.rowid
         WHERE keyword_fts MATCH ? ORDER BY bm LIMIT ?`
      ).all(match, limit);
    return rows.map((r, i) => ({ path: r.path, rank: i + 1, score: -r.bm }));
  }

  /** Stop watching and wait for writes in flight. The local index stays open for its owner to close. */
  async shutdown() {
    this._closed = true;
    this._stopHousekeeping();
    await this._tail;
  }
}
