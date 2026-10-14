import fs from "fs/promises";
import { resolveLexical } from "./vault-fs.js";
import path from "path";
import {
  DANGEROUS_KEYS,
  assertSafeFrontmatterKey,
  extractFrontmatter,
  parseFrontmatterText,
  renderFrontmatter,
  validateFieldEnum,
} from "./frontmatter.js";
import { maskCode, parseHeadings, sectionRange, splitFrontmatter } from "./markdown.js";

export { updateFrontmatter, validateFieldEnum } from "./frontmatter.js";

// Large-file thresholds (character counts, ~4 chars per token)
export const AUTO_REDIRECT_THRESHOLD = 80_000;  // ~20k tokens
export const FORCE_HARD_CAP = 400_000;           // ~100k tokens
export const CHUNK_SIZE = 80_000;                 // chars per chunk
const MAX_OUTLINE_HEADINGS = 50;

const PRIORITY_RANKS = { urgent: 3, high: 2, normal: 1, low: 0 };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compare two frontmatter values for sorting.
 * Smart ordering: priority uses custom ranks, dates sort chronologically, strings use localeCompare.
 * null/undefined always sort last.
 *
 * @param {*} a - first value
 * @param {*} b - second value
 * @param {string} field - frontmatter field name (used for priority detection)
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareFrontmatterValues(a, b, field) {
  // Normalize Date objects to YYYY-MM-DD strings
  if (a instanceof Date) a = a.toISOString().split("T")[0];
  if (b instanceof Date) b = b.toISOString().split("T")[0];

  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  const aStr = String(a);
  const bStr = String(b);

  // Priority field with known values
  if (field === "priority" && aStr in PRIORITY_RANKS && bStr in PRIORITY_RANKS) {
    return PRIORITY_RANKS[aStr] - PRIORITY_RANKS[bStr];
  }

  // Date-like values (YYYY-MM-DD pattern)
  if (DATE_PATTERN.test(aStr) && DATE_PATTERN.test(bStr)) {
    return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
  }

  // String comparison
  return aStr.localeCompare(bStr);
}

export { resolveLexical as resolvePath };

/**
 * Check if note metadata matches a set of query filters.
 *
 * @param {Object|null} metadata - parsed YAML frontmatter
 * @param {Object} filters
 * @param {string} [filters.type] - exact type match
 * @param {string} [filters.status] - exact status match
 * @param {string[]} [filters.tags] - ALL must be present
 * @param {string[]} [filters.tags_any] - ANY must be present
 * @param {string} [filters.created_after] - YYYY-MM-DD lower bound
 * @param {string} [filters.created_before] - YYYY-MM-DD upper bound
 * @param {Object<string, *>} [filters.custom_fields] - exact match per frontmatter field (compared as strings); null means the field must be absent
 * @returns {boolean}
 */
export function matchesFilters(metadata, filters) {
  if (!metadata) return false;

  if (filters.type && metadata.type !== filters.type) {
    return false;
  }

  if (filters.status && metadata.status !== filters.status) {
    return false;
  }

  if (filters.tags && filters.tags.length > 0) {
    const noteTags = (metadata.tags || []).filter(Boolean).map(t => String(t).toLowerCase());
    const allPresent = filters.tags.every(tag =>
      noteTags.includes(tag.toLowerCase())
    );
    if (!allPresent) return false;
  }

  if (filters.tags_any && filters.tags_any.length > 0) {
    const noteTags = (metadata.tags || []).filter(Boolean).map(t => String(t).toLowerCase());
    const anyPresent = filters.tags_any.some(tag =>
      noteTags.includes(tag.toLowerCase())
    );
    if (!anyPresent) return false;
  }

  const createdStr = metadata.created instanceof Date
    ? metadata.created.toISOString().split("T")[0]
    : String(metadata.created || "");

  if (filters.created_after && createdStr < filters.created_after) {
    return false;
  }
  if (filters.created_before && createdStr > filters.created_before) {
    return false;
  }

  if (filters.custom_fields) {
    for (const [key, value] of Object.entries(filters.custom_fields)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      let metaValue = metadata[key];
      if (metaValue instanceof Date) {
        metaValue = metaValue.toISOString().split("T")[0];
      }
      if (value === null) {
        if (metaValue !== undefined && metaValue !== null) return false;
      } else {
        if (String(metaValue ?? "") !== String(value)) return false;
      }
    }
  }

  return true;
}

/**
 * Format metadata into a display-friendly summary and tag line.
 *
 * @param {Object} metadata - parsed YAML frontmatter
 * @returns {{ summary: string, tagLine: string }}
 */
export function formatMetadata(metadata) {
  const parts = [];
  if (metadata.type) parts.push(`type: ${metadata.type}`);
  if (metadata.status) parts.push(`status: ${metadata.status}`);
  if (metadata.created) {
    const dateStr = metadata.created instanceof Date
      ? metadata.created.toISOString().split("T")[0]
      : metadata.created;
    parts.push(`created: ${dateStr}`);
  }
  const tagLine = metadata.tags?.length > 0
    ? `tags: ${metadata.tags.join(", ")}`
    : "";
  return { summary: parts.join(" | "), tagLine };
}

/**
 * Count non-overlapping occurrences of a substring.
 *
 * @param {string} content - text to search
 * @param {string} searchString - substring to find
 * @returns {number}
 */
export function countOccurrences(content, searchString) {
  if (searchString.length === 0) return 0;
  let count = 0;
  let position = 0;
  while ((position = content.indexOf(searchString, position)) !== -1) {
    count++;
    position += searchString.length;
  }
  return count;
}

/**
 * Extract a human-readable description from template content.
 *
 * @param {string} content - raw template markdown
 * @param {Object|null} frontmatter - parsed YAML frontmatter
 * @returns {string} description (max 80 chars)
 */
export function extractTemplateDescription(content, frontmatter) {
  if (frontmatter?.description) return frontmatter.description;

  const lines = content.split("\n");
  let inFrontmatter = false;
  for (const line of lines) {
    if (line.trim() === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").replace(/<%[^%]+%>/g, "{title}").slice(0, 80);
    }
    if (trimmed && !trimmed.startsWith("<!--")) {
      return trimmed.slice(0, 80);
    }
  }
  return `Template for ${frontmatter?.type || "notes"}`;
}

/**
 * Load all templates from the vault's 05-Templates/ directory.
 *
 * @param {string} vaultPath - absolute vault root path
 * @returns {Promise<Map<string, Object>>} template name -> { shortName, path, description, frontmatter, content }
 */
export async function loadTemplates(vaultPath) {
  const templatesDir = resolveLexical("05-Templates", vaultPath);
  const templateMap = new Map();

  try {
    const files = await fs.readdir(templatesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const shortName = path.basename(file, ".md");
      const content = await fs.readFile(path.join(templatesDir, file), "utf-8");
      const frontmatter = extractFrontmatter(content);

      templateMap.set(shortName, {
        shortName,
        path: `05-Templates/${file}`,
        description: extractTemplateDescription(content, frontmatter),
        frontmatter,
        content
      });
    }
  } catch (e) {
    if (e.code === "ENOENT") {
      console.error("Warning: 05-Templates/ not found in vault");
    } else {
      console.error(`Error loading templates: ${e.message}`);
    }
  }

  return templateMap;
}

/**
 * Local-time renderings of the date formats templates use.
 *
 * @param {Date} now
 * @returns {Record<string, string>}
 */
function localDateFormats(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const date = `${year}-${month}-${day}`;
  return {
    "YYYY-MM-DD": date,
    "YYYY-MM-DD HH:mm": `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    "YYYY": year,
    "MM": month,
    "DD": day,
  };
}

/**
 * Apply `substitute` to every string inside a parsed YAML value.
 *
 * @param {*} value
 * @param {(text: string) => string} substitute
 * @returns {*}
 */
function substituteInValue(value, substitute) {
  if (typeof value === "string") return substitute(value);
  if (Array.isArray(value)) return value.map(item => substituteInValue(item, substitute));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteInValue(v, substitute)]));
  }
  return value;
}

/**
 * Substitute Templater-compatible variables and frontmatter fields in template content.
 * The frontmatter is parsed, merged with `vars.frontmatter` and re-serialized as YAML,
 * so values containing ": ", "#", quotes or newlines stay valid.
 *
 * @param {string} content - raw template content
 * @param {Object} vars
 * @param {string} [vars.title] - note title (for tp.file.title)
 * @param {Object} [vars.custom] - custom variable key-value pairs
 * @param {Object} [vars.frontmatter] - frontmatter fields to set (null/undefined keep the template value)
 * @param {Date} [vars.now] - clock for date tokens (defaults to the current time)
 * @returns {string} content with variables replaced
 * @throws {Error} on invalid template frontmatter, unsafe keys, or enum violations
 */
export function substituteTemplateVariables(content, vars) {
  const dates = localDateFormats(vars.now ?? new Date());
  const substitute = (text) => {
    let result = text
      .replace(/<%\s*tp\.date\.now\("([^"]+)"\)\s*%>/g, (_match, format) => dates[format] ?? dates["YYYY-MM-DD"])
      .replace(/<%\s*tp\.file\.title\s*%>/g, () => vars.title || "Untitled");
    for (const [key, value] of Object.entries(vars.custom ?? {})) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`<%\\s*${escaped}\\s*%>`, "g"), () => String(value));
    }
    return result;
  };

  const { frontmatterText, bodyOffset } = splitFrontmatter(content);
  if (frontmatterText === null) return substitute(content);

  const fields = substituteInValue(parseFrontmatterText(frontmatterText) ?? {}, substitute);
  const noteType = typeof fields.type === "string" ? fields.type : null;
  for (const [key, value] of Object.entries(vars.frontmatter ?? {})) {
    assertSafeFrontmatterKey(key);
    if (value === null || value === undefined) continue;
    if (key === "tags") {
      if (Array.isArray(value)) {
        fields.tags = value.map(tag => (typeof tag === "string" ? tag.replace(/^#+/, "") : tag));
      }
      continue;
    }
    if (noteType) validateFieldEnum(key, value, noteType);
    fields[key] = value;
  }

  const openingFence = content.slice(0, content.indexOf("\n") + 1);
  const closingFence = content.slice(openingFence.length + frontmatterText.length, bodyOffset);
  return openingFence + renderFrontmatter(fields) + closingFence + substitute(content.slice(bodyOffset));
}

/**
 * Validate that rendered template content has all required frontmatter fields.
 *
 * @param {string} content - rendered template content
 * @returns {{ valid: boolean, errors: string[], frontmatter: Object|null }}
 */
export function validateFrontmatterStrict(content) {
  const frontmatter = extractFrontmatter(content);
  const errors = [];

  if (!frontmatter) {
    return { valid: false, errors: ["No frontmatter found in template output"], frontmatter: null };
  }

  if (!frontmatter.type) {
    errors.push("Missing required field: type");
  }
  if (!frontmatter.created) {
    errors.push("Missing required field: created");
  }
  if (!frontmatter.tags || !Array.isArray(frontmatter.tags) || frontmatter.tags.filter(Boolean).length === 0) {
    errors.push("Missing required field: tags (must be non-empty array)");
  }

  const unsubstituted = content.match(/<%[^%]+%>/g);
  if (unsubstituted) {
    errors.push(`Unsubstituted template variables: ${unsubstituted.join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    frontmatter
  };
}

/**
 * Extract inline #tags from markdown body (excludes frontmatter, code blocks, headings).
 *
 * @param {string} content - full markdown content including frontmatter
 * @returns {string[]} lowercase tag names
 */
export function extractInlineTags(content) {
  const { bodyOffset } = splitFrontmatter(content);
  const body = maskCode(content).slice(bodyOffset).replace(/^#+\s/gm, "");

  const tags = new Set();
  const tagRegex = /(?:^|[^a-zA-Z0-9&])#([a-zA-Z_][a-zA-Z0-9_/-]*)/g;
  let match;
  while ((match = tagRegex.exec(body)) !== null) {
    tags.add(match[1].toLowerCase());
  }

  return Array.from(tags);
}

/**
 * Locate the last `n` sections at heading `level` (headings in fenced code don't count).
 *
 * @param {string} content - full file content
 * @param {number} n - number of sections
 * @param {number} level - heading level (1-6)
 * @returns {{ frontmatter: string, start: number, line: number }} the frontmatter block to
 *   prepend, and the offset and 1-based line where the tail begins. With no heading at that
 *   level the tail is the whole content and there is no separate frontmatter block.
 */
export function findTailSections(content, n, level) {
  const atLevel = parseHeadings(content).filter(h => h.level === level);
  if (atLevel.length === 0) return { frontmatter: "", start: 0, line: 1 };
  const first = atLevel[Math.max(0, atLevel.length - n)];
  return { frontmatter: content.slice(0, splitFrontmatter(content).bodyOffset), start: first.offset, line: first.line };
}

/**
 * Cap a vault_read selection at `cap` chars, keeping whole lines.
 *
 * @param {string} text - the selection; its first line is file line `firstLine`
 * @param {{ firstLine: number, totalLines: number, cap: number }} position
 * @returns {string} `text` when it fits; otherwise the lines that fit plus a marker
 *   telling the caller which `lines` range to read next
 */
export function capReadOutput(text, { firstLine, totalLines, cap }) {
  if (text.length <= cap) return text;
  let kept = text.slice(0, text.lastIndexOf("\n", cap - 1) + 1);
  // A single line longer than the cap is cut mid-line; reading continues at the next line.
  if (kept === "") kept = text.slice(0, cap) + "\n";
  const lastLine = firstLine + kept.split("\n").length - 2;
  return `${kept}[truncated: lines ${firstLine}–${lastLine} of ${totalLines}; continue with lines: {start: ${lastLine + 1}}]`;
}

/**
 * Match a tag against a glob-like pattern.
 * Supports: hierarchical prefix ("pkm/*"), substring ("*mcp*"), prefix ("dev*"), suffix ("*fix"), exact.
 *
 * @param {string} tag - tag to test
 * @param {string} [pattern] - glob-like pattern (returns true if omitted)
 * @returns {boolean}
 */
export function matchesTagPattern(tag, pattern) {
  if (!pattern) return true;

  const t = tag.toLowerCase();
  const p = pattern.toLowerCase();

  if (p.endsWith("/*")) {
    const prefix = p.slice(0, -2);
    return t === prefix || t.startsWith(prefix + "/");
  }

  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
    return t.includes(p.slice(1, -1));
  }

  if (p.endsWith("*")) {
    return t.startsWith(p.slice(0, -1));
  }

  if (p.startsWith("*")) {
    return t.endsWith(p.slice(1));
  }

  return t === p;
}

/**
 * Build a lookup map from lowercase basename (without .md) to all matching vault-relative paths.
 * Also returns a Set of all file paths for O(1) exact-match checks.
 *
 * @param {string[]} allFiles - vault-relative file paths
 * @returns {{ basenameMap: Map<string, string[]>, allFilesSet: Set<string> }}
 */
export function buildBasenameMap(allFiles) {
  const basenameMap = new Map();
  const allFilesSet = new Set(allFiles);
  for (const filePath of allFiles) {
    const basename = path.basename(filePath, ".md").toLowerCase();
    if (!basenameMap.has(basename)) {
      basenameMap.set(basename, []);
    }
    basenameMap.get(basename).push(filePath);
  }
  return { basenameMap, allFilesSet };
}

/**
 * Resolve a partial folder name to a full vault-relative directory path.
 *
 * Resolution order:
 * 1. Exact match — folder string is a known directory prefix of at least one file
 * 2. Substring match — case-insensitive substring of known directory paths
 *
 * @param {string} folder - user-provided folder (full or partial)
 * @param {string[]} allFiles - all vault-relative file paths
 * @returns {string} resolved vault-relative directory path
 * @throws {Error} if folder not found or ambiguous
 */
export function resolveFuzzyFolder(folder, allFiles) {
  // Collect all unique directory paths from the file list
  const dirs = new Set();
  for (const file of allFiles) {
    let dir = path.dirname(file);
    while (dir && dir !== ".") {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  // 1. Exact match
  if (dirs.has(folder)) return folder;

  // 2. Substring match (case-insensitive)
  const lowerFolder = folder.toLowerCase();
  const matches = Array.from(dirs).filter(d => d.toLowerCase().includes(lowerFolder));

  // Deduplicate: if both "01-Projects/Obsidian-MCP" and
  // "01-Projects/Obsidian-MCP/development" match, prefer the shortest
  // that ends with the search term (most likely the intended target).
  if (matches.length > 1) {
    const endsWith = matches.filter(d => d.toLowerCase().endsWith(lowerFolder));
    if (endsWith.length === 1) return endsWith[0];
    if (endsWith.length > 1) {
      const list = endsWith.map(p => `  - ${p}`).join("\n");
      throw new Error(
        `"${folder}" matches ${endsWith.length} folders:\n${list}\nUse a more specific path.`
      );
    }
  }

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`Folder not found: "${folder}". No matching directory in vault.`);
  }

  const list = matches.map(p => `  - ${p}`).join("\n");
  throw new Error(
    `"${folder}" matches ${matches.length} folders:\n${list}\nUse a more specific path.`
  );
}

/**
 * Compute peek metadata for a file's content without returning the full body.
 *
 * @param {string} content - full file content
 * @param {string} relativePath - vault-relative path (for display)
 * @returns {{ path: string, sizeChars: number, sizeLines: number, frontmatter: Object|null, headings: Array<{heading: string, level: number, lineNumber: number, charCount: number}>, preview: string, totalChunks: number }}
 */
export function computePeek(content, relativePath) {
  const sizeChars = content.length;
  const sizeLines = content.split("\n").length;
  const frontmatter = extractFrontmatter(content);
  const totalChunks = sizeChars === 0 ? 0 : Math.ceil(sizeChars / CHUNK_SIZE);

  const parsed = parseHeadings(content);
  const headings = parsed.map(h => {
    const range = sectionRange(content, parsed, h);
    return { heading: h.raw, level: h.level, lineNumber: h.line, charCount: range.sectionEnd - range.headingStart };
  });

  // Preview: first ~10 non-empty body lines, truncated to 200 chars each
  const previewLines = splitFrontmatter(content).body.split("\n")
    .map(l => l.replace(/\r$/, ""))
    .filter(l => l.trim() !== "")
    .slice(0, 10)
    .map(l => l.length > 200 ? l.slice(0, 200) + "..." : l);
  const preview = previewLines.join("\n");

  return { path: relativePath, sizeChars, sizeLines, frontmatter, headings, preview, totalChunks };
}

/**
 * Format peek data into a human-readable string.
 *
 * @param {{ path: string, sizeChars: number, sizeLines: number, frontmatter: Object|null, headings: Array, preview: string, totalChunks: number }} peekData
 * @param {{ redirected?: boolean, formatPath?: (p: string) => string }} [options]
 * @returns {string}
 */
export function formatPeek(peekData, { redirected = false, formatPath } = {}) {
  const { path: filePath, sizeChars, sizeLines, frontmatter, headings, preview, totalChunks } = peekData;
  const parts = [];
  const displayPath = formatPath ? formatPath(filePath) : filePath;

  parts.push(`## File: ${displayPath}`);
  parts.push(`**Size:** ${sizeChars.toLocaleString()} chars, ${sizeLines.toLocaleString()} lines, ${totalChunks} ${totalChunks === 1 ? "chunk" : "chunks"}`);

  if (frontmatter) {
    parts.push("");
    parts.push("### Frontmatter");
    for (const [key, value] of Object.entries(frontmatter)) {
      const display = Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
      parts.push(`${key}: ${display}`);
    }
  }

  if (headings.length > 0) {
    parts.push("");
    parts.push("### Heading Outline");
    for (const h of headings.slice(0, MAX_OUTLINE_HEADINGS)) {
      const indent = "  ".repeat(h.level - 1);
      const title = h.heading.replace(/^#+\s*/, "");
      parts.push(`${indent}${title} [${h.charCount} chars]`);
    }
    if (headings.length > MAX_OUTLINE_HEADINGS) {
      parts.push(`… +${headings.length - MAX_OUTLINE_HEADINGS} more`);
    }
  }

  if (preview) {
    parts.push("");
    parts.push("### Preview");
    parts.push(preview);
  }

  if (redirected) {
    parts.push("");
    parts.push("---");
    parts.push(`This file exceeds the auto-read threshold (~${(AUTO_REDIRECT_THRESHOLD / 1000).toFixed(0)}k chars). To read content, use one of:`);
    parts.push('- `heading: "## Section Name"` - read a specific section');
    parts.push("- `tail: N` - read last N lines");
    parts.push("- `tail_sections: N` - read last N sections");
    if (totalChunks > 1) {
      parts.push(`- \`chunk: 1\` - read chunk 1 of ${totalChunks}`);
    }
    parts.push("- `lines: { start: 1, end: 200 }` - read a line range");
    parts.push("- `force: true` - read full content (WARNING: may degrade model performance, hard-capped at ~400k chars)");
  }

  return parts.join("\n");
}

/**
 * Compute a proximity bonus for graph-semantic blending.
 * Maps graph depth to a 0-1 score for combining with semantic similarity.
 * @param {number|null|undefined} depth - hop distance from center (null = not in graph)
 * @returns {number} proximity bonus (0-1)
 */
export function computeProximityBonus(depth) {
  if (depth === null || depth === undefined) return 0;
  if (depth <= 1) return 1.0;
  if (depth === 2) return 0.5;
  if (depth === 3) return 0.25;
  return 0;
}

/**
 * Blend semantic search results with graph proximity scores.
 * Builds a depth map from neighborhood results, computes proximity bonuses,
 * combines with semantic scores, sorts by combined score, and slices to limit.
 * @param {Array<{path: string, score: number}>} results - semantic results
 * @param {{depthGroups: Map<number, Array<{path: string}>>}} neighborhood - graph neighborhood
 * @param {number} graphWeight - weight for proximity (0-1)
 * @param {number} limit - max results to return
 * @returns {Array<Object>} blended results sorted by combined score, with depth field
 */
export function blendWithGraph(results, neighborhood, graphWeight, limit) {
  const depthMap = new Map();
  for (const [d, nodes] of neighborhood.depthGroups) {
    for (const node of nodes) {
      if (!depthMap.has(node.path)) depthMap.set(node.path, d);
    }
  }

  const blended = results.map(r => {
    const depth = depthMap.get(r.path) ?? null;
    const proximity = computeProximityBonus(depth);
    const combined = Math.round(((r.score * (1 - graphWeight)) + (proximity * graphWeight)) * 1000) / 1000;
    return { ...r, combined, depth };
  });

  blended.sort((a, b) => b.combined - a.combined);
  return blended.slice(0, limit);
}

/**
 * Build an `obsidian://` markdown link for a vault-relative path. Used in
 * user-facing tool output so the path renders as a clickable link in clients
 * that preserve markdown link formatting (e.g. Claude Code's terminal). The
 * visible link text is the unmodified vault-relative path so a model that
 * extracts the link text gets the same canonical path it would get from a
 * plain-path response.
 *
 * @param {string} filePath - vault-relative path (with or without .md)
 * @param {string} vaultName - vault name as registered in Obsidian
 * @returns {string} `[filePath](obsidian://open?vault=...&file=...)`
 */
export function obsidianLink(filePath, vaultName) {
  if (!filePath) return "";
  const fileWithoutMd = filePath.endsWith(".md") ? filePath.slice(0, -3) : filePath;
  const encodedFile = encodeURIComponent(fileWithoutMd);
  const encodedVault = encodeURIComponent(vaultName);
  return `[${filePath}](obsidian://open?vault=${encodedVault}&file=${encodedFile})`;
}
