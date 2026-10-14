#!/usr/bin/env node
// Dev-only compatibility check (not shipped): parses every note's frontmatter
// with the legacy js-yaml extractor and with frontmatter.js, and prints the
// notes whose results differ. Reads the vault only; never writes.
//
// Usage: node scripts/compare-yaml-parsers.mjs <vaultPath>
// js-yaml is no longer a dependency; install it temporarily first:
//   npm install --no-save js-yaml@4
import fs from "node:fs/promises";
import path from "node:path";
import { extractFrontmatter } from "../frontmatter.js";
import { getAllMarkdownFiles } from "../utils.js";

const vaultPath = process.argv[2];
if (!vaultPath) {
  console.error("Usage: node scripts/compare-yaml-parsers.mjs <vaultPath>");
  process.exit(2);
}

let jsyaml;
try {
  jsyaml = (await import("js-yaml")).default;
} catch {
  console.error("js-yaml is not installed. Run: npm install --no-save js-yaml@4");
  process.exit(2);
}

/** The extractor this project used before switching to `yaml` (utils.js, v3.10.1). */
function legacyExtract(content) {
  if (!content.startsWith("---")) return null;
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  try {
    return jsyaml.load(content.slice(4, endIndex), { schema: jsyaml.JSON_SCHEMA }) ?? null;
  } catch {
    return null;
  }
}

/** JSON with non-finite numbers and value types made visible. */
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "number" && !Number.isFinite(v)) return `<number ${v}>`;
    if (v instanceof Date) return `<Date ${v.toISOString()}>`;
    return v;
  });
}

const files = await getAllMarkdownFiles(vaultPath);
let differing = 0;
for (const rel of files.sort()) {
  const content = await fs.readFile(path.join(vaultPath, rel), "utf-8");
  const before = canonical(legacyExtract(content));
  const after = canonical(extractFrontmatter(content));
  if (before !== after) {
    differing++;
    console.log(`${rel}\n  js-yaml: ${before}\n  yaml:    ${after}`);
  }
}
console.log(`\n${files.length} notes checked, ${differing} differ.`);
