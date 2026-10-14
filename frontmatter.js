import { parseDocument, stringify, isMap, isScalar, isNode } from "yaml";
import { splitFrontmatter } from "./markdown.js";

// YAML 1.2 core schema: no timestamp type, so dates stay strings.
const PARSE_OPTIONS = { schema: "core" };
const MAX_ALIAS_COUNT = 100;

export const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PROTECTED_FIELDS = ["type", "created", "tags"];

// Canonical frontmatter field constraints, keyed by note type.
// Used by vault_write (templates) and vault_update_frontmatter (existing files).
const FIELD_ENUMS = {
  status: {
    task: ["pending", "active", "done", "cancelled"],
  },
  priority: {
    task: ["urgent", "high", "normal", "low"],
  },
};

/**
 * Validate a frontmatter field value against FIELD_ENUMS for a given note type.
 *
 * @param {string} fieldName - the frontmatter field (e.g. "status")
 * @param {*} value - the value being set
 * @param {string} noteType - the note's type field (e.g. "task")
 * @throws {Error} if the value is not in the allowed set
 */
export function validateFieldEnum(fieldName, value, noteType) {
  if (value === null || value === undefined) return;
  const enumsByType = FIELD_ENUMS[fieldName];
  if (!enumsByType) return;
  const allowed = enumsByType[noteType];
  if (!allowed) return;
  const strValue = String(value);
  if (!allowed.includes(strValue)) {
    throw new Error(
      `Invalid ${fieldName} "${strValue}" for type "${noteType}". Allowed values: ${allowed.join(", ")}`
    );
  }
}

/**
 * Reject keys that could pollute prototypes or are not plain identifiers.
 *
 * @param {string} key
 * @throws {Error} "Disallowed frontmatter key" or "Invalid frontmatter key"
 */
export function assertSafeFrontmatterKey(key) {
  if (DANGEROUS_KEYS.has(key)) {
    throw new Error(`Disallowed frontmatter key: "${key}"`);
  }
  if (!KEY_REGEX.test(key)) {
    throw new Error(`Invalid frontmatter key: "${key}". Keys must start with a letter and contain only letters, digits, hyphens, or underscores.`);
  }
}

/**
 * @param {import("yaml").Document.Parsed} doc
 * @returns {Object|null}
 */
function documentToObject(doc) {
  if (doc.errors.length > 0) {
    throw new Error(`Failed to parse frontmatter: ${doc.errors[0].message}`);
  }
  let value;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (e) {
    throw new Error(`Failed to parse frontmatter: ${e.message}`, { cause: e });
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Failed to parse frontmatter: expected key-value pairs");
  }
  return value;
}

/**
 * Parse frontmatter YAML (without fences).
 *
 * @param {string} text
 * @returns {Object|null} null for an empty document
 * @throws {Error} "Failed to parse frontmatter: …" on invalid YAML or a non-mapping document
 */
export function parseFrontmatterText(text) {
  return documentToObject(parseDocument(text, PARSE_OPTIONS));
}

/**
 * Parse a note's frontmatter, or null when it has none or it is not valid YAML key-value pairs.
 *
 * @param {string} content - full note content
 * @returns {Object|null}
 */
export function extractFrontmatter(content) {
  const { frontmatterText } = splitFrontmatter(content);
  if (frontmatterText === null) return null;
  try {
    return parseFrontmatterText(frontmatterText);
  } catch {
    return null;
  }
}

/**
 * Serialize an object as block YAML (no fences). Keys keep insertion order;
 * strings are quoted only when plain style would change their meaning.
 *
 * @param {Object} obj
 * @returns {string} "" for an empty object, otherwise newline-terminated YAML
 */
export function renderFrontmatter(obj) {
  if (Object.keys(obj).length === 0) return "";
  return stringify(obj, { lineWidth: 0 });
}

/**
 * [start, end) of the full lines a top-level pair occupies in `text`.
 *
 * @param {string} text
 * @param {import("yaml").Pair} pair
 * @returns {[number, number]}
 */
function pairLineSpan(text, pair) {
  const keyStart = isNode(pair.key) && pair.key.range ? pair.key.range[0] : 0;
  const start = keyStart === 0 ? 0 : text.lastIndexOf("\n", keyStart - 1) + 1;
  const valueEnd = isNode(pair.value) && pair.value.range
    ? pair.value.range[1]
    : isNode(pair.key) && pair.key.range ? pair.key.range[1] : keyStart;
  if (valueEnd > start && text[valueEnd - 1] === "\n") return [start, valueEnd];
  const nl = text.indexOf("\n", valueEnd);
  return [start, nl === -1 ? text.length : nl + 1];
}

/**
 * Update frontmatter fields, rewriting only the lines of keys that change.
 * Untouched frontmatter text (comments, quoting, inline lists, number formats)
 * and the body are preserved byte for byte. New keys are appended before the
 * closing fence; a null value removes that key's lines.
 *
 * @param {string} content - full note content with frontmatter
 * @param {Object} fields - fields to set (null = delete)
 * @returns {{ content: string, frontmatter: Object }}
 * @throws {Error} on missing/unclosed/invalid frontmatter, unsafe keys,
 *   protected-field removal, empty tags, or enum violations
 */
export function updateFrontmatter(content, fields) {
  const { frontmatterText } = splitFrontmatter(content);
  if (frontmatterText === null) {
    throw new Error(/^---[ \t]*\r?(\n|$)/.test(content)
      ? "No frontmatter found in file (unclosed)"
      : "No frontmatter found in file");
  }

  const doc = parseDocument(frontmatterText, PARSE_OPTIONS);
  const current = documentToObject(doc) ?? {};
  const root = doc.contents;
  const map = isMap(root) && !root.flow ? root : null;
  if (root !== null && map === null) {
    throw new Error("Failed to parse frontmatter: expected key-value pairs");
  }

  for (const [key, value] of Object.entries(fields)) {
    assertSafeFrontmatterKey(key);
    if (value === null) {
      if (PROTECTED_FIELDS.includes(key)) {
        throw new Error(`Cannot remove required field: "${key}". Protected fields: ${PROTECTED_FIELDS.join(", ")}`);
      }
      continue;
    }
    if (key === "tags" && (!Array.isArray(value) || value.filter(Boolean).length === 0)) {
      throw new Error("tags must be a non-empty array");
    }
    // The file's existing type (or the new type if being changed) drives enum validation
    const effectiveType = key === "type" ? undefined : (fields.type || current.type);
    if (effectiveType) {
      validateFieldEnum(key, value, String(effectiveType));
    }
  }

  const eol = frontmatterText.includes("\r\n") ? "\r\n" : "\n";
  /** @type {Array<{ start: number, end: number, text: string }>} */
  const edits = [];
  let appended = "";
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rendered = value === null ? "" : renderFrontmatter({ [key]: value }).replace(/\n/g, eol);
    const pair = map?.items.find(p => isScalar(p.key) && p.key.value === key);
    if (pair) {
      const [start, end] = pairLineSpan(frontmatterText, pair);
      edits.push({ start, end, text: rendered });
    } else {
      appended += rendered;
    }
  }

  let text = frontmatterText;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  text += appended;

  const textStart = content.indexOf("\n") + 1;
  const newContent = content.slice(0, textStart) + text + content.slice(textStart + frontmatterText.length);
  return { content: newContent, frontmatter: parseFrontmatterText(text) ?? {} };
}
