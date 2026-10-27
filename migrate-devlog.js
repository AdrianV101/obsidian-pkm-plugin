// `obsidian-pkm migrate-devlog <project> [--apply]`: splits a project's
// single-file devlog into one note per day and turns devlog.md into a hub.
// The slash command runs the plugin's own copy, which has no node_modules, so
// this module and everything it imports use only relative and node: specifiers.

import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { devlogFolder, dayNoteName, parseDevlog } from "./devlog.js";
import { splitFrontmatter, parseHeadings } from "./markdown.js";

const USAGE = "Usage: obsidian-pkm [init | doctor | migrate-devlog <project> [--apply]]";
const PREVIEW_END = "Preview only; nothing was written. Run with --apply to migrate.";
const KEPT_HEADING = "## Kept from the old devlog";
const FOLDER_VARIABLE = "<% devlog_folder %>";
const HUB_TEMPLATE = fileURLToPath(new URL("./templates/devlog.md", import.meta.url));
const STYLES = [["h3", "### dated"], ["day", "## day sections"], ["h2", "## dated"]];
const SESSIONS = /^sessions$/i;
// A project value outside PLAIN_VALUE, or a YAML keyword, is double-quoted so
// YAML reads it back as the same string.
const PLAIN_VALUE = /^[\p{L}_][\p{L}\p{N} _.-]*$/u;
const YAML_KEYWORD = /^(?:true|false|yes|no|on|off|y|n|null)$/i;

/**
 * @typedef {(line: string) => void} Print
 * @typedef {"read-back" | "source-check" | "hub-write"} Checkpoint
 *   read-back: the day notes are written; source-check: before devlog.md is re-read;
 *   hub-write: the hub file exists but holds nothing yet
 * @typedef {{
 *   env?: Record<string, string|undefined>,
 *   stdout?: { write(text: string): unknown },
 *   stderr?: { write(text: string): unknown },
 *   now?: Date|number|string,
 *   checkpoint?: (step: Checkpoint) => unknown,
 * }} MigrateOptions checkpoint is a test seam, awaited at each named step of an apply
 * @typedef {{ rel: string, date: string, content: string }} DayNote
 */

/**
 * @param {string[]} args the arguments after `migrate-devlog`
 * @param {MigrateOptions} [options]
 * @returns {Promise<number>} 0 done, previewed or nothing to do; 1 blocker or failure; 2 usage error
 */
export async function runMigrateDevlog(args, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  /** @type {Print} */
  const out = (line) => { stdout.write(`${line}\n`); };
  /** @type {Print} */
  const err = (line) => { stderr.write(`${line}\n`); };

  const parsedArgs = parseArgs(args);
  if ("error" in parsedArgs) {
    err(parsedArgs.error);
    err(USAGE);
    return 2;
  }
  const vaultPath = env.VAULT_PATH;
  if (typeof vaultPath !== "string" || vaultPath === "" || vaultPath.includes("${")) {
    err("VAULT_PATH is not set; set it to your vault's folder.");
    return 2;
  }
  const project = resolveProject(vaultPath, parsedArgs.project);
  if ("error" in project) {
    err(project.error);
    err(USAGE);
    return 2;
  }

  const ctx = {
    vaultPath,
    abs: (rel) => path.join(vaultPath, ...rel.split("/")),
    now: new Date(options.now ?? Date.now()),
    checkpoint: options.checkpoint ?? (() => {}),
    out,
    err,
  };

  let plan;
  try {
    plan = await buildPlan(ctx, project);
  } catch (e) {
    err(`Migration failed: ${e.message}`);
    return 1;
  }
  if (plan.kind === "nothing") {
    out(`Nothing to migrate: ${plan.reason}`);
    return 0;
  }
  if (plan.kind === "blocked") {
    out(`Blocker: ${plan.reason}`);
    return 1;
  }

  if (!parsedArgs.apply) {
    printPreview(plan, out);
    return plan.blockers.length > 0 ? 1 : 0;
  }
  if (plan.blockers.length > 0) {
    for (const reason of plan.blockers) out(`Blocker: ${reason}`);
    out("Stopped before writing; nothing was changed.");
    return 1;
  }
  return applyPlan(ctx, plan);
}

/**
 * @param {string[]} args
 * @returns {{ project: string, apply: boolean } | { error: string }}
 */
function parseArgs(args) {
  let project = null;
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply") {
      if (apply) return { error: "--apply is given twice" };
      apply = true;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else if (project !== null) {
      return { error: `Unexpected argument: ${arg}` };
    } else {
      project = arg;
    }
  }
  if (project === null || project.trim() === "") return { error: "Missing <project>" };
  return { project, apply };
}

/**
 * A name is a folder under 01-Projects; anything containing "/" is a vault-relative path.
 *
 * @param {string} vaultPath
 * @param {string} arg
 * @returns {{ projectPath: string } | { error: string }}
 */
function resolveProject(vaultPath, arg) {
  const projectPath = arg.includes("/") ? arg.replace(/\/+$/, "") : `01-Projects/${arg}`;
  const segments = projectPath.split("/");
  const invalid = { error: `Not a project folder name or vault-relative path: ${arg}` };
  if (/^[A-Za-z]:/.test(projectPath) || segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) {
    return invalid;
  }
  const relative = path.relative(vaultPath, path.join(vaultPath, ...segments));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return invalid;
  return { projectPath };
}

/** @param {string} value */
function yamlString(value) {
  return PLAIN_VALUE.test(value) && !value.endsWith(" ") && !YAML_KEYWORD.test(value) ? value : JSON.stringify(value);
}

/** @param {Date} d */
function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {string} abs */
async function lstatOrNull(abs) {
  try {
    return await fs.lstat(abs);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}

/**
 * Each segment of an existing path as its parent folder lists it. A
 * case- or Unicode-form-insensitive filesystem finds the folder under the typed
 * spelling, but the names, properties and hub filter must carry the real one.
 *
 * @param {string} vaultPath
 * @param {string[]} segments
 * @returns {Promise<string[]>}
 */
async function onDiskSegments(vaultPath, segments) {
  const fold = (s) => s.normalize("NFC").toLowerCase();
  const resolved = [];
  for (const segment of segments) {
    const names = await fs.readdir(path.join(vaultPath, ...resolved));
    const matches = names.includes(segment) ? [segment] : names.filter((n) => fold(n) === fold(segment));
    resolved.push(matches.length === 1 ? matches[0] : segment);
  }
  return resolved;
}

/**
 * Reads and parses the devlog and builds every file the migration would write.
 *
 * @param {{ vaultPath: string, abs: (rel: string) => string, now: Date }} ctx
 * @param {{ projectPath: string }} project
 */
async function buildPlan(ctx, { projectPath: typedPath }) {
  const folderStat = await lstatOrNull(ctx.abs(typedPath));
  if (!folderStat?.isDirectory()) return { kind: "blocked", reason: `project folder ${typedPath} does not exist` };
  const segments = await onDiskSegments(ctx.vaultPath, typedPath.split("/"));
  const projectPath = segments.join("/");
  const name = segments[segments.length - 1];

  const devlogRel = `${projectPath}/development/devlog.md`;
  let raw;
  try {
    raw = await fs.readFile(ctx.abs(devlogRel));
  } catch (e) {
    if (e.code === "ENOENT") return { kind: "nothing", reason: `${devlogRel} does not exist` };
    throw e;
  }
  const content = raw.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(raw)) {
    return { kind: "blocked", reason: `${devlogRel} is not valid UTF-8, so its bytes could not be kept exactly` };
  }

  const parsed = parseDevlog(content);
  // Only a base block outside entries marks a hub; an entry may quote one.
  const isHub = parsed.kept.some(({ start, end }) =>
    content.slice(start, end).split("\n").some((line) => line.replace(/\r$/, "") === "```base"),
  );
  if (isHub && parsed.entries.length === 0) return { kind: "nothing", reason: `${devlogRel} is already a hub` };

  const firstNl = content.indexOf("\n");
  const eol = firstNl > 0 && content[firstNl - 1] === "\r" ? "\r\n" : "\n";
  const folderRel = devlogFolder(projectPath);

  /** @type {Map<string, string>} */
  const bodies = new Map();
  for (const e of parsed.entries) bodies.set(e.date, (bodies.get(e.date) ?? "") + content.slice(e.start, e.end));
  /** @type {DayNote[]} */
  const notes = [...bodies.keys()].sort().map((date) => ({
    rel: `${folderRel}/${dayNoteName(date, name)}`,
    date,
    content:
      ["---", "type: devlog-day", `project: ${yamlString(name)}`, `created: ${date}`, "tags:", "  - devlog", "---", "", ""].join(eol) +
      bodies.get(date),
  }));

  const hub = isHub
    ? hubFromHub(content, parsed)
    : await freshHub(content, parsed, { eol, folderRel, name, today: localDate(ctx.now) });

  const blockers = [];
  for (const note of notes) {
    if (await lstatOrNull(ctx.abs(note.rel))) {
      blockers.push(`${note.rel} already exists; move that date's entries from devlog.md into it by hand, or rename it, then run again`);
    }
  }

  return { kind: "migrate", devlogRel, folderRel, raw, content, parsed, isHub, notes, hub, blockers };
}

/**
 * The hub for a devlog that is not one yet: its frontmatter (or fresh
 * frontmatter), the bundled hub body, then the kept text.
 */
async function freshHub(content, parsed, { eol, folderRel, name, today }) {
  let frontmatter;
  if (parsed.frontmatter) {
    frontmatter = content.slice(parsed.frontmatter.start, parsed.frontmatter.end);
    if (!frontmatter.endsWith("\n")) frontmatter += eol;
  } else {
    frontmatter = ["---", "type: devlog", `project: ${yamlString(name)}`, `created: ${today}`, "tags:", "  - devlog", "---", ""].join(eol);
  }
  // A Windows checkout may hold the template with CRLF.
  const template = (await fs.readFile(HUB_TEMPLATE, "utf8")).replace(/\r\n/g, "\n");
  let hub = frontmatter + splitFrontmatter(template).body.replaceAll(FOLDER_VARIABLE, folderRel).replaceAll("\n", eol);
  if (parsed.kept.length > 0) {
    // Kept blocks were separated by dropped lines in the source; a blank line keeps them apart.
    const blocks = parsed.kept.map(({ start, end }) => content.slice(start, end));
    let kept = "";
    for (const block of blocks) {
      if (kept !== "") kept += kept.endsWith("\n") ? eol : eol + eol;
      kept += block;
    }
    hub += eol + KEPT_HEADING + eol + eol + kept;
  }
  return hub;
}

/** A hub that an older plugin appended entries to keeps everything but those entries and `## Sessions` lines. */
function hubFromHub(content, parsed) {
  const base = content.startsWith("\uFEFF") ? 1 : 0;
  const removed = parsed.entries.map(({ start, end }) => ({ start, end }));
  for (const h of parseHeadings(content.slice(base))) {
    if (h.level === 2 && SESSIONS.test(h.text)) removed.push({ start: base + h.offset, end: base + h.lineEnd });
  }
  removed.sort((a, b) => a.start - b.start);
  let hub = "";
  let pos = 0;
  for (const { start, end } of removed) {
    hub += content.slice(pos, start);
    pos = end;
  }
  return hub + content.slice(pos);
}

/** 1-based line numbers of `offsets` (ascending) in `content`. */
function lineNumbers(content, offsets) {
  const lines = [];
  let line = 1;
  let pos = 0;
  for (const offset of offsets) {
    for (let nl = content.indexOf("\n", pos); nl !== -1 && nl < offset; nl = content.indexOf("\n", nl + 1)) {
      line++;
      pos = nl + 1;
    }
    lines.push(line);
  }
  return lines;
}

/** @param {Print} out */
function printPreview(plan, out) {
  const { parsed, content, notes } = plan;
  out(`Devlog: ${plan.devlogRel}${plan.isHub ? " (already a hub; the old-style entries in it move out)" : ""}`);
  const counts = STYLES.map(([style, label]) => `${label}: ${parsed.entries.filter((e) => e.style === style).length}`);
  out(`Entries: ${parsed.entries.length} (${counts.join(", ")})`);
  if (notes.length === 0) {
    out("Day notes: 0");
  } else {
    let largest = notes[0];
    let largestBytes = Buffer.byteLength(largest.content);
    for (const note of notes) {
      const bytes = Buffer.byteLength(note.content);
      if (bytes > largestBytes) [largest, largestBytes] = [note, bytes];
    }
    const largestName = largest.rel.slice(plan.folderRel.length + 1);
    out(
      `Day notes: ${notes.length} in ${plan.folderRel}, ${notes[0].date} to ${notes[notes.length - 1].date}; ` +
        `largest ${largestName} (${largestBytes} bytes)`,
    );
  }
  if (plan.isHub) {
    out("Kept text: the hub keeps everything outside its entries");
  } else if (parsed.kept.length === 0) {
    out("Kept text: none");
  } else {
    const chars = parsed.kept.reduce((n, { start, end }) => n + [...content.slice(start, end)].length, 0);
    const lines = lineNumbers(content, parsed.kept.map((r) => r.start));
    const blocks = parsed.kept.length === 1 ? "1 block" : `${parsed.kept.length} blocks`;
    out(`Kept text: ${blocks}, ${chars} characters, starting at lines ${lines.join(", ")}`);
  }
  for (const reason of plan.blockers) out(`Blocker: ${reason}`);
  out(PREVIEW_END);
}

/**
 * Creates `abs` exclusively; `onCreated` runs once the file exists, before its content is written.
 *
 * @param {string} abs
 * @param {string} data
 * @param {() => unknown} onCreated
 */
async function createFile(abs, data, onCreated) {
  const handle = await fs.open(abs, "wx");
  try {
    await onCreated();
    await handle.writeFile(data, "utf8");
  } finally {
    await handle.close();
  }
}

/** Directories from `first` (the one `mkdir -p` reported creating) down to `last`, deepest first. */
function createdDirs(first, last) {
  if (first === undefined) return [];
  const dirs = [];
  for (let dir = last; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === first || path.dirname(dir) === dir) return dirs;
  }
}

function trashTimestamp(now) {
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function applyPlan(ctx, plan) {
  const { abs, checkpoint, out, err } = ctx;
  const { devlogRel, folderRel } = plan;
  const done = { folderCreated: false, notes: [], trashDirs: [], trashRel: null, hubCreated: false };
  let step = "";
  try {
    step = `creating ${folderRel}`;
    done.folderCreated = (await fs.mkdir(abs(folderRel), { recursive: true })) !== undefined;

    for (const note of plan.notes) {
      step = `writing ${note.rel}`;
      await createFile(abs(note.rel), note.content, () => { done.notes.push(note.rel); });
    }
    await checkpoint("read-back");
    for (const note of plan.notes) {
      step = `checking ${note.rel}`;
      if ((await fs.readFile(abs(note.rel), "utf8")) !== note.content) throw new Error("it does not match what was written");
    }

    step = `checking ${devlogRel}`;
    await checkpoint("source-check");
    if (!(await fs.readFile(abs(devlogRel))).equals(plan.raw)) throw new Error("it changed since it was read");

    step = `moving ${devlogRel} to .trash`;
    let trashRel = `.trash/${devlogRel}`;
    if (await lstatOrNull(abs(trashRel))) {
      trashRel = `.trash/${devlogRel.slice(0, -".md".length)}.${trashTimestamp(ctx.now)}.md`;
      // rename would replace an earlier trashed copy.
      if (await lstatOrNull(abs(trashRel))) throw new Error(`${trashRel} already exists`);
    }
    const trashDir = path.dirname(abs(trashRel));
    done.trashDirs = createdDirs(await fs.mkdir(trashDir, { recursive: true }), trashDir);
    await fs.rename(abs(devlogRel), abs(trashRel));
    done.trashRel = trashRel;

    step = `writing the hub ${devlogRel}`;
    await createFile(abs(devlogRel), plan.hub, async () => {
      done.hubCreated = true;
      await checkpoint("hub-write");
    });
  } catch (e) {
    err(`Migration failed while ${step}: ${e.message}`);
    const left = await restore(ctx, plan, done);
    if (left.length === 0) {
      err("Restored the starting state.");
    } else {
      err("Could not restore the starting state. Left behind:");
      for (const item of left) err(`- ${item}`);
    }
    return 1;
  }

  const count = plan.notes.length === 1 ? "1 day note" : `${plan.notes.length} day notes`;
  out(`Wrote ${count} to ${folderRel}`);
  out(`Moved the old devlog to ${done.trashRel}`);
  out(`Wrote the hub at ${devlogRel}`);
  return 0;
}

/**
 * Undoes what an apply did, in the order that frees devlog.md first.
 *
 * @returns {Promise<string[]>} what could not be undone
 */
async function restore(ctx, plan, done) {
  const { abs, vaultPath } = ctx;
  const left = [];
  /** Removes a file or empty folder; one already gone counts as removed. */
  const remove = async (target, removeFn) => {
    try {
      await removeFn(target);
      return true;
    } catch (e) {
      return e.code === "ENOENT";
    }
  };
  const toRel = (dirAbs) => `${path.relative(vaultPath, dirAbs).split(path.sep).join("/")}/`;

  if (done.hubCreated && !(await remove(abs(plan.devlogRel), fs.unlink))) {
    left.push(`${plan.devlogRel} (the partly written hub)`);
  }
  let originalBack = true;
  if (done.trashRel) {
    try {
      // rename would replace whatever now sits at devlog.md.
      if (await lstatOrNull(abs(plan.devlogRel))) throw new Error("devlog.md is taken");
      await fs.rename(abs(done.trashRel), abs(plan.devlogRel));
    } catch {
      left.push(`${done.trashRel} (the original devlog; move it back to ${plan.devlogRel})`);
      originalBack = false;
    }
  }
  if (originalBack) {
    for (const dir of done.trashDirs) if (!(await remove(dir, fs.rmdir))) left.push(toRel(dir));
  }
  for (const rel of done.notes) if (!(await remove(abs(rel), fs.unlink))) left.push(rel);
  if (done.folderCreated && !(await remove(abs(plan.folderRel), fs.rmdir))) left.push(`${plan.folderRel}/`);
  return left;
}
