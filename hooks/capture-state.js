// IMPORTANT: Hooks run via raw `node` from the installed plugin directory,
// which has no node_modules. Only relative and node: imports are allowed here.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURSOR_MAX_AGE_MS = 30 * DAY_MS;
const SHORT_LIVED_MAX_AGE_MS = 7 * DAY_MS;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Matches the capture agent's type with or without a `<plugin>:` prefix. */
export const CAPTURE_AGENT_RE = /^(?:[A-Za-z0-9_-]+:)?pkm-capture$/;

/**
 * @typedef {object} Cursor
 * @property {1} version
 * @property {string|null} transcript_path
 * @property {{ uuid: string, at: string }|null} committed the last transcript entry already handed to a capture
 */

/** Ids come from hook input and become file names, so only plain ids pass. */
export function safeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function requireId(id) {
  if (!safeId(id)) throw new Error(`unsafe id: ${JSON.stringify(id)}`);
  return id;
}

/** `$CLAUDE_PLUGIN_DATA/captures`, or the home fallback when the variable is unset, empty or unexpanded. */
export function capturesDir(env = process.env, home = os.homedir()) {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (data && !data.includes("${")) return path.join(data, "captures");
  return path.join(home, ".claude", "vault-pkm", "captures");
}

export function cursorPath(dir, sessionId) {
  return path.join(dir, `${requireId(sessionId)}.json`);
}

export function deltaPath(dir, sessionId, agentId) {
  return path.join(dir, `${requireId(sessionId)}-${requireId(agentId)}.md`);
}

/** @returns {Cursor} */
function freshCursor() {
  return { version: 1, transcript_path: null, committed: null };
}

/**
 * Never throws for bad content: a missing, corrupt, foreign-version or uncommitted file
 * reads as a fresh cursor, which makes the next capture start at the beginning.
 * @returns {Promise<Cursor>}
 */
export async function readCursor(dir, sessionId) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cursorPath(dir, sessionId), "utf8"));
  } catch {
    return freshCursor();
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return freshCursor();
  const c = parsed.committed;
  if (!c || typeof c !== "object" || typeof c.uuid !== "string" || !c.uuid) return freshCursor();
  return {
    version: 1,
    transcript_path: typeof parsed.transcript_path === "string" ? parsed.transcript_path : null,
    committed: { uuid: c.uuid, at: typeof c.at === "string" ? c.at : "" },
  };
}

/**
 * Atomic via a temp file and rename. Concurrent writers are not serialised:
 * the last rename wins and the other update is lost, so the worst case is a
 * transcript range captured twice. A failed write removes its temp file and throws.
 * @param {Cursor} cursor
 */
export async function writeCursor(dir, sessionId, cursor) {
  const target = cursorPath(dir, sessionId);
  const body = JSON.stringify(
    { version: 1, transcript_path: cursor.transcript_path ?? null, committed: cursor.committed ?? null },
    null,
    2,
  );
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** The uuid to condense after, or null to start at the beginning. */
export function startPoint(cursor) {
  return cursor?.committed?.uuid ?? null;
}

/**
 * Removes cursor files older than 30 days and delta and temp files older than
 * 7 days (by mtime). Other files are left alone. Best effort: never throws.
 */
export async function pruneCaptures(dir, nowMs = Date.now()) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let maxAge;
    if (entry.name.endsWith(".tmp")) maxAge = SHORT_LIVED_MAX_AGE_MS;
    else if (entry.name.endsWith(".md")) maxAge = SHORT_LIVED_MAX_AGE_MS;
    else if (entry.name.endsWith(".json")) maxAge = CURSOR_MAX_AGE_MS;
    else continue;
    try {
      const file = path.join(dir, entry.name);
      const { mtimeMs } = await fs.stat(file);
      if (nowMs - mtimeMs > maxAge) await fs.rm(file, { force: true });
    } catch {
      // already gone or unreadable: leave it for the next run
    }
  }
}
