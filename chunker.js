// Splits a note into embeddable chunks. Dependency-free (relative and node: imports only)
// so the hooks can load it.
import crypto from "node:crypto";
import { splitFrontmatter, parseHeadings } from "./markdown.js";

export const CHUNK_MAX_CHARS = 4000;

const TITLE_SEP = " › ";

/** @param {string} text */
export function chunkHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** @param {string} text */
export function getPreview(text) {
  const cleaned = text.replace(/^#+\s+/gm, "").trim();
  const words = cleaned.split(/\s+/);
  const preview = words.slice(0, 100).join(" ");
  return preview.length < cleaned.length ? preview + "..." : preview;
}

/**
 * @param {string} content
 * @param {string} filePath
 * @param {{ maxChars?: number, overlap?: boolean }} [options] maxChars limits the chunk body, not the title line.
 * @returns {Array<{ text: string, hash: string, headingPath: string[], preview: string }>}
 */
export function chunkNote(content, filePath, { maxChars = CHUNK_MAX_CHARS, overlap = false } = {}) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { body: rawBody, bodyOffset } = splitFrontmatter(normalized);
  const leading = rawBody.length - rawBody.trimStart().length;
  const body = rawBody.trim();
  if (!body) return [];

  // Offsets are relative to the trimmed body. Parsing the whole note keeps a leading
  // "---" thematic break in the body from being read as frontmatter.
  const shift = bodyOffset + leading;
  const headings = parseHeadings(normalized)
    .filter((h) => h.offset >= shift)
    .map((h) => ({ level: h.level, text: h.text, offset: h.offset - shift }));

  const title = filePath.replace(/^.*[\\/]/, "").replace(/\.md$/, "");

  const pieces = [];
  if (body.length <= maxChars) {
    pieces.push({ start: 0, end: body.length });
  } else {
    const cuts = headings.filter((h) => h.level === 2 && h.offset > 0).map((h) => h.offset);
    const bounds = [0, ...cuts, body.length];
    for (let i = 0; i < bounds.length - 1; i++) {
      pieces.push(...splitSection(body, bounds[i], bounds[i + 1], maxChars, overlap));
    }
  }

  const chunks = [];
  for (const { start, end } of pieces) {
    const text = body.slice(start, end);
    const headingPath = pathAt(headings, start);
    const full = `${[title, ...headingPath].join(TITLE_SEP)}\n\n${text}`;
    chunks.push({ text: full, hash: chunkHash(full), headingPath, preview: getPreview(text) });
  }
  return chunks;
}

/** Headings of any level enclosing the line that starts at `offset`. */
function pathAt(headings, offset) {
  const stack = [];
  for (const h of headings) {
    if (h.offset > offset) break;
    while (stack.length && stack.at(-1).level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.text);
}

function splitSection(body, from, to, maxChars, overlap) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(body[start])) start++;
  while (end > start && /\s/.test(body[end - 1])) end--;
  if (start >= end) return [];
  if (end - start <= maxChars) return [{ start, end }];

  const text = body.slice(start, end);
  const paragraphs = [];
  let last = 0;
  for (const m of text.matchAll(/\n\n+/g)) {
    paragraphs.push({ start: start + last, end: start + m.index });
    last = m.index + m[0].length;
  }
  paragraphs.push({ start: start + last, end });

  const fits = (first, last) => paragraphs[last].end - paragraphs[first].start <= maxChars;
  // Greedy packing into runs of whole paragraphs [first, last]; an oversize paragraph is hard-split.
  const runs = [];
  let current = null;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (p.end - p.start > maxChars) {
      if (current) runs.push(current);
      current = null;
      for (const range of hardSplit(body, p.start, p.end, maxChars)) runs.push({ range });
      continue;
    }
    if (current && p.end - paragraphs[current.first].start <= maxChars) {
      current.last = i;
    } else {
      if (current) runs.push(current);
      const carry = overlap && current && fits(current.last, i) ? current.last : i;
      current = { first: carry, last: i };
    }
  }
  if (current) runs.push(current);

  // Top-up: the final piece reaches back over earlier paragraphs of this section.
  const tail = runs.at(-1);
  if (runs.length > 1 && !tail.range) {
    while (tail.first > 0 && fits(tail.first - 1, tail.last) && !isHard(paragraphs[tail.first - 1], maxChars)) {
      tail.first--;
    }
  }

  return runs.map((r) =>
    r.range ?? { start: paragraphs[r.first].start, end: paragraphs[r.last].end });
}

const isHard = (p, maxChars) => p.end - p.start > maxChars;

function hardSplit(body, start, end, maxChars) {
  const ranges = [];
  for (let i = start; i < end;) {
    let stop = Math.min(i + maxChars, end);
    const unit = body.charCodeAt(stop - 1);
    if (stop < end && unit >= 0xd800 && unit <= 0xdbff && stop - 1 > i) stop--;
    ranges.push({ start: i, end: stop });
    i = stop;
  }
  return ranges;
}
