import fs from "fs/promises";
import path from "path";
import { extractFrontmatter } from "./utils.js";
import { maskCode } from "./markdown.js";
import { toTagList } from "./helpers.js";

const WIKILINK_REGEX = /\[\[([^\]\n]+)\]\]/g;

/**
 * Split the inner text of a `[[...]]` link.
 * `\|` is the alias separator Obsidian uses inside tables; it is kept verbatim in `separator`.
 * @param {string} inner - text between the brackets
 * @returns {{ target: string, fragment: string, separator: string, alias: string }}
 *   target: note part; fragment: "#heading" / "#^block" / "^block" suffix; separator: "", "|" or "\\|"
 */
function parseLinkInner(inner) {
  let linkPart = inner;
  let separator = "";
  let alias = "";
  const pipe = inner.indexOf("|");
  if (pipe !== -1) {
    const escaped = pipe > 0 && inner[pipe - 1] === "\\";
    linkPart = inner.slice(0, escaped ? pipe - 1 : pipe);
    separator = escaped ? "\\|" : "|";
    alias = inner.slice(pipe + 1);
  }
  const fragAt = linkPart.search(/[#^]/);
  return {
    target: fragAt === -1 ? linkPart : linkPart.slice(0, fragAt),
    fragment: fragAt === -1 ? "" : linkPart.slice(fragAt),
    separator,
    alias,
  };
}

/**
 * Every wikilink outside fenced code and inline code spans, with its offsets in `content`.
 * Embeds (`![[x]]`) are included; the "!" sits outside the reported range.
 * @param {string} content
 * @returns {Array<{ start: number, end: number, target: string, fragment: string, separator: string, alias: string }>}
 */
function findWikilinks(content) {
  const masked = maskCode(content);
  const regex = new RegExp(WIKILINK_REGEX.source, "g");
  const links = [];
  let match;
  while ((match = regex.exec(masked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const parts = parseLinkInner(content.slice(start + 2, end - 2));
    if (!parts.target && !parts.fragment) continue;
    links.push({ start, end, ...parts });
  }
  return links;
}

/**
 * Extract wikilink targets (note part plus any #heading / ^block suffix, alias dropped).
 * Links inside code are ignored; `[[a\|b]]` yields "a".
 * @param {string} content
 * @returns {string[]}
 */
export function extractWikilinks(content) {
  return findWikilinks(content).map(l => l.target + l.fragment);
}

/** @typedef {{ status: "resolved", path: string } | { status: "ambiguous", candidates: string[] } | { status: "broken" }} LinkResolution */

/**
 * Build the resolver shared by every graph feature. Matching is case-insensitive.
 * Order: exact vault path (".md" optional); then, for targets containing "/", notes whose
 * path ends with "/<target>.md"; otherwise notes with that basename. More than one match is ambiguous.
 * `#heading` and `^block` suffixes are ignored.
 * @param {string[]} allFiles - vault-relative note paths ("/" separators)
 * @returns {{ resolve(target: string): LinkResolution }}
 */
export function createLinkResolver(allFiles) {
  const byPath = new Map();
  const byBasename = new Map();
  for (const file of allFiles) {
    const lower = file.normalize("NFC").toLowerCase();
    if (!byPath.has(lower)) byPath.set(lower, []);
    byPath.get(lower).push(file);
    const base = path.posix.basename(lower, ".md");
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(file);
  }

  /** @param {string[]} candidates @returns {LinkResolution} */
  const verdict = (candidates) => {
    if (candidates.length === 0) return { status: "broken" };
    if (candidates.length === 1) return { status: "resolved", path: candidates[0] };
    return { status: "ambiguous", candidates: [...candidates] };
  };

  return {
    resolve(target) {
      const cleaned = String(target).split(/[#^]/)[0].trim().normalize("NFC").toLowerCase();
      if (!cleaned) return { status: "broken" };
      const withExt = cleaned.endsWith(".md") ? cleaned : cleaned + ".md";
      const exact = byPath.get(withExt);
      if (exact) return verdict(exact);
      const sameBasename = byBasename.get(path.posix.basename(withExt, ".md")) || [];
      if (!cleaned.includes("/")) return verdict(sameBasename);
      const suffix = "/" + withExt;
      return verdict(sameBasename.filter(f => f.normalize("NFC").toLowerCase().endsWith(suffix)));
    },
  };
}

/**
 * Every note a resolution may refer to: the resolved note, or all candidates of an ambiguous link.
 * @param {LinkResolution} resolution
 * @returns {string[]}
 */
export function resolutionPaths(resolution) {
  if (resolution.status === "resolved") return [resolution.path];
  if (resolution.status === "ambiguous") return resolution.candidates;
  return [];
}

/**
 * Notes that the links in `content` may point to (ambiguous links contribute every candidate).
 * @param {string} content
 * @param {{ resolve(target: string): LinkResolution }} resolver
 * @returns {Set<string>}
 */
export function collectLinkedPaths(content, resolver) {
  const linked = new Set();
  for (const link of extractWikilinks(content)) {
    for (const p of resolutionPaths(resolver.resolve(link))) linked.add(p);
  }
  return linked;
}

/**
 * Find all files that contain wikilinks that may resolve to a given target path
 * (ambiguous links count). Returns paths and their content.
 *
 * @param {string} targetPath - vault-relative path of the target file
 * @param {string} vaultPath - absolute vault root
 * @param {string[]} allFiles - all vault-relative file paths
 * @param {{ resolve(target: string): LinkResolution }} resolver - from createLinkResolver(allFiles)
 * @returns {Promise<Array<{file: string, content: string}>>}
 */
export async function findFilesLinkingTo(targetPath, vaultPath, allFiles, resolver) {
  const linking = [];
  for (const file of allFiles) {
    if (file === targetPath) continue;
    let content;
    try {
      content = await fs.readFile(path.join(vaultPath, file), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") continue; // File deleted between listing and reading
      throw e;
    }
    if (collectLinkedPaths(content, resolver).has(targetPath)) {
      linking.push({ file, content });
    }
  }
  return linking;
}

/**
 * Rewrite wikilinks in content that match an old target to point to a new target.
 * Preserves aliases (|text) and heading/block references (#heading, ^block).
 *
 * @param {string} content - file content
 * @param {string} oldTarget - old link target (basename or path, without .md)
 * @param {string} newTarget - new link target (basename or path, without .md)
 * @returns {string} content with links rewritten
 */
export function rewriteWikilinks(content, oldTarget, newTarget) {
  // Match [[...]] links, capturing the full inner text
  return content.replace(/\[\[([^\]\n]+)\]\]/g, (fullMatch, inner) => {
    // Split on | first to separate alias
    const pipeIdx = inner.indexOf("|");
    const linkPart = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner;
    const aliasPart = pipeIdx !== -1 ? inner.slice(pipeIdx) : ""; // includes the |

    // Split link part on # to separate heading/block ref
    const hashIdx = linkPart.indexOf("#");
    const pathPart = hashIdx !== -1 ? linkPart.slice(0, hashIdx) : linkPart;
    const fragPart = hashIdx !== -1 ? linkPart.slice(hashIdx) : ""; // includes the #

    // Check if this link's path matches the old target
    const pathTrimmed = pathPart.trim();
    const pathNoExt = pathTrimmed.endsWith(".md") ? pathTrimmed.slice(0, -3) : pathTrimmed;

    // Match by exact path or by basename
    const oldNoExt = oldTarget.endsWith(".md") ? oldTarget.slice(0, -3) : oldTarget;
    const oldBasename = oldNoExt.includes("/") ? oldNoExt.split("/").pop() : oldNoExt;

    if (pathNoExt.toLowerCase() === oldNoExt.toLowerCase() || pathNoExt.toLowerCase() === oldBasename.toLowerCase()) {
      return `[[${newTarget}${fragPart}${aliasPart}]]`;
    }

    return fullMatch;
  });
}

// --- Link Discovery ---

/**
 * Build an incoming link index: for each target file, which source files link to it.
 * An ambiguous link counts as incoming for every candidate. Self-links are skipped.
 *
 * @param {string} vaultPath - absolute vault path
 * @param {string[]} allFiles - vault-relative file paths
 * @param {{ resolve(target: string): LinkResolution }} resolver - from createLinkResolver(allFiles)
 * @returns {Promise<Map<string, Set<string>>>} targetPath -> Set<sourcePath>
 */
export async function buildIncomingIndex(vaultPath, allFiles, resolver) {
  const index = new Map(); // targetPath -> Set<sourcePath>

  for (const file of allFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(vaultPath, file), "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") continue; // File deleted between listing and reading
      throw e;
    }
    for (const targetPath of collectLinkedPaths(content, resolver)) {
      if (targetPath === file) continue; // skip self-links
      if (!index.has(targetPath)) {
        index.set(targetPath, new Set());
      }
      index.get(targetPath).add(file);
    }
  }

  return index;
}

/**
 * Get incoming links for a specific file.
 *
 * @param {string} filePath - vault-relative path
 * @param {Map<string, Set<string>>} incomingIndex - from buildIncomingIndex
 * @returns {string[]} source file paths
 */
function getIncomingLinks(filePath, incomingIndex) {
  const sources = incomingIndex.get(filePath);
  return sources ? Array.from(sources) : [];
}

// --- Graph Traversal ---

/**
 * Explore the graph neighborhood around a note using BFS.
 *
 * @param {Object} options
 * @param {string} options.startPath - vault-relative path to the starting note
 * @param {string} options.vaultPath - absolute vault root path
 * @param {string[]} options.allFiles - vault-relative note paths (fresh listing)
 * @param {{ resolve(target: string): LinkResolution }} options.resolver - from createLinkResolver(allFiles)
 * @param {number} [options.depth=2] - maximum traversal depth
 * @param {"both"|"outgoing"|"incoming"} [options.direction="both"] - link direction to follow
 * @returns {Promise<NeighborhoodResult>}
 *
 * @typedef {Object} NeighborhoodResult
 * @property {Map<number, NodeInfo[]>} depthGroups - nodes grouped by hop distance
 * @property {number} totalNodes - total nodes discovered
 *
 * @typedef {Object} NodeInfo
 * @property {string} path - vault-relative file path
 * @property {number} depth - hop distance from start
 * @property {boolean} ambiguous - true if reached via an ambiguous link
 * @property {Object} metadata - frontmatter metadata
 * @property {string|null} metadata.type
 * @property {string|null} metadata.status
 * @property {string[]} metadata.tags
 */
export async function exploreNeighborhood({
  startPath,
  vaultPath,
  allFiles,
  resolver,
  depth: maxDepth = 2,
  direction = "both",
}) {
  // Verify start file exists
  const startFullPath = path.resolve(vaultPath, startPath);
  if (startFullPath !== vaultPath && !startFullPath.startsWith(vaultPath + path.sep)) {
    throw new Error("Path escapes vault directory");
  }
  try {
    await fs.access(startFullPath);
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`File not found: ${startPath}`, { cause: e });
    throw e;
  }

  const needIncoming = direction === "both" || direction === "incoming";
  const incomingIndex = needIncoming
    ? await buildIncomingIndex(vaultPath, allFiles, resolver)
    : null;

  // BFS state
  const visited = new Set();
  const depthGroups = new Map();
  let queue = [{ path: startPath, depth: 0, ambiguous: false }];

  while (queue.length > 0) {
    const nextQueue = [];

    for (const { path: nodePath, depth, ambiguous } of queue) {
      if (visited.has(nodePath)) continue;
      visited.add(nodePath);

      // Read file and extract metadata
      let metadata = { type: null, status: null, tags: [] };
      let content = null;
      try {
        content = await fs.readFile(path.join(vaultPath, nodePath), "utf-8");
        const fm = extractFrontmatter(content);
        if (fm) {
          metadata = {
            type: fm.type || null,
            status: fm.status || null,
            tags: toTagList(fm.tags).map(String),
          };
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        // File deleted between listing and reading — record node but skip link discovery
      }

      // Record node
      if (!depthGroups.has(depth)) {
        depthGroups.set(depth, []);
      }
      depthGroups.get(depth).push({ path: nodePath, depth, ambiguous, metadata });

      // Don't discover links beyond max depth
      if (depth >= maxDepth) continue;
      if (!content) continue;

      // Discover neighbors
      const needOutgoing = direction === "both" || direction === "outgoing";

      if (needOutgoing) {
        for (const link of extractWikilinks(content)) {
          const resolution = resolver.resolve(link);
          for (const targetPath of resolutionPaths(resolution)) {
            if (!visited.has(targetPath)) {
              nextQueue.push({
                path: targetPath,
                depth: depth + 1,
                ambiguous: resolution.status === "ambiguous",
              });
            }
          }
        }
      }

      if (needIncoming && incomingIndex) {
        const incoming = getIncomingLinks(nodePath, incomingIndex);
        for (const sourcePath of incoming) {
          if (!visited.has(sourcePath)) {
            nextQueue.push({
              path: sourcePath,
              depth: depth + 1,
              ambiguous: false,
            });
          }
        }
      }
    }

    queue = nextQueue;
  }

  return {
    depthGroups,
    totalNodes: visited.size,
  };
}

/**
 * Format a neighborhood result as human-readable text.
 *
 * @param {NeighborhoodResult} result - from exploreNeighborhood
 * @param {Object} options
 * @param {string} options.startPath
 * @param {number} options.depth
 * @param {string} options.direction
 * @param {(p: string) => string} [options.formatPath] - renders a vault-relative path for display (default: identity)
 * @returns {string}
 */
export function formatNeighborhood(result, { startPath, depth, direction, formatPath }) {
  const { depthGroups, totalNodes } = result;
  const fmt = formatPath || (p => p);

  let output = `**Graph neighborhood for ${fmt(startPath)}** (depth: ${depth}, direction: ${direction})\n`;
  output += `Total: ${totalNodes} node${totalNodes === 1 ? "" : "s"}\n`;

  // Sort depth keys
  const depths = Array.from(depthGroups.keys()).sort((a, b) => a - b);

  for (const d of depths) {
    const nodes = depthGroups.get(d);
    const label = d === 0 ? "Center" : `Depth ${d}`;
    output += `\n**${label}** (${nodes.length} node${nodes.length === 1 ? "" : "s"})\n`;

    for (const node of nodes) {
      let line = `- ${fmt(node.path)}`;
      if (node.ambiguous) line += " [ambiguous]";

      const meta = [];
      if (node.metadata.type) meta.push(`type: ${node.metadata.type}`);
      if (node.metadata.status) meta.push(`status: ${node.metadata.status}`);
      if (node.metadata.tags.length > 0) meta.push(`tags: ${node.metadata.tags.join(", ")}`);
      if (meta.length > 0) line += `\n  ${meta.join(" | ")}`;

      output += line + "\n";
    }
  }

  return output;
}
