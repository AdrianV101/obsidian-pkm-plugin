// Naming, listing and session-note lookup for per-session devlog notes.
// Hooks run from the plugin cache, which has no node_modules, so this module
// must stay dependency-free (relative and node: imports only).

import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";

/** Upper bound on the bytes read from a candidate note when looking up its session. */
const HEAD_BYTES = 4096;

const SESSION_NAME = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3])([0-5]\d) (.+)\.md$/;
const DAY_NAME = /^(\d{4}-\d{2}-\d{2}) (.+) devlog\.md$/;

/**
 * @typedef {{ kind: "session", date: string, time: string, title: string }
 *   | { kind: "day", date: string, project: string }} NoteName
 */

/**
 * @param {string} projectPath vault-relative project folder
 * @returns {string} vault-relative, "/"-separated devlog folder
 */
export function devlogFolder(projectPath) {
  return `${projectPath.replace(/\/+$/, "")}/development/devlog`;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * @param {string|number|Date|null|undefined} timestamp
 * @returns {string|null} local "YYYY-MM-DD HHmm", or null when unparseable
 */
export function sessionPrefix(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === "") return null;
  if (typeof timestamp !== "string" && typeof timestamp !== "number" && !(timestamp instanceof Date)) {
    return null;
  }
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/**
 * Session pattern first: a session title may itself end in "devlog".
 *
 * @param {string} name file name
 * @returns {NoteName|null}
 */
export function classifyNoteName(name) {
  const s = SESSION_NAME.exec(name);
  if (s) return { kind: "session", date: s[1], time: `${s[2]}:${s[3]}`, title: s[4] };
  const d = DAY_NAME.exec(name);
  if (d) return { kind: "day", date: d[1], project: d[2] };
  return null;
}

/**
 * @param {string} date "YYYY-MM-DD"
 * @param {string} project project folder name
 * @returns {string}
 */
export function dayNoteName(date, project) {
  return `${date} ${project} devlog.md`;
}

/**
 * Devlog notes in a folder, newest first. A day note sorts as 00:00 of its day.
 * A missing folder gives []; other read errors propagate.
 *
 * @param {string} dirAbs
 * @returns {Promise<Array<{ name: string, kind: "session"|"day", key: string }>>}
 */
export async function listDevlogNotes(dirAbs) {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const notes = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = classifyNoteName(entry.name);
    if (!info) continue;
    const time = info.kind === "session" ? info.time : "00:00";
    notes.push({ name: entry.name, kind: info.kind, key: `${info.date} ${time}` });
  }
  notes.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? 1 : -1) : a.name < b.name ? 1 : -1));
  return notes;
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** The `session:` value from the frontmatter at the start of `head`, or null. */
function sessionFromHead(head) {
  const lines = head.split(/\r?\n/);
  if (!/^---[ \t]*$/.test(lines[0])) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) return null;
    const m = /^session[ \t]*:(.*)$/.exec(lines[i]);
    if (m) return unquote(m[1]);
  }
  return null;
}

/**
 * Finds the note whose name starts with `<prefix> ` and whose `session:`
 * frontmatter equals `sessionId`. Only prefix-matching files are opened, and
 * only their first 4,096 bytes are read. Unreadable candidates are skipped.
 *
 * @param {string} dirAbs
 * @param {string} prefix "YYYY-MM-DD HHmm"
 * @param {string} sessionId
 * @returns {Promise<string|null>} file name
 */
export async function findSessionNote(dirAbs, prefix, sessionId) {
  let names;
  try {
    names = await fs.readdir(dirAbs);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const start = `${prefix} `;
  const candidates = names.filter((n) => n.startsWith(start) && n.endsWith(".md")).sort();
  const buf = Buffer.alloc(HEAD_BYTES);
  for (const name of candidates) {
    let handle;
    try {
      handle = await fs.open(path.join(dirAbs, name), "r");
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      if (sessionFromHead(buf.toString("utf8", 0, bytesRead)) === sessionId) return name;
    } catch {
      // unreadable candidate: not this session's note
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}
