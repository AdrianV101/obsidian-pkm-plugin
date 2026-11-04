import path from "node:path";
import { Buffer } from "node:buffer";
import { PackWriter, listPacks, readPack } from "./embedding-cache.js";

const toBuffer = (vector) => {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

/**
 * This machine's view of the shared pack folder: imports other devices' packs into the local
 * index (holder only) and collects vectors this process embedded for its own pack.
 */
export class SharedPacks {
  /**
   * @param {Object} opts
   * @param {import("better-sqlite3").Database} opts.db
   * @param {string|undefined} opts.cacheDirAbs
   * @param {{ deviceId?: string, sharedCache?: boolean }|undefined} opts.settings
   * @param {string} opts.model
   * @param {number} opts.dims
   * @param {() => boolean} opts.canWrite - whether this process may write the local index
   * @param {(message: string) => void} [opts.log]
   */
  constructor({ db, cacheDirAbs, settings, model, dims, canWrite, log = console.error }) {
    this.db = db;
    this.cacheDirAbs = cacheDirAbs;
    this.deviceId = settings?.deviceId;
    this.model = model;
    this.dims = dims;
    this.canWrite = canWrite;
    this.log = log;
    this.enabled = !!(settings?.sharedCache && cacheDirAbs && settings.deviceId);
    this._writer = null;
    this._pending = 0;
    this._imported = null;
    this._importChain = Promise.resolve();
    this._unreadable = new Set();
  }

  get pendingCount() { return this._pending; }

  /** @returns {Float32Array|null} */
  get(hash) {
    if (!this.enabled) return null;
    const row = this.db.prepare("SELECT vector FROM pack_vectors WHERE hash = ?").get(hash);
    return row ? new Float32Array(new Uint8Array(row.vector).buffer) : null;
  }

  /** Keeps a vector that was embedded but not yet stored with its note. */
  storeLocal(hash, vector) {
    if (!this.enabled || !this.canWrite()) return;
    this.db.prepare("INSERT OR IGNORE INTO pack_vectors (hash, vector) VALUES (?, ?)").run(hash, toBuffer(vector));
  }

  /** @returns {Promise<boolean>} whether the folder holds a pack written by another device */
  async hasOtherDevices() {
    if (!this.enabled) return false;
    return (await listPacks(this.cacheDirAbs)).some((p) => p.deviceId !== this.deviceId);
  }

  /**
   * Reads every pack not yet imported. A pack that cannot be read yet is skipped and tried again
   * next time. Calls are serialised.
   * @returns {Promise<number>} packs imported
   */
  importNew() {
    if (!this.enabled || !this.canWrite()) return Promise.resolve(0);
    const run = this._importChain.then(() => this._import());
    this._importChain = run.then(() => {}, () => {});
    return run;
  }

  async _import() {
    const listed = await listPacks(this.cacheDirAbs);
    if (!this._imported) {
      this._imported = new Set(this.db.prepare("SELECT name FROM imported_packs").all().map((r) => r.name));
    }
    const present = new Set(listed.map((p) => p.name));
    for (const name of [...this._imported]) {
      if (present.has(name)) continue;
      this.db.prepare("DELETE FROM imported_packs WHERE name = ?").run(name);
      this._imported.delete(name);
    }
    const insertVec = this.db.prepare("INSERT OR IGNORE INTO pack_vectors (hash, vector) VALUES (?, ?)");
    const insertName = this.db.prepare("INSERT OR IGNORE INTO imported_packs (name) VALUES (?)");
    let imported = 0;
    for (const { name } of listed) {
      if (this._imported.has(name)) continue;
      const pack = await readPack(path.join(this.cacheDirAbs, name));
      if (!pack) {
        if (!this._unreadable.has(name)) {
          this._unreadable.add(name);
          this.log(`Semantic index: embedding pack ${name} is not readable yet; trying again on its next change`);
        }
        continue;
      }
      this._unreadable.delete(name);
      const usable = pack.model === this.model && pack.dims === this.dims;
      this.db.transaction(() => {
        if (usable) for (const e of pack.entries) insertVec.run(e.hash, toBuffer(e.vector));
        insertName.run(name);
      })();
      this._imported.add(name);
      imported++;
    }
    return imported;
  }

  add(hash, vector) {
    if (!this.enabled) return;
    this._writer ??= new PackWriter({
      cacheDirAbs: this.cacheDirAbs, deviceId: this.deviceId, model: this.model, dims: this.dims,
    });
    this._writer.add(hash, vector);
    this._pending++;
  }

  /** Writes the collected vectors to a new pack. A failure is logged, never thrown. */
  async flush() {
    if (!this._writer || this._pending === 0) return;
    this._pending = 0;
    try {
      const name = await this._writer.flush();
      // Its vectors are already stored with their notes, so this process need not read it back.
      if (name && this.canWrite() && this._imported) {
        this.db.prepare("INSERT OR IGNORE INTO imported_packs (name) VALUES (?)").run(name);
        this._imported.add(name);
      }
    } catch (err) {
      this.log(`Semantic index: could not write embedding pack: ${err.message}`);
    }
  }
}

/** When the index first saw each chunk it lacks a vector for. */
export class WaitTracker {
  constructor() {
    /** @type {Map<string, { since: number, path: string }>} */
    this._waits = new Map();
  }

  get size() { return this._waits.size; }

  /** @returns {number} the time the chunk was first seen without a vector */
  firstSeen(hash, notePath, now) {
    const existing = this._waits.get(hash);
    if (existing) return existing.since;
    this._waits.set(hash, { since: now, path: notePath });
    return now;
  }

  /** Forgets this note's waits except for the given hashes. */
  retain(notePath, keep) {
    for (const [hash, w] of this._waits) {
      if (w.path === notePath && !keep.has(hash)) this._waits.delete(hash);
    }
  }

  oldest() {
    let min = null;
    for (const w of this._waits.values()) if (min === null || w.since < min) min = w.since;
    return min;
  }

  isDue(now, waitMs) {
    const oldest = this.oldest();
    return oldest !== null && now - oldest >= waitMs;
  }

  paths() {
    return [...new Set([...this._waits.values()].map((w) => w.path))];
  }
}
