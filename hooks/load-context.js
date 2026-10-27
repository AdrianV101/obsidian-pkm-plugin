// IMPORTANT: Hooks run via raw `node` from the installed plugin directory,
// which has no node_modules. Only relative and node: imports are allowed here,
// and ../markdown.js is dependency-free for that reason.
import fs from "node:fs/promises";
import path from "node:path";
import { splitFrontmatter, parseHeadings } from "../markdown.js";
import { devlogFolder, listDevlogNotes, parseDevlog } from "../devlog.js";

// Claude Code caps a hook's additionalContext at 10,000 characters.
export const CONTEXT_BUDGET = 9500, INDEX_BUDGET = 2500, COMPACT_BUDGET = 1500;

const MAX_ITEMS = 10;
const INDEX_FIRST = ["overview", "current status"];
const INDEX_SKIP = new Set(["key links", "related"]);

/**
 * Cut `text` so the result, marker included, fits `budget`: at a line boundary, or, when the
 * last one is in the first half of the room (a long paragraph), at the last space before the
 * budget, so the paragraph is not lost.
 */
function truncateAtLine(text, budget, marker) {
  if (text.length <= budget) return text;
  const room = budget - marker.length - 1;
  if (room <= 0) return marker.length <= budget ? marker : "";
  let cut = text.lastIndexOf("\n", room);
  if (cut < room / 2) {
    const space = text.lastIndexOf(" ", room);
    cut = space >= room / 2 ? space : room;
    // Never split a surrogate pair.
    const before = text.charCodeAt(cut - 1);
    if (before >= 0xD800 && before <= 0xDBFF) cut--;
  }
  return text.slice(0, cut).trimEnd() + "\n" + marker;
}

/** Overview and Current Status first, Key Links and Related dropped, capped at INDEX_BUDGET. */
function buildIndexText(content, relPath) {
  const { bodyOffset } = splitFrontmatter(content);
  const segments = [];
  let start = bodyOffset;
  let name = null;
  for (const h of parseHeadings(content)) {
    if (h.level > 2) continue;
    segments.push({ name, text: content.slice(start, h.offset) });
    start = h.offset;
    name = h.level === 2 ? h.text.trim().toLowerCase() : null;
  }
  segments.push({ name, text: content.slice(start) });

  const first = INDEX_FIRST.flatMap(n => segments.filter(s => s.name === n));
  const rest = segments.filter(s => !INDEX_FIRST.includes(s.name) && !INDEX_SKIP.has(s.name));
  const text = [...first, ...rest].map(s => s.text.trim()).filter(Boolean).join("\n\n");
  return truncateAtLine(text || "(empty)", INDEX_BUDGET, `[truncated — vault_read ${relPath}]`);
}

/** Entries with text after their heading line; a day heading that only groups dated children is not one. */
function contentEntries(content, entries) {
  return entries.filter(e => content.slice(e.start, e.end).replace(/^[^\n]*/, "").trim() !== "");
}

/** A session section: heading line, Summary and Next steps; the whole section when either is missing. */
function renderSessionSection(text) {
  const headings = parseHeadings(text).filter(h => h.level <= 3);
  const find = (name) => {
    const i = headings.findIndex(h => h.level === 3 && h.text.trim().toLowerCase() === name);
    if (i === -1) return null;
    return text.slice(headings[i].offset, headings[i + 1]?.offset ?? text.length).trim();
  };
  const summary = find("summary");
  const next = find("next steps");
  if (summary === null || next === null) return text.trim();
  return [text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n")).trim(), summary, next].join("\n\n");
}

/** The text shown for a listed note, or null when it has no entry. */
async function renderNote(dirAbs, note) {
  const content = await fs.readFile(path.join(dirAbs, note.name), "utf-8");
  const entries = contentEntries(content, parseDevlog(content).entries);
  if (entries.length === 0) return null;
  if (note.kind === "day") return content.slice(entries[0].start, entries[0].end).trim();
  const last = entries[entries.length - 1];
  return renderSessionSection(content.slice(last.start, last.end));
}

/** Entries of an unmigrated devlog.md as candidates; none for a missing file or a hub. */
async function loadLegacyEntries(projectDir, projectPath) {
  let content;
  try {
    content = await fs.readFile(path.join(projectDir, "development", "devlog.md"), "utf-8");
  } catch (e) {
    if (e.code !== "ENOENT") console.error("PKM load-context: error reading devlog.md:", e.message);
    return [];
  }
  const vaultRel = `${projectPath}/development/devlog.md`;
  return contentEntries(content, parseDevlog(content).entries).map((e, index) => ({
    key: e.key,
    index,
    label: `devlog.md: ${e.heading}`,
    vaultRel,
    legacy: true,
    render: async () => content.slice(e.start, e.end).trim(),
  }));
}

/** Notes and legacy entries merged newest first; on equal keys a note precedes an entry, a later entry an earlier one. */
function mergeCandidates(notes, legacy, dirAbs, folder) {
  const noteItems = notes.map(n => ({
    key: n.key,
    label: n.name.replace(/\.md$/, ""),
    vaultRel: `${folder}/${n.name}`,
    render: () => renderNote(dirAbs, n),
  }));
  const entries = [...legacy].sort((a, b) => (a.key !== b.key ? (a.key < b.key ? 1 : -1) : b.index - a.index));
  const merged = [];
  let i = 0, j = 0;
  while (i < noteItems.length || j < entries.length) {
    if (j >= entries.length || (i < noteItems.length && noteItems[i].key >= entries[j].key)) merged.push(noteItems[i++]);
    else merged.push(entries[j++]);
  }
  return merged;
}

async function listNotes(dirAbs) {
  try {
    return await listDevlogNotes(dirAbs);
  } catch (e) {
    console.error("PKM load-context: error listing the devlog folder:", e.message);
    return [];
  }
}

/** Renders up to MAX_ITEMS items, each getting an equal share of what is left of `room`. */
async function renderItems(candidates, room) {
  const items = [];
  let remaining = room;
  for (let i = 0; i < candidates.length && items.length < MAX_ITEMS; i++) {
    const c = candidates[i];
    let body;
    try {
      body = await c.render();
    } catch (e) {
      console.error(`PKM load-context: error reading ${c.label}:`, e.message);
      continue;
    }
    if (body === null) continue;
    const separator = items.length === 0 ? 0 : 2;
    const itemsLeft = Math.min(MAX_ITEMS - items.length, candidates.length - i);
    const share = Math.floor(remaining / itemsLeft) - separator;
    const text = truncateAtLine(`#### ${c.label}\n${body}`, share, `[truncated — vault_read ${c.vaultRel}]`);
    items.push(text);
    remaining -= text.length + separator;
  }
  return items;
}

/**
 * Session-start context for a vault project, capped at CONTEXT_BUDGET characters
 * (COMPACT_BUDGET for source "compact").
 * @param {string} vaultPath
 * @param {string} projectPath - vault-relative project folder, "/"-separated
 * @param {{ source?: string }} [opts] - SessionStart hook `source` (startup|resume|clear|compact)
 * @returns {Promise<{ context: string, meta: { index: boolean, devlog: number, source: string } }>}
 */
export async function loadProjectContext(vaultPath, projectPath, { source = "startup" } = {}) {
  const projectDir = path.join(vaultPath, projectPath);
  const meta = { index: false, devlog: 0, source };
  const folder = devlogFolder(projectPath);
  const dirAbs = path.join(vaultPath, ...folder.split("/"));
  const candidates = mergeCandidates(await listNotes(dirAbs), await loadLegacyEntries(projectDir, projectPath), dirAbs, folder);

  if (source === "compact") {
    const shown = candidates.slice(0, MAX_ITEMS);
    meta.devlog = shown.length;
    const lines = [
      `## PKM Project Context: ${projectPath} (compact)`,
      "### Recent sessions",
      ...(shown.length > 0 ? shown.map(c => `- ${c.label}`) : ["No devlog entries found."]),
    ];
    return { context: truncateAtLine(lines.join("\n"), COMPACT_BUDGET, "[truncated]"), meta };
  }

  const indexRel = `${projectPath}/_index.md`;
  let indexSection = null;
  try {
    indexSection = `### Project Index\n${buildIndexText(await fs.readFile(path.join(projectDir, "_index.md"), "utf-8"), indexRel)}`;
    meta.index = true;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("PKM load-context: error reading _index.md:", e.message);
  }

  const head = [`## PKM Project Context: ${projectPath}`, indexSection, "### Recent Development Activity"]
    .filter(s => s !== null).join("\n\n") + "\n";
  const items = await renderItems(candidates, CONTEXT_BUDGET - head.length);
  meta.devlog = items.length;
  const context = head + (items.length > 0 ? items.join("\n\n") : "No devlog entries found.");
  return { context: truncateAtLine(context, CONTEXT_BUDGET, "[truncated]"), meta };
}
