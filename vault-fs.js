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
  const realRel = path.relative(realRoot, realTarget).split(path.sep).join("/");
  let exists = true;
  try {
    await fs.lstat(abs);
  } catch {
    exists = false;
  }
  const badDot = realRel !== "" && hasDotSegment(realRel);
  const badExt = kind === "note" && exists && !realTarget.endsWith(".md");
  if (badDot || badExt) throw (kind === "folder" ? folderRuleError(rel) : noteRuleError(rel));
}
