import fs from "node:fs/promises";
import path from "node:path";

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
      files.push(path.relative(baseDir, fullPath));
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
 * on-disk spelling, which is what callers must use to open the file.
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

    let matches = this.#fuzzyMatches(rel);
    if (matches.length === 0 && this.#now() - this.#lastRescan >= RESCAN_THROTTLE_MS) {
      this.#lastRescan = this.#now();
      await this.listFresh();
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

  /** Cached lookup, else fs.stat; a hit is cached under its real, on-disk spelling. */
  async #lookup(rel) {
    const cached = this.#byKey.get(keyOf(rel));
    if (cached !== undefined) return cached;
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
