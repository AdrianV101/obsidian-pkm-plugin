// Markdown structure helpers shared by the server and the hooks.
// Hooks run from the plugin cache, which has no node_modules, so this module
// must stay dependency-free (relative and node: imports only).

/**
 * @typedef {{ level: number, text: string, raw: string, line: number, offset: number, lineEnd: number }} HeadingInfo
 * line is 1-based; offset is the index of the heading line's first char;
 * lineEnd is the index just past the line's "\n" (or content.length);
 * text is the trimmed heading text without the #s; raw is the line without a trailing "\r".
 */

/**
 * @typedef {{ headingStart: number, afterHeading: number, sectionEnd: number, heading: HeadingInfo }} SectionRange
 */

const DASH_FENCE = /^---[ \t]*\r?$/;
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CODE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const QUERY_WITH_LEVEL = /^(#{1,6})(?:[ \t]+(.*))?$/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+[ \t]*$/;
const BLANK_LINE = /\n[ \t]*\r?\n/g;

/**
 * Split leading YAML frontmatter from the body. The opening fence must be the
 * first line and the closing fence a later line; both are exactly "---"
 * (trailing whitespace and "\r" allowed).
 *
 * @param {string} content
 * @returns {{ frontmatterText: string|null, body: string, bodyOffset: number }}
 *   frontmatterText is the verbatim text between the fence lines (each line keeps
 *   its terminator); null when there is no frontmatter or it is unclosed.
 */
export function splitFrontmatter(content) {
  const firstNl = content.indexOf("\n");
  if (firstNl === -1 || !DASH_FENCE.test(content.slice(0, firstNl))) {
    return { frontmatterText: null, body: content, bodyOffset: 0 };
  }
  const textStart = firstNl + 1;
  let pos = textStart;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 ? content.length : nl;
    if (DASH_FENCE.test(content.slice(pos, lineEnd))) {
      const bodyOffset = nl === -1 ? content.length : nl + 1;
      return { frontmatterText: content.slice(textStart, pos), body: content.slice(bodyOffset), bodyOffset };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { frontmatterText: null, body: content, bodyOffset: 0 };
}

/** Strip an optional closing sequence of #s ("## Foo ##" -> "Foo") and trim. */
function normalizeHeadingText(text) {
  return text.replace(CLOSING_HASHES, "").trim();
}

/**
 * One pass over the body: ATX headings outside fenced code, and the fenced
 * code block ranges themselves. An unclosed fence runs to the end of content.
 *
 * @param {string} content
 * @returns {{ bodyOffset: number, headings: HeadingInfo[], fences: Array<[number, number]> }}
 */
function scanBody(content) {
  const { bodyOffset } = splitFrontmatter(content);
  /** @type {HeadingInfo[]} */
  const headings = [];
  /** @type {Array<[number, number]>} */
  const fences = [];
  let lineNo = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < bodyOffset; i = content.indexOf("\n", i + 1)) lineNo++;

  /** @type {{ char: string, length: number, start: number } | null} */
  let fence = null;
  let pos = bodyOffset;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 ? content.length : nl + 1;
    let line = content.slice(pos, nl === -1 ? content.length : nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const first = line.trimStart()[0];

    if (fence) {
      if (first === fence.char) {
        const close = CODE_FENCE_CLOSE.exec(line);
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
          fences.push([fence.start, lineEnd]);
          fence = null;
        }
      }
    } else if (first === "`" || first === "~") {
      const open = CODE_FENCE_OPEN.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fence = { char: open[1][0], length: open[1].length, start: pos };
      }
    } else if (first === "#") {
      const m = ATX_HEADING.exec(line);
      if (m) {
        headings.push({
          level: m[1].length,
          text: normalizeHeadingText(m[2]),
          raw: line,
          line: lineNo,
          offset: pos,
          lineEnd,
        });
      }
    }
    pos = lineEnd;
    lineNo++;
  }
  if (fence) fences.push([fence.start, content.length]);
  return { bodyOffset, headings, fences };
}

/**
 * ATX headings ("# " to "###### ") in document order, ignoring frontmatter and
 * fenced code blocks (``` or ~~~; a fence closes only on the same character
 * with at least the same length). Up to 3 spaces of indentation are allowed.
 *
 * @param {string} content
 * @returns {HeadingInfo[]}
 */
export function parseHeadings(content) {
  return scanBody(content).headings;
}

/**
 * Headings matching a query. "## Foo" matches level and text; "Foo" matches the
 * text at any level. Both sides are trimmed and compared exactly (no prefix match).
 *
 * @param {HeadingInfo[]} headings
 * @param {string} query
 * @returns {HeadingInfo[]}
 */
export function matchHeadings(headings, query) {
  const q = query.trim();
  const leveled = QUERY_WITH_LEVEL.exec(q);
  const level = leveled ? leveled[1].length : null;
  const text = leveled ? normalizeHeadingText(leveled[2] ?? "") : q;
  return headings.filter(h => h.text === text && (level === null || h.level === level));
}

/**
 * Section span for a heading: from its line to the next heading of the same or
 * higher level (outside code), else to the end of content.
 *
 * @param {string} content
 * @param {HeadingInfo[]} headings - parseHeadings(content)
 * @param {HeadingInfo} heading - one of `headings`
 * @returns {SectionRange}
 */
export function sectionRange(content, headings, heading) {
  let sectionEnd = content.length;
  for (const h of headings) {
    if (h.offset > heading.offset && h.level <= heading.level) {
      sectionEnd = h.offset;
      break;
    }
  }
  return { headingStart: heading.offset, afterHeading: heading.lineEnd, sectionEnd, heading };
}

/**
 * Render headings one `raw` line each, capped at `max` with a "+N more" line.
 *
 * @param {HeadingInfo[]} headings
 * @param {number} [max=30]
 * @returns {string}
 */
export function formatHeadingList(headings, max = 30) {
  if (headings.length === 0) return "(none)";
  const lines = headings.slice(0, max).map(h => h.raw);
  if (headings.length > max) lines.push(`… +${headings.length - max} more`);
  return lines.join("\n");
}

/**
 * Locate exactly one section by heading query.
 *
 * @param {string} content
 * @param {string} query - "## Heading" (level + text) or "Heading" (text, any level)
 * @returns {SectionRange}
 * @throws {Error} when no heading or more than one heading matches
 */
export function findSection(content, query) {
  const headings = parseHeadings(content);
  const matches = matchHeadings(headings, query);
  if (matches.length === 0) {
    throw new Error(`Heading not found: ${query}\nAvailable headings:\n${formatHeadingList(headings)}`);
  }
  if (matches.length > 1) {
    const MAX_LISTED = 30;
    const listed = matches.slice(0, MAX_LISTED).map(h => `  line ${h.line}: ${h.raw}`);
    if (matches.length > MAX_LISTED) listed.push(`  … +${matches.length - MAX_LISTED} more`);
    throw new Error(`Heading "${query}" is ambiguous (${matches.length} matches):\n${listed.join("\n")}\nUse a unique heading.`);
  }
  return sectionRange(content, headings, matches[0]);
}

/** Replace every char except line breaks with a space. */
function blank(text) {
  return text.replace(/[^\r\n]/g, " ");
}

/**
 * Blank out inline code spans: a run of N backticks closed by the next run of
 * exactly N backticks within the same paragraph. Unmatched runs stay literal.
 *
 * @param {string} text - text containing no fenced code
 * @returns {string}
 */
function maskInlineCode(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("`", i);
    if (open === -1) break;
    let runEnd = open;
    while (text[runEnd] === "`") runEnd++;
    const runLength = runEnd - open;

    BLANK_LINE.lastIndex = runEnd;
    const paragraphBreak = BLANK_LINE.exec(text);
    const limit = paragraphBreak ? paragraphBreak.index : text.length;

    let close = -1;
    let search = runEnd;
    while (search < limit) {
      const candidate = text.indexOf("`", search);
      if (candidate === -1 || candidate >= limit) break;
      let candidateEnd = candidate;
      while (text[candidateEnd] === "`") candidateEnd++;
      if (candidateEnd - candidate === runLength) {
        close = candidate;
        break;
      }
      search = candidateEnd;
    }

    if (close === -1) {
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    out += text.slice(i, open) + blank(text.slice(open, close + runLength));
    i = close + runLength;
  }
  return out + text.slice(i);
}

/**
 * Same-length copy of `content` with fenced code blocks and inline code spans
 * replaced by spaces (line breaks kept). Frontmatter is left untouched.
 *
 * @param {string} content
 * @returns {string}
 */
export function maskCode(content) {
  const { bodyOffset, fences } = scanBody(content);
  let out = content.slice(0, bodyOffset);
  let cursor = bodyOffset;
  for (const [start, end] of fences) {
    out += maskInlineCode(content.slice(cursor, start)) + blank(content.slice(start, end));
    cursor = end;
  }
  return out + maskInlineCode(content.slice(cursor));
}

/** Drop a trailing "# comment" (a # at the start or after whitespace, outside quotes) and trim. */
function stripYamlComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function unquoteYamlScalar(text) {
  const m = /^(["'])(.*)\1$/.exec(text);
  return m ? m[2] : text;
}

/** Split an inline list body on commas that are outside quotes. */
function splitInlineList(body) {
  const items = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "," || i === body.length) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return items;
}

/**
 * Read a top-level frontmatter key written by hand as an inline list, a block
 * list or a single scalar. A small reader rather than YAML, so hooks can use it
 * without the yaml package. Empty, null and "~" values give [].
 *
 * @param {string|null} frontmatterText splitFrontmatter's frontmatterText
 * @param {string} key
 * @returns {string[]}
 */
export function frontmatterList(frontmatterText, key) {
  if (typeof frontmatterText !== "string") return [];
  const lines = frontmatterText.split(/\r?\n/);
  const keyLine = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:(.*)$`);
  const at = lines.findIndex(line => keyLine.test(line));
  if (at === -1) return [];

  const value = stripYamlComment(keyLine.exec(lines[at])[1]);
  if (value === "") {
    const items = [];
    for (const line of lines.slice(at + 1)) {
      const text = stripYamlComment(line);
      if (text === "") continue;
      const item = /^-(?:[ \t]+(.*))?$/.exec(text.replace(/^[ \t]+/, ""));
      if (!item) break;
      items.push(unquoteYamlScalar((item[1] ?? "").trim()));
    }
    return items.filter(item => item !== "");
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineList(value.slice(1, -1))
      .map(item => unquoteYamlScalar(item.trim()))
      .filter(item => item !== "");
  }
  return value === "null" || value === "~" ? [] : [unquoteYamlScalar(value)];
}
