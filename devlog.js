// Naming, listing and session-note lookup for per-session devlog notes, and
// the parser that splits a single-file devlog into its entries.
// Hooks run from the plugin cache, which has no node_modules, so this module
// must stay dependency-free (relative and node: imports only).

import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { splitFrontmatter, parseHeadings } from "./markdown.js";

/** Upper bound on the bytes read from a candidate note when looking up its session. */
const HEAD_BYTES = 4096;

const SESSION_NAME = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3])([0-5]\d) (.+)\.md$/;
const DAY_NAME = /^(\d{4}-\d{2}-\d{2}) (.+) devlog\.md$/;
const ENTRY_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{1,2}):(\d{2}))?/;
const SESSIONS = /^sessions$/i;
/** The intro line of the old devlog template; dropped outside entries. */
const INTRO_SENTENCE = "This log tracks development progress, decisions made, and lessons learned.";

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

/**
 * @typedef {{ start: number, end: number }} Range offsets into the content, end exclusive
 * @typedef {Range & { date: string, time: string|null, key: string, heading: string, style: "h3"|"day"|"h2" }} DevlogEntry
 * @typedef {{ frontmatter: Range|null, entries: DevlogEntry[], kept: Range[], scaffolding: Range[] }} ParsedDevlog
 */

/**
 * Splits a single-file devlog into entries, kept text and scaffolding. Every
 * character of `content` falls in exactly one range, so callers can move text
 * byte for byte.
 *
 * An entry starts at a `##` or `###` heading (outside code) whose text starts
 * with YYYY-MM-DD and runs to the next entry heading or the next undated `#` or
 * `##` heading. An undated `##` section other than `## Sessions` is kept whole.
 * The rest (the preamble, `## Sessions` and `#` sections) is split by line:
 * blank and `---` lines, `#` headings, `## Sessions` and the template intro
 * sentence are scaffolding, any other line is kept. A leading BOM is its own
 * scaffolding range.
 *
 * @param {string} content
 * @returns {ParsedDevlog}
 */
export function parseDevlog(content) {
  /** @type {ParsedDevlog} */
  const parsed = { frontmatter: null, entries: [], kept: [], scaffolding: [] };
  // splitFrontmatter and parseHeadings do not skip a BOM, so parse after it.
  const base = content.startsWith("\uFEFF") ? 1 : 0;
  if (base) parsed.scaffolding.push({ start: 0, end: 1 });
  const text = base ? content.slice(1) : content;
  const { frontmatterText, bodyOffset } = splitFrontmatter(text);
  if (frontmatterText !== null) parsed.frontmatter = { start: base, end: base + bodyOffset };

  /** `#` and `## Sessions` heading lines: scaffolding where a region is split by line, kept inside an entry. */
  const droppedHeadings = new Set();
  /** @type {Array<{ offset: number, entry?: Omit<DevlogEntry, "start"|"end">, whole?: boolean }>} */
  const starts = [];
  for (const h of parseHeadings(text)) {
    const offset = base + h.offset;
    const m = h.level === 2 || h.level === 3 ? ENTRY_DATE.exec(h.text) : null;
    if (m) {
      const date = m[1];
      const time = m[2] === undefined ? null : `${m[2].padStart(2, "0")}:${m[3]}`;
      /** @type {DevlogEntry["style"]} */
      const style = h.level === 3 ? "h3" : h.text === date ? "day" : "h2";
      starts.push({ offset, entry: { date, time, key: `${date} ${time ?? "00:00"}`, heading: h.text, style } });
    } else if (h.level === 1) {
      droppedHeadings.add(offset);
      if (!ENTRY_DATE.test(h.text)) starts.push({ offset });
    } else if (h.level === 2) {
      const sessions = SESSIONS.test(h.text);
      if (sessions) droppedHeadings.add(offset);
      starts.push({ offset, whole: !sessions });
    }
  }

  let region = { offset: base + bodyOffset };
  for (const next of [...starts, { offset: content.length }]) {
    const start = region.offset;
    const end = next.offset;
    if (end > start) {
      if (region.entry) parsed.entries.push({ start, end, ...region.entry });
      else if (region.whole) parsed.kept.push({ start, end });
      else splitLines(content, start, end, droppedHeadings, parsed);
    }
    region = next;
  }
  return parsed;
}

/**
 * Adds each line of [start, end) to kept or scaffolding, merging runs of the same kind.
 *
 * @param {string} content
 * @param {number} start
 * @param {number} end
 * @param {Set<number>} droppedHeadings
 * @param {ParsedDevlog} parsed
 */
function splitLines(content, start, end, droppedHeadings, parsed) {
  let previous = null;
  for (let pos = start; pos < end; ) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 || nl >= end ? end : nl + 1;
    const line = content.slice(pos, lineEnd).trim();
    const target =
      line === "" || line === "---" || line === INTRO_SENTENCE || droppedHeadings.has(pos)
        ? parsed.scaffolding
        : parsed.kept;
    if (target === previous) target[target.length - 1].end = lineEnd;
    else target.push({ start: pos, end: lineEnd });
    previous = target;
    pos = lineEnd;
  }
}
