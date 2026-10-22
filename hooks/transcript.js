// Condenses a Claude Code session transcript (JSONL) into a short digest of
// what was said and done. Dependency-free: hooks run without node_modules.

export const MAX_DELTA_CHARS = 40000;

const USER_TEXT_CAP = 2000;
const ASSISTANT_TEXT_CAP = 3000;
const BASH_PREVIEW_CAP = 120;
const ERROR_LINE_CAP = 300;
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Read", "NotebookEdit"]);

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseEntries(jsonlText) {
  const entries = [];
  for (const raw of jsonlText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(entry) && typeof entry.uuid === "string") entries.push(entry);
  }
  return entries;
}

function stamp(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function cap(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} [truncated ${text.length - limit} chars]`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function describeTool(name, input) {
  const args = isObject(input) ? input : {};
  if (name === "Bash") {
    const cmd = oneLine(args.command).slice(0, BASH_PREVIEW_CAP);
    return `  Bash: ${oneLine(args.description) || cmd}`;
  }
  if (FILE_TOOLS.has(name)) {
    return `  ${name}: ${args.file_path ?? args.notebook_path ?? args.path ?? ""}`.trimEnd();
  }
  if (name === "Agent" || name === "Task") {
    return `  ${name}: ${oneLine(args.description)}`.trimEnd();
  }
  if (name.startsWith("mcp__")) {
    const short = name.slice(name.lastIndexOf("__") + 2);
    return `  ${short}${typeof args.path === "string" ? ` ${args.path}` : ""}`;
  }
  return `  ${name}`;
}

/** Lines one entry contributes to the digest; empty when it contributes nothing. */
function entryLines(entry) {
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return [];
  const message = entry.message;
  if (!isObject(message)) return [];
  const when = stamp(entry.timestamp);

  if (entry.type === "user") {
    const out = [];
    const typed = !isObject(entry.origin) || entry.origin.kind === "human";
    if (!typed) return [];
    const body = textOf(message.content);
    if (body.trim()) out.push(`[${when}] User: ${cap(body, USER_TEXT_CAP)}`);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "tool_result" && block.is_error === true) {
          const first = textOf(block.content).split("\n")[0].trim();
          out.push(`  Error: ${first.slice(0, ERROR_LINE_CAP)}`);
        }
      }
    }
    return out;
  }

  if (entry.type === "assistant" && Array.isArray(message.content)) {
    const out = [];
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push(`[${when}] Claude: ${cap(block.text, ASSISTANT_TEXT_CAP)}`);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        out.push(describeTool(block.name, block.input));
      }
    }
    return out;
  }
  return [];
}

/**
 * Digest of the transcript after `afterUuid` (or from the start when it is
 * absent or unknown). `lastUuid` is the file's last entry, whether or not it
 * contributed, so it can serve as the next cursor.
 */
export function condenseTranscript(jsonlText, { afterUuid = null, maxChars = MAX_DELTA_CHARS } = {}) {
  const entries = parseEntries(jsonlText);
  const lastUuid = entries.length ? entries[entries.length - 1].uuid : afterUuid;
  const cursorAt = afterUuid ? entries.findIndex((e) => e.uuid === afterUuid) : -1;

  const pieces = [];
  let entryCount = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  for (const entry of entries.slice(cursorAt + 1)) {
    const out = entryLines(entry);
    if (!out.length) continue;
    pieces.push(...out);
    entryCount += 1;
    firstTimestamp ??= entry.timestamp ?? null;
    lastTimestamp = entry.timestamp ?? lastTimestamp;
  }

  const full = pieces.join("\n");
  if (full.length <= maxChars) {
    return { text: full, lastUuid, entryCount, truncated: false, firstTimestamp, lastTimestamp };
  }

  // Drop whole lines from the oldest end until the marker plus the rest fits.
  const marker = (dropped, chars) => `[earlier activity omitted: ${dropped} lines, ${chars} chars]\n`;
  let dropped = 0;
  let droppedChars = 0;
  let remaining = full.length;
  while (dropped < pieces.length && marker(dropped, droppedChars).length + remaining > maxChars) {
    const len = pieces[dropped].length + 1;
    droppedChars += len;
    remaining = Math.max(0, remaining - len);
    dropped += 1;
  }
  const text = (marker(dropped, droppedChars) + pieces.slice(dropped).join("\n")).slice(0, maxChars);
  return { text, lastUuid, entryCount, truncated: true, firstTimestamp, lastTimestamp };
}
