import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setInterval, clearInterval } from "node:timers";

const LOCK_NAME = "housekeeper.lock";
const GUARD_NAME = "housekeeper.takeover.lock";

/**
 * Elects one process per state folder to do background work. The holder keeps a lock file
 * fresh with a heartbeat; other processes retry on the same interval and take over when the
 * holder releases or its heartbeat goes stale.
 */
export class HousekeeperLease {
  /**
   * @param {{ stateDir: string, now?: () => number, heartbeatMs?: number, staleMs?: number }} options
   */
  constructor({ stateDir, now = Date.now, heartbeatMs = 5000, staleMs = 20000 }) {
    this.stateDir = stateDir;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
    this.lockPath = path.join(stateDir, LOCK_NAME);
    this.guardPath = path.join(stateDir, GUARD_NAME);
    this.token = crypto.randomBytes(8).toString("hex");
    this.isHolder = false;
    this._acquired = [];
    this._lost = [];
    this._timer = null;
    this._closed = false;
    this._busy = null;
  }

  onAcquired(fn) { this._acquired.push(fn); }
  onLost(fn) { this._lost.push(fn); }

  /** @returns {Promise<boolean>} true when this process holds the lease afterwards */
  async tryAcquire() {
    if (this._closed) return false;
    this._startTimer();
    if (this.isHolder) return true;
    if (await this._claim()) {
      this.isHolder = true;
      if (this._closed) {
        await this._removeOwnLock();
        this.isHolder = false;
        return false;
      }
      this._fire(this._acquired);
    }
    return this.isHolder;
  }

  /** Refresh the lock, or notice that another process took it over. */
  async heartbeat() {
    if (!this.isHolder) return;
    const current = await this._read();
    if (!current || current.token !== this.token) {
      this._lose();
      return;
    }
    await this._writeLock(true);
  }

  /** Stop all timers and remove the lock if this process still owns it. */
  async release() {
    this._closed = true;
    clearInterval(this._timer);
    this._timer = null;
    await this._busy;
    const wasHolder = this.isHolder;
    this.isHolder = false;
    if (wasHolder) await this._removeOwnLock();
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._busy) return;
      this._busy = (this.isHolder ? this.heartbeat() : this.tryAcquire())
        .catch(() => {})
        .finally(() => { this._busy = null; });
    }, this.heartbeatMs);
    this._timer.unref();
  }

  _lose() {
    if (!this.isHolder) return;
    this.isHolder = false;
    this._fire(this._lost);
  }

  _fire(callbacks) {
    for (const fn of callbacks) {
      Promise.resolve().then(fn).catch((e) => console.error(`Housekeeper lease callback failed: ${e.message}`));
    }
  }

  _record() {
    return JSON.stringify({ pid: process.pid, token: this.token, beat: this.now() });
  }

  async _read(file = this.lockPath) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    try {
      const rec = JSON.parse(text);
      if (rec && typeof rec.beat === "number" && typeof rec.token === "string") return rec;
    } catch { /* corrupt, treated as stale below */ }
    return { token: null, beat: -Infinity };
  }

  _isStale(rec) {
    return this.now() - rec.beat > this.staleMs;
  }

  async _writeTemp() {
    const tmp = path.join(this.stateDir, `.${LOCK_NAME}.${this.token}.tmp`);
    await fs.writeFile(tmp, this._record());
    return tmp;
  }

  // Overwrites the lock atomically; with `ifOwned`, never resurrects a lock that was removed.
  async _writeLock(ifOwned = false) {
    const tmp = await this._writeTemp();
    try {
      if (ifOwned) {
        const current = await this._read();
        if (!current || current.token !== this.token) {
          this._lose();
          return;
        }
      }
      await fs.rename(tmp, this.lockPath);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async _claim() {
    // link() fails with EEXIST like an exclusive create, but the lock appears with its
    // content already in place, so no reader ever sees a half-written lock.
    const tmp = await this._writeTemp();
    try {
      try {
        await fs.link(tmp, this.lockPath);
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
    const current = await this._read();
    if (!current) return this._claim();
    if (current.token === this.token) return true;
    if (!this._isStale(current)) return false;
    return this._takeOver();
  }

  // Serialised by a guard file so that of several processes judging the same lock stale,
  // only the first replaces it; the others re-check inside the guard and see a fresh lock.
  async _takeOver() {
    if (!(await this._takeGuard())) return false;
    try {
      const current = await this._read();
      if (current && !this._isStale(current)) return current.token === this.token;
      await this._writeLock();
      return true;
    } finally {
      await fs.rm(this.guardPath, { force: true });
    }
  }

  async _takeGuard() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(this.guardPath, String(this.now()), { flag: "wx" });
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      // A guard lives for a few system calls; an old one was left by a crash mid-takeover.
      const stamp = Number(await fs.readFile(this.guardPath, "utf8").catch(() => NaN));
      if (Number.isFinite(stamp) && this.now() - stamp <= this.staleMs) return false;
      await fs.rm(this.guardPath, { force: true });
    }
    return false;
  }

  async _removeOwnLock() {
    const current = await this._read().catch(() => null);
    if (current && current.token === this.token) await fs.rm(this.lockPath, { force: true });
  }
}
