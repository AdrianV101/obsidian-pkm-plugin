// IMPORTANT: Hooks run via raw `node` from the installed plugin directory,
// which has no node_modules. Only relative and node: imports are allowed here,
// and ../markdown.js is dependency-free for that reason.
import fs from "node:fs/promises";
import path from "node:path";
import { splitFrontmatter, parseHeadings, sectionRange } from "../markdown.js";

export const CONTEXT_BUDGET = 8000, INDEX_BUDGET = 2500, ENTRY_BUDGET = 1500, MAX_TASKS = 10, COMPACT_BUDGET = 1500;

const MAX_TITLE_CHARS = 150;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{1,2}):(\d{2}))?/;
const STATUS_RANK = { active: 0, pending: 1 };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const INDEX_FIRST = ["overview", "current status"];
const INDEX_SKIP = new Set(["key links", "related"]);

/** "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" from the start of a heading, else null. Sorts as a string. */
function headingDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  return m[2] === undefined ? m[1] : `${m[1]} ${m[2].padStart(2, "0")}:${m[3]}`;
}

/** Cut `text` at a line boundary so the result, marker included, fits `budget`. */
function truncateAtLine(text, budget, marker) {
  if (text.length <= budget) return text;
  const room = budget - marker.length - 1;
  if (room <= 0) return marker.length <= budget ? marker : "";
  let cut = text.lastIndexOf("\n", room);
  if (cut <= 0) cut = room;
  return text.slice(0, cut).trimEnd() + "\n" + marker;
}

/**
 * The newest devlog entries, newest first. Entries are level-3 headings inside a
 * `## Sessions` section or inside a dated `## YYYY-MM-DD` day section, and level-2
 * headings elsewhere; a dated day section without dated level-3 children is itself
 * an entry. Entries are ranked by the date (and time) at the start of the heading,
 * whatever order the file is in; for equal dates the one later in the file wins.
 * Without any dated entry: the first n entries under `## Sessions`, else the last n
 * level-2 sections.
 * @param {string} devlogContent
 * @param {number} [n=3]
 * @returns {string[]} entry texts (heading line through the end of its section)
 */
export function selectRecentEntries(devlogContent, n = 3) {
  const headings = parseHeadings(devlogContent);
  const dated = [];
  const sessionEntries = [];
  const level2 = [];
  let hasSessions = false;
  let parent = null;

  for (const h of headings) {
    if (h.level === 1) {
      parent = null;
    } else if (h.level === 2) {
      level2.push(h);
      const date = headingDate(h.text);
      if (/^sessions$/i.test(h.text)) {
        hasSessions = true;
        parent = { kind: "sessions" };
      } else if (date) {
        const entry = { heading: h, key: date, container: false };
        dated.push(entry);
        parent = { kind: "day", entry };
      } else {
        parent = { kind: "other" };
      }
    } else if (h.level === 3 && parent && parent.kind !== "other") {
      if (parent.kind === "sessions") sessionEntries.push(h);
      const date = headingDate(h.text);
      if (!date) continue;
      if (parent.kind === "day") parent.entry.container = true;
      dated.push({ heading: h, key: date, container: false });
    }
  }

  let chosen;
  const entries = dated.filter(e => !e.container);
  if (entries.length > 0) {
    entries.sort((a, b) => (a.key === b.key ? b.heading.offset - a.heading.offset : a.key < b.key ? 1 : -1));
    chosen = entries.slice(0, n).map(e => e.heading);
  } else if (hasSessions) {
    chosen = sessionEntries.slice(0, n);
  } else {
    chosen = level2.slice(-n).reverse();
  }

  return chosen.map(h => {
    const { headingStart, sectionEnd } = sectionRange(devlogContent, headings, h);
    return devlogContent.slice(headingStart, sectionEnd).trim();
  });
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

/** Scalar `key: value` lines only; enough for status/priority/due. */
function parseSimpleFrontmatter(text) {
  const fm = {};
  if (!text) return fm;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!m) continue;
    let value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (value === "" || value === "null" || value === "~") value = null;
    fm[m[1]] = value;
  }
  return fm;
}

function compareTasks(a, b) {
  return (STATUS_RANK[a.status] - STATUS_RANK[b.status])
    || ((PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal) - (PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal))
    || (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1)
    || a.title.localeCompare(b.title);
}

/** Open (active/pending) tasks in display order. */
async function loadTasks(projectDir) {
  const taskDir = path.join(projectDir, "tasks");
  let names;
  try {
    names = (await fs.readdir(taskDir)).filter(name => name.endsWith(".md")).sort();
  } catch (e) {
    if (e.code !== "ENOENT") console.error("PKM load-context: error reading tasks:", e.message);
    return [];
  }

  const tasks = [];
  for (const name of names) {
    let content;
    try {
      content = await fs.readFile(path.join(taskDir, name), "utf-8");
    } catch (e) {
      console.error(`PKM load-context: error reading task ${name}:`, e.message);
      continue;
    }
    const { frontmatterText, body } = splitFrontmatter(content);
    const fm = parseSimpleFrontmatter(frontmatterText);
    if (fm.status !== "active" && fm.status !== "pending") continue;
    const titleLine = body.split("\n").find(l => l.startsWith("# "));
    const title = (titleLine ? titleLine.slice(2).trim() : name.slice(0, -3)).slice(0, MAX_TITLE_CHARS);
    const priority = (fm.priority ?? "normal").toLowerCase();
    const due = /^\d{4}-\d{2}-\d{2}/.test(fm.due ?? "") ? fm.due.slice(0, 10) : null;
    tasks.push({ title, status: fm.status, priority, due });
  }
  return tasks.sort(compareTasks);
}

function taskLines(tasks, taskFolder, format) {
  const lines = tasks.slice(0, MAX_TASKS).map(format);
  if (tasks.length > MAX_TASKS) {
    lines.push(`+${tasks.length - MAX_TASKS} more (vault_query type: "task", folder: "${taskFolder}")`);
  }
  return lines;
}

function assembleContext({ projectName, indexText, indexRel, devlogText, devlogRel, tasksText }) {
  const build = (index, devlog) => [
    `## PKM Project Context: ${projectName}`,
    index === null ? null : `### Project Index\n${index}`,
    devlog === null ? null : `### Recent Development Activity\n${devlog}`,
    `### Active Tasks\n${tasksText}`,
  ].filter(s => s !== null).join("\n\n");

  // Over budget: trim the devlog first, then the index.
  let index = indexText;
  let devlog = devlogText;
  let over = build(index, devlog).length - CONTEXT_BUDGET;
  if (over > 0 && devlog !== null) {
    devlog = truncateAtLine(devlog, Math.max(0, devlog.length - over), `[truncated — vault_read ${devlogRel}]`);
    over = build(index, devlog).length - CONTEXT_BUDGET;
  }
  if (over > 0 && index !== null) {
    index = truncateAtLine(index, Math.max(0, index.length - over), `[truncated — vault_read ${indexRel}]`);
  }
  return truncateAtLine(build(index, devlog), CONTEXT_BUDGET, "[truncated]");
}

/**
 * Session-start context for a vault project, capped at CONTEXT_BUDGET characters
 * (COMPACT_BUDGET for source "compact").
 * @param {string} vaultPath
 * @param {string} projectPath - vault-relative project folder, "/"-separated
 * @param {{ source?: string }} [opts] - SessionStart hook `source` (startup|resume|clear|compact)
 * @returns {Promise<{ context: string, meta: { index: boolean, devlog: boolean, tasks: number, source: string } }>}
 */
export async function loadProjectContext(vaultPath, projectPath, { source = "startup" } = {}) {
  const projectName = path.basename(projectPath);
  const projectDir = path.join(vaultPath, projectPath);
  const meta = { index: false, devlog: false, tasks: 0, source };
  const taskFolder = `${projectPath}/tasks`;

  const tasks = await loadTasks(projectDir);
  meta.tasks = tasks.length;

  if (source === "compact") {
    const lines = [
      `## PKM Project Context: ${projectName} (compact)`,
      `Project: ${projectPath}`,
      "### Active Tasks",
      ...(tasks.length > 0 ? taskLines(tasks, taskFolder, t => `- ${t.title}`) : ["No active tasks"]),
    ];
    return { context: truncateAtLine(lines.join("\n"), COMPACT_BUDGET, "[truncated]"), meta };
  }

  const indexRel = `${projectPath}/_index.md`;
  let indexText = null;
  try {
    indexText = buildIndexText(await fs.readFile(path.join(projectDir, "_index.md"), "utf-8"), indexRel);
    meta.index = true;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("PKM load-context: error reading _index.md:", e.message);
  }

  const devlogRel = `${projectPath}/development/devlog.md`;
  let devlogText = null;
  try {
    const devlog = await fs.readFile(path.join(projectDir, "development", "devlog.md"), "utf-8");
    const marker = `[truncated — vault_read ${devlogRel}]`;
    const entries = selectRecentEntries(devlog).map(entry => truncateAtLine(entry, ENTRY_BUDGET, marker));
    devlogText = entries.length > 0 ? entries.join("\n\n") : "No devlog entries found.";
    meta.devlog = true;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("PKM load-context: error reading devlog:", e.message);
  }

  const tasksText = tasks.length > 0
    ? taskLines(tasks, taskFolder, t => `- ${t.title} (status: ${t.status}, priority: ${t.priority})`).join("\n")
    : "No active tasks";

  const context = assembleContext({ projectName, indexText, indexRel, devlogText, devlogRel, tasksText });
  return { context, meta };
}
