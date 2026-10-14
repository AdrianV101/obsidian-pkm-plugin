import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ESCAPE_MESSAGE = "Path escapes vault directory. Paths must be relative to the vault root (e.g., '01-Projects/MyApp/_index.md').";

/**
 * Normalise a vault-relative path: "/" separators, "." and inner ".." segments
 * collapsed, no leading "./" or "/", no trailing "/". "" means the vault root.
 * @param {string} p
 * @returns {string}
 */
export function toVaultRel(p) {
  const normalized = path.posix.normalize(String(p).replace(/\\/g, "/"));
  if (normalized === "." || normalized === "/") return "";
  return normalized.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * @param {string} vaultPath
 * @returns {string} absolute path without a trailing separator
 */
export function normalizeVaultRoot(vaultPath) {
  return path.resolve(String(vaultPath));
}

const noteRuleError = (rel) => new Error(`Write tools only accept .md notes outside dot-folders: ${rel}`);
const folderRuleError = (rel) => new Error(`vault_move only moves folders outside dot-folders, and never the vault root: ${rel}`);

function isInside(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Resolve a vault-relative path lexically (no filesystem access).
 * @param {string} rel
 * @param {string} root
 * @returns {string} absolute path
 * @throws {Error} if the path leaves the vault
 */
export function resolveLexical(rel, root) {
  const base = normalizeVaultRoot(root);
  // Backslashes are separators for toVaultRel and the write rules, so path.resolve must read them the same way on POSIX.
  const resolved = path.resolve(base, String(rel).replace(/\\/g, "/"));
  if (!isInside(resolved, base)) throw new Error(ESCAPE_MESSAGE);
  return resolved;
}

async function isSymlink(p) {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw e;
  }
}

/** realpath of `abs`, or of its nearest existing ancestor when `abs` does not exist. */
async function realpathOfNearestExisting(abs) {
  let probe = abs;
  for (;;) {
    try {
      return await fs.realpath(probe);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      // A dangling symlink's target cannot be verified, so it is treated as an escape.
      if (await isSymlink(probe)) throw new Error(ESCAPE_MESSAGE, { cause: e });
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

/**
 * Resolve a vault-relative path and verify, through symlinks, that it stays in the vault.
 * @param {string} rel
 * @param {string} root
 * @returns {Promise<string>} the lexical absolute path (symlinks not expanded)
 * @throws {Error} if the path, or the real location of its nearest existing ancestor, leaves the vault
 */
export async function resolveSafe(rel, root) {
  const abs = resolveLexical(rel, root);
  const realRoot = await fs.realpath(normalizeVaultRoot(root));
  const realTarget = await realpathOfNearestExisting(abs);
  if (!isInside(realTarget, realRoot)) throw new Error(ESCAPE_MESSAGE);
  return abs;
}

/**
 * @param {string} rel
 * @returns {boolean} true if any segment of the normalised path starts with "."
 */
export function hasDotSegment(rel) {
  return toVaultRel(rel).split("/").some((s) => s.startsWith("."));
}

/**
 * @param {string} rel
 * @throws {Error} unless rel is a .md path with no segment starting with "."
 */
export function assertWritableNote(rel) {
  const r = toVaultRel(rel);
  if (!r.endsWith(".md") || hasDotSegment(r)) {
    throw noteRuleError(rel);
  }
}

/**
 * @param {string} rel
 * @throws {Error} if rel is the vault root or has a segment starting with "."
 */
export function assertWritableFolder(rel) {
  const r = toVaultRel(rel);
  if (r === "" || hasDotSegment(r)) {
    throw folderRuleError(rel);
  }
}


/**
 * The write rules applied to where the target really lives: symlinks inside the
 * vault must not let a write tool reach a dot-folder or a non-.md file.
 * @param {string} rel
 * @param {string} root
 * @param {"note"|"folder"} [kind]
 * @throws {Error} the write-rule error for `kind`
 */
export async function assertWritableReal(rel, root, kind = "note") {
  const assertLexical = kind === "folder" ? assertWritableFolder : assertWritableNote;
  assertLexical(rel);
  const abs = resolveLexical(rel, root);
  const realRoot = await fs.realpath(normalizeVaultRoot(root));
  const realTarget = await realpathOfNearestExisting(abs);
  // For a new file this is the real nearest ancestor; the missing tail was checked lexically above.
  // Split on the platform separator only: a real entry name may itself contain backslashes.
  const realSegments = path.relative(realRoot, realTarget).split(path.sep);
  let exists = true;
  try {
    await fs.lstat(abs);
  } catch {
    exists = false;
  }
  const badDot = realSegments.some((s) => s.startsWith("."));
  const badExt = kind === "note" && exists && !realTarget.endsWith(".md");
  if (badDot || badExt) throw (kind === "folder" ? folderRuleError(rel) : noteRuleError(rel));
}

/**
 * Recursively list .md files under `dir`, skipping symlinks and dot-directories.
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {Promise<string[]>} "/"-separated paths relative to baseDir
 */
export async function getAllMarkdownFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...await getAllMarkdownFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(toVaultRel(path.relative(baseDir, fullPath)));
    }
  }
  return files;
}

const RESCAN_THROTTLE_MS = 2000;
const keyOf = (rel) => rel.normalize("NFC");
const baseKeyOf = (rel) => path.posix.basename(rel, ".md").normalize("NFC").toLowerCase();

/** Same rule as getAllMarkdownFiles: a .md file not inside a dot-directory. */
function isIndexable(rel) {
  if (!rel.endsWith(".md")) return false;
  return !rel.split("/").slice(0, -1).some((s) => s.startsWith("."));
}

/**
 * Live index of the vault's markdown notes. Keys are NFC-normalised so a note
 * stored under an NFD name (macOS) is found by its NFC spelling; values are the
 * on-disk spelling, which is what callers must use to open the file. Lookups
 * re-check cached entries on disk, so a note moved or deleted outside the plugin
 * is dropped instead of resolving to a path that no longer exists.
 */
export class FileIndex {
  #root;
  #now;
  #realRoot = null;
  #byKey = new Map();
  #byBase = new Map();
  #lastRescan = -Infinity;

  /**
   * @param {string} root
   * @param {{ now?: () => number }} [options]
   */
  constructor(root, { now = Date.now } = {}) {
    this.#root = normalizeVaultRoot(root);
    this.#now = now;
  }

  /**
   * @param {string} root
   * @param {{ now?: () => number }} [options]
   * @returns {Promise<FileIndex>}
   */
  static async build(root, options) {
    const index = new FileIndex(root, options);
    await index.listFresh();
    return index;
  }

  /** @param {string} rel */
  has(rel) {
    return this.#byKey.has(keyOf(toVaultRel(rel)));
  }

  /** @param {string} rel */
  async exists(rel) {
    return (await this.#lookup(toVaultRel(rel))) !== null;
  }

  /**
   * Resolve a full, partial or bare note name to its vault-relative path.
   * @param {string} input
   * @returns {Promise<string>}
   */
  async resolveFuzzy(input) {
    const rel = toVaultRel(input);
    const direct = (await this.#lookup(rel)) ?? (rel.endsWith(".md") ? null : await this.#lookup(rel + ".md"));
    if (direct !== null) return direct;

    let matches = [];
    let evicted = false;
    for (const candidate of this.#fuzzyMatches(rel)) {
      if (await this.#isFileOnDisk(candidate)) {
        matches.push(candidate);
      } else {
        this.remove(candidate);
        evicted = true;
      }
    }
    // A vanished candidate proves the vault changed outside the plugin, so rescan at once (each
    // eviction is a one-off); a plain miss rescans at most once per throttle window.
    if (evicted || (matches.length === 0 && this.#now() - this.#lastRescan >= RESCAN_THROTTLE_MS)) {
      await this.#rescan();
      matches = this.#fuzzyMatches(rel);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`File not found: "${input}". No matching file in vault.`);
    }
    const list = matches.map((p) => `  - ${p}`).join("\n");
    throw new Error(`"${input}" matches ${matches.length} files:\n${list}\nUse a more specific path (pass the full path).`);
  }

  /** @param {string} rel */
  add(rel) {
    const r = toVaultRel(rel);
    const key = keyOf(r);
    if (this.#byKey.has(key)) return;
    this.#byKey.set(key, r);
    const base = baseKeyOf(r);
    const group = this.#byBase.get(base);
    if (group) group.push(r);
    else this.#byBase.set(base, [r]);
  }

  /** @param {string} rel */
  remove(rel) {
    const key = keyOf(toVaultRel(rel));
    const stored = this.#byKey.get(key);
    if (stored === undefined) return;
    this.#byKey.delete(key);
    const base = baseKeyOf(stored);
    const remaining = (this.#byBase.get(base) ?? []).filter((p) => p !== stored);
    if (remaining.length > 0) this.#byBase.set(base, remaining);
    else this.#byBase.delete(base);
  }

  /**
   * @param {string} oldRel
   * @param {string} newRel
   */
  rename(oldRel, newRel) {
    const oldR = toVaultRel(oldRel);
    const newR = toVaultRel(newRel);
    if (this.#byKey.has(keyOf(oldR))) {
      this.remove(oldR);
      this.add(newR);
      return;
    }
    // A folder move: re-key every note under the old prefix; the folder itself is never indexed.
    const prefix = keyOf(oldR) + "/";
    for (const [key, stored] of [...this.#byKey]) {
      if (!key.startsWith(prefix)) continue;
      this.remove(stored);
      this.add(newR + "/" + stored.slice(oldR.length + 1));
    }
  }

  /** @returns {string[]} */
  list() {
    return [...this.#byKey.values()];
  }

  /** @returns {Promise<string[]>} */
  async listFresh() {
    const files = await getAllMarkdownFiles(this.#root);
    this.#byKey = new Map();
    this.#byBase = new Map();
    for (const f of files) this.add(f);
    return this.list();
  }

  /** @returns {Map<string, string[]>} lowercase basename (no .md) -> paths */
  get basenameMap() {
    return this.#byBase;
  }

  /** A rescan that fails does not use up the throttle window. */
  async #rescan() {
    const previous = this.#lastRescan;
    this.#lastRescan = this.#now();
    try {
      await this.listFresh();
    } catch (e) {
      this.#lastRescan = previous;
      throw e;
    }
  }

  /** Whether a cached entry is still a file on disk; an unreadable location counts as present. */
  async #isFileOnDisk(rel) {
    try {
      return (await fs.stat(resolveLexical(rel, this.#root))).isFile();
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
      return true;
    }
  }

  #fuzzyMatches(rel) {
    const needle = keyOf(rel).toLowerCase();
    if (needle.includes("/")) {
      const suffixes = needle.endsWith(".md") ? ["/" + needle] : ["/" + needle, "/" + needle + ".md"];
      return this.list().filter((f) => {
        const hay = "/" + keyOf(f).toLowerCase();
        return suffixes.some((s) => hay.endsWith(s));
      });
    }
    return [...(this.#byBase.get(baseKeyOf(needle)) ?? [])];
  }

  /** Cached lookup (re-checked on disk), else fs.stat; a hit is cached under its real, on-disk spelling. */
  async #lookup(rel) {
    const cached = this.#byKey.get(keyOf(rel));
    if (cached !== undefined) {
      if (await this.#isFileOnDisk(cached)) return cached;
      this.remove(cached);
    }
    if (!isIndexable(rel)) return null;
    const abs = resolveLexical(rel, this.#root);
    let real;
    try {
      if (!(await fs.stat(abs)).isFile()) return null;
      real = await fs.realpath(abs);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
      throw e;
    }
    if (this.#realRoot === null) this.#realRoot = await fs.realpath(this.#root);
    if (!isInside(real, this.#realRoot)) return null;
    const realRel = path.relative(this.#realRoot, real).split(path.sep).join("/");
    if (!isIndexable(realRel)) return null;
    this.add(realRel);
    return this.#byKey.get(keyOf(realRel));
  }
}

// ── Atomic writes ────────────────────────────────────────────────────
//
// Guarantees:
// - Plugin processes (any number of servers on one vault) are serialised per note by an
//   in-process queue plus an O_EXCL lock file holding a token unique to its holder, and a
//   holder only ever removes its own lock. A lock older than the stale timeout (left by a
//   crashed process) is taken over by one waiter at a time. That takeover can still race with a
//   holder that outlived the stale timeout releasing its own lock at the same instant; the
//   mtime/size/inode re-check before the rename (below) is then the fallback against a lost update.
// - Writers outside the plugin (Obsidian, sync clients) take no lock. They are detected by
//   comparing mtime/size/inode just before the rename and the update is re-applied; a write
//   landing in the few microseconds between that check and the rename can still be lost.
// - Readers never see a partial note: the new content is staged in a temp file and renamed in.

const DEFAULT_STALE_LOCK_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

/** Per-file promise chains; module-level so every handler instance in the process shares them. */
const fileQueues = new Map();

function queueByKey(key, fn) {
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  fileQueues.set(key, tail);
  tail.then(() => {
    if (fileQueues.get(key) === tail) fileQueues.delete(key);
  });
  return run;
}

const shortHash = (text, length) => crypto.createHash("sha1").update(text).digest("hex").slice(0, length);

// Names built from a hash, not the note's name, so they stay short however long the note's name is.
function tempPathFor(target) {
  const name = `.${shortHash(path.basename(target), 8)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  return path.join(path.dirname(target), name);
}

function lockPathFor(target) {
  return path.join(path.dirname(target), `.${shortHash(path.basename(target), 16)}.lock`);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function conflict(message) {
  return Object.assign(new Error(message), { code: "ECONFLICT" });
}

const uniqueToken = () => `${process.pid} ${Date.now()} ${crypto.randomBytes(8).toString("hex")}`;

/** Remove the lock file only while it still holds `token`: a holder never deletes another's lock. */
async function releaseLockFile(lock, token) {
  try {
    if (await fs.readFile(lock, "utf-8") !== token) return;
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  await fs.rm(lock, { force: true });
}

/** @returns {Promise<"gone"|"fresh"|"stale">} */
async function lockState(file, staleLockMs) {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs > staleLockMs ? "stale" : "fresh";
  } catch (e) {
    if (e.code === "ENOENT") return "gone";
    throw e;
  }
}

/**
 * Remove `lock` if it is stale (left by a crashed process). Waiters take turns through a second
 * O_EXCL file, the guard, so of several waiters that find the same stale lock only one removes it,
 * after re-checking it under the guard; the others go back to waiting. While the stale lock
 * exists nobody can create a new one, so the re-checked lock is the one removed, unless its own
 * holder, slower than `staleLockMs`, releases it in that instant and another process re-creates it.
 * @returns {Promise<boolean>} true when the lock is gone (try to create it again at once)
 */
async function takeOverIfStale(lock, staleLockMs, beforeTakeover) {
  const state = await lockState(lock, staleLockMs);
  if (state !== "stale") return state === "gone";
  if (beforeTakeover) await beforeTakeover();
  // Named like a lock (".*.lock"), so sync-tool ignore patterns for locks cover it too.
  const guard = lock.replace(/\.lock$/, ".takeover.lock");
  const token = uniqueToken();
  try {
    await fs.writeFile(guard, token, { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // A guard is held for a few system calls only; an old one was left by a crash mid-takeover.
    if (await lockState(guard, staleLockMs) === "stale") await fs.rm(guard, { force: true });
    return false;
  }
  try {
    const again = await lockState(lock, staleLockMs);
    if (again === "stale") await fs.rm(lock, { force: true });
    return again !== "fresh";
  } finally {
    await releaseLockFile(guard, token);
  }
}

/**
 * Take the cross-process lock for a note: an exclusively created `.<hash>.lock` file next to it,
 * holding a token unique to this holder. A lock older than `staleLockMs` is treated as left by a
 * crashed process and taken over. Use withNoteLock; this is exported for tests.
 * @param {string} target real path of the note
 * @param {{
 *   staleLockMs: number, lockTimeoutMs: number, sleep: (ms: number) => Promise<void>,
 *   beforeTakeover?: () => Promise<void>,
 * }} options `beforeTakeover` is a test seam, awaited after a lock is judged stale
 * @returns {Promise<() => Promise<void>>} release function
 */
export async function acquireLockFile(target, { staleLockMs, lockTimeoutMs, sleep, beforeTakeover }) {
  const lock = lockPathFor(target);
  const token = uniqueToken();
  let waited = 0;
  for (let i = 0; ; i++) {
    try {
      await fs.writeFile(lock, token, { flag: "wx" });
      return () => releaseLockFile(lock, token);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (await takeOverIfStale(lock, staleLockMs, beforeTakeover)) continue;
    if (waited >= lockTimeoutMs) {
      throw conflict(`Gave up updating ${path.basename(target)}: another process held its lock for ${waited} ms. Try again.`);
    }
    // Jitter, so waiters that started together do not retry in lockstep.
    const ms = Math.ceil(Math.min(50, 1 + i) * (0.5 + Math.random()));
    waited += ms;
    await sleep(ms);
  }
}

/**
 * Run `fn` while holding the note's in-process queue slot and cross-process lock file. Use it
 * for operations on the note itself (e.g. renaming it) so a concurrent mutateFile cannot
 * recreate the old path.
 * @template T
 * @param {string} absPath
 * @param {(realPath: string) => Promise<T>} fn
 * @param {{ staleLockMs?: number, lockTimeoutMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 * @throws ENOENT (as-is) when the note does not exist
 */
export async function withNoteLock(absPath, fn, {
  staleLockMs = DEFAULT_STALE_LOCK_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  sleep = defaultSleep,
} = {}) {
  const target = await fs.realpath(absPath);
  return queueByKey(target, async () => {
    const release = await acquireLockFile(target, { staleLockMs, lockTimeoutMs, sleep });
    try {
      return await fn(target);
    } finally {
      await release();
    }
  });
}

function sameVersion(a, b) {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

// Windows refuses to replace a file that another process (an editor, a sync client, antivirus,
// the search indexer) has open; such handles are usually short-lived, so the rename is retried.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_BUDGET_MS = 2000;
const RENAME_RETRY_MAX_DELAY_MS = 500;

/**
 * Rename the staged temp file over the note unless the note changed since `statBefore`.
 * @returns {Promise<boolean>} false when the note changed (nothing renamed)
 */
async function renameIfUnchanged(tmp, target, statBefore, { rename, sleep, windows }) {
  let waited = 0;
  for (let retry = 0; ; retry++) {
    if (!sameVersion(statBefore, await fs.stat(target))) return false;
    try {
      await rename(tmp, target);
      return true;
    } catch (e) {
      if (!windows || !RENAME_RETRY_CODES.has(e.code) || waited >= RENAME_RETRY_BUDGET_MS) throw e;
      const ms = Math.min(RENAME_RETRY_MAX_DELAY_MS, 10 * 2 ** retry, RENAME_RETRY_BUDGET_MS - waited);
      waited += ms;
      await sleep(ms);
    }
  }
}

/**
 * Write the new content to a temp file beside the target with the target's permission bits,
 * and, where the filesystem allows, its creation time (renaming a new file over the note would
 * otherwise reset it).
 */
async function stageFile(tmp, content, before) {
  await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx", flush: true });
  await fs.chmod(tmp, before.mode & 0o7777);
  try {
    // Setting an older mtime lowers the file's birthtime on macOS; then restore mtime to now.
    if (before.birthtimeMs > 0 && before.birthtimeMs < Date.now()) {
      await fs.utimes(tmp, before.atime, before.birthtime);
    }
    const now = new Date();
    await fs.utimes(tmp, now, now);
  } catch { /* timestamps are best effort */ }
}

/**
 * The only way to modify an existing note. Per note: serialised across plugin processes by a
 * lock file (plus an in-process queue), the new version is staged in a temp file, the note is
 * re-checked for outside changes (mtime/size/inode), and the temp file is renamed into place so
 * readers never see a partial file. If the note changed, the update is re-applied to the fresh
 * content (up to `maxAttempts`). Writers outside the plugin take no lock, so a write landing
 * between the final check and the rename (microseconds) can still be lost. A transform result
 * identical to the input skips the write. Permission bits and (where supported) creation time
 * are kept; extended attributes and hard-link aliases are not, since the note is replaced. On
 * Windows a rename refused because another process has the note open is retried for up to ~2 s,
 * re-checking the note before each try.
 * @param {string} absPath
 * @param {(content: string) => string | Promise<string>} transform
 * @param {{
 *   maxAttempts?: number, staleLockMs?: number, lockTimeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   rename?: (from: string, to: string) => Promise<void>,
 *   afterStage?: () => Promise<void> | void,
 *   windows?: boolean,
 * }} [options] `sleep`, `rename`, `afterStage` and `windows` are test seams
 * @returns {Promise<{ before: string, after: string }>}
 * @throws ENOENT (as-is) when the file does not exist; EACCES when it has no write permission;
 *   ECONFLICT when it kept changing or its lock was never released
 */
export async function mutateFile(absPath, transform, {
  maxAttempts = 3,
  rename = (from, to) => fs.rename(from, to),
  afterStage,
  sleep = defaultSleep,
  windows = process.platform === "win32",
  ...lockOptions
} = {}) {
  return withNoteLock(absPath, async (target) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const statBefore = await fs.stat(target);
      if (!(statBefore.mode & 0o222)) {
        throw Object.assign(new Error(`${path.basename(target)} is read-only; refusing to modify it.`), { code: "EACCES" });
      }
      const before = await fs.readFile(target, "utf-8");
      const after = await transform(before);
      if (typeof after !== "string") throw new TypeError("mutateFile transform must return a string");
      if (after === before) {
        if (!sameVersion(statBefore, await fs.stat(target))) continue;
        return { before, after };
      }
      const tmp = tempPathFor(target);
      let renamed;
      try {
        await stageFile(tmp, after, statBefore);
        if (afterStage) await afterStage();
        renamed = await renameIfUnchanged(tmp, target, statBefore, { rename, sleep, windows });
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      if (!renamed) {
        await fs.rm(tmp, { force: true });
        continue;
      }
      return { before, after };
    }
    throw conflict(`Gave up updating ${path.basename(target)} after ${maxAttempts} attempts: it kept changing on disk. Try again.`);
  }, { ...lockOptions, sleep });
}

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Create a file without ever replacing an existing one: the content is staged in a temp file and
 * hard-linked into place (or exclusively copied where hard links are unsupported, which is not
 * atomic for readers).
 * @param {string} absPath
 * @param {string} content
 * @param {{
 *   link?: (from: string, to: string) => Promise<void>,
 *   write?: (tmp: string, content: string) => Promise<void>,
 * }} [options] test seams
 * @throws {Error} code "EEXIST" when the target exists
 */
export async function writeNew(absPath, content, {
  link = (from, to) => fs.link(from, to),
  write = (tmp, text) => fs.writeFile(tmp, text, { encoding: "utf-8", flag: "wx", flush: true }),
} = {}) {
  const tmp = tempPathFor(absPath);
  try {
    await write(tmp, content);
    try {
      await link(tmp, absPath);
    } catch (e) {
      if (!LINK_UNSUPPORTED.has(e.code)) throw e;
      // Filesystems without hard links (exFAT, some network shares): exclusive copy keeps fail-if-exists.
      await fs.copyFile(tmp, absPath, fs.constants.COPYFILE_EXCL);
    }
  } catch (e) {
    if (e.code === "EEXIST") {
      throw Object.assign(new Error(`File already exists: ${absPath}`, { cause: e }), { code: "EEXIST" });
    }
    throw e;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
