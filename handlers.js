import fs from "fs/promises";
import path from "path";
import {
  matchesFilters,
  formatMetadata,
  occurrenceLines,
  substituteTemplateVariables,
  validateFrontmatterStrict,
  extractInlineTags,
  matchesTagPattern,
  findTailSections,
  capReadOutput,
  resolveFuzzyFolder,
  computePeek,
  formatPeek,
  updateFrontmatter,
  compareFrontmatterValues,
  blendWithGraph,
  obsidianLink,
  AUTO_REDIRECT_THRESHOLD,
  FORCE_HARD_CAP,
  CHUNK_SIZE,
  toTagList,
} from "./helpers.js";
import {
  exploreNeighborhood,
  formatNeighborhood,
  findFilesLinkingTo,
  rewriteWikilinks,
  extractWikilinks,
  buildIncomingIndex,
  createLinkResolver,
  collectLinkedPaths,
  resolutionPaths,
  DEFAULT_MAX_NODES,
} from "./graph.js";
import { getAllMarkdownFiles, extractFrontmatter } from "./utils.js";
import { formatDisabledMessage, formatStaleFooter } from "./semantic-health.js";

import { mutateFile, writeNew, withNoteLock, normalizeVaultRoot, resolveSafe, hasDotSegment, assertWritableReal, FileIndex, toVaultRel } from "./vault-fs.js";
import { findSection, matchHeadings, parseHeadings, splitFrontmatter } from "./markdown.js";

const NO_SEMANTIC_KEY = "VAULT_PKM_OPENAI_KEY not set";

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Insert `args.content` into a note per vault_append's heading/position rules, using
 * the note's own line ending so a CRLF note stays CRLF.
 * @param {string} existing
 * @param {{ path: string, content: string, heading?: string, position?: string }} args
 * @returns {string}
 */
function applyAppend(existing, args) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const content = args.content.replace(/\r?\n/g, eol);
  if (args.position) {
    if (!args.heading) {
      throw new Error("'heading' is required when 'position' is specified");
    }
    const range = findSection(existing, args.heading);
    if (args.position === "before_heading") {
      return existing.slice(0, range.headingStart) + content + eol + existing.slice(range.headingStart);
    }
    if (args.position === "after_heading") {
      return existing.slice(0, range.afterHeading) + content + eol + existing.slice(range.afterHeading);
    }
    if (args.position === "end_of_section") {
      const before = existing.slice(0, range.sectionEnd);
      const separator = before.length > 0 && !before.endsWith("\n") ? eol : "";
      return before + separator + content + eol + existing.slice(range.sectionEnd);
    }
    throw new Error(`Unknown position: ${args.position}`);
  }
  // Without a position, an unknown heading falls back to appending at the end
  if (args.heading && matchHeadings(parseHeadings(existing), args.heading).length > 0) {
    const range = findSection(existing, args.heading);
    return existing.slice(0, range.afterHeading) + content + eol + existing.slice(range.afterHeading);
  }
  return existing + eol + content;
}

const MAX_LISTED_LINES = 10;

function formatLineList(lines) {
  const shown = lines.slice(0, MAX_LISTED_LINES).join(", ");
  return lines.length > MAX_LISTED_LINES ? `${shown}, +${lines.length - MAX_LISTED_LINES} more` : shown;
}

/**
 * Rewrite a low-level fs error so its message names the vault-relative path instead of
 * an absolute path or temp file name. Other errors pass through.
 * @param {any} e
 * @param {string} rel vault-relative path of the note being written
 * @returns {any}
 */
function relError(e, rel) {
  const message = {
    ENOENT: `Cannot write ${rel}: its folder does not exist.`,
    ENAMETOOLONG: `Cannot write ${rel}: the file name is too long.`,
    EACCES: `Cannot write ${rel}: permission denied.`,
    EPERM: `Cannot write ${rel}: permission denied.`,
    EROFS: `Cannot write ${rel}: the file system is read-only.`,
  }[e?.code];
  if (!message) return e;
  // mutateFile's own EACCES message already names only the note.
  if (e.code === "EACCES" && /read-only/.test(e.message)) return e;
  return Object.assign(new Error(message, { cause: e }), { code: e.code });
}

async function isDirectory(absPath) {
  try {
    return (await fs.stat(absPath)).isDirectory();
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Create all tool handler functions with shared context.
 * @param {Object} ctx
 * @param {string} ctx.vaultPath - absolute path to vault root
 * @param {Map} ctx.templateRegistry - loaded templates
 * @param {Object|null} ctx.semanticIndex - SemanticIndex instance (null if no API key)
 * @param {Object|null} ctx.activityLog - ActivityLog instance
 * @param {string} ctx.sessionId - current session UUID
 * @param {string} [ctx.vaultName] - vault name for obsidian:// links (defaults to basename of vaultPath)
 * @returns {Promise<Map<string, Function>>} tool name to handler function
 */
export async function createHandlers({ vaultPath: rawVaultPath, templateRegistry, semanticIndex, activityLog, sessionId, vaultName }) {
  const vaultPath = normalizeVaultRoot(rawVaultPath);
  const safe = (relativePath) => resolveSafe(relativePath, vaultPath);
  const writableNote = (relativePath) => assertWritableReal(relativePath, vaultPath, "note");
  const writableFolder = (relativePath) => assertWritableReal(relativePath, vaultPath, "folder");
  const resolvedVaultName = vaultName || path.basename(vaultPath);
  const linkFor = (relativePath) => obsidianLink(relativePath, resolvedVaultName);

  const fileIndex = await FileIndex.build(vaultPath);

  /**
   * The spelling the file or folder has on disk when it differs from `rel` only by Unicode
   * normalisation or case; otherwise `rel` as typed. Symlinks resolve to a different name, so
   * trash and move (which act on the link itself) keep the typed path.
   */
  const sameNameOnDisk = async (rel) => {
    const typed = toVaultRel(rel);
    try {
      const real = await fs.realpath(path.join(vaultPath, typed));
      const realRoot = await fs.realpath(vaultPath);
      const onDisk = toVaultRel(path.relative(realRoot, real));
      const fold = (s) => s.normalize("NFC").toLowerCase();
      return fold(onDisk) === fold(typed) ? onDisk : typed;
    } catch {
      return typed;
    }
  };

  /** The note's on-disk spelling, which is what the semantic index stores (Unicode form, case). */
  const onDiskPath = async (rel) => {
    try {
      return await fileIndex.resolveFuzzy(rel);
    } catch {
      return toVaultRel(rel);
    }
  };

  /**
   * Resolve a read-tool note path. The input is containment-checked as typed, so a
   * symlink out of the vault is refused as an escape instead of reported missing.
   */
  async function resolveNote(inputPath) {
    await safe(inputPath);
    const rel = await fileIndex.resolveFuzzy(inputPath);
    return { rel, abs: await safe(rel) };
  }

  /** Resolve a folder path: a known or on-disk folder as typed, else a fuzzy match. */
  const resolveFolder = async (folder) => {
    const exactResolved = await safe(folder);
    const rel = toVaultRel(folder);
    const files = fileIndex.list();
    if (files.some(f => f.startsWith(rel + "/"))) return exactResolved;
    // Folders created since the index was built are accepted by exact name (dot-folders stay hidden).
    if (!rel.split("/").some(s => s.startsWith(".")) && await isDirectory(exactResolved)) return exactResolved;
    return safe(resolveFuzzyFolder(folder, files));
  };

  const SESSION_ID_DISPLAY_LEN = 8;

  /**
   * Why semantic features can't run right now, or null when they can.
   * A disabled index gets one probe request first, so it re-enables as soon as the API works again.
   */
  async function semanticUnavailableReason() {
    if (semanticIndex?.isAvailable) return null;
    if (semanticIndex?.health?.().status === "disabled") {
      await semanticIndex.probe();
      return semanticIndex.isAvailable ? null : formatDisabledMessage(semanticIndex.health());
    }
    return NO_SEMANTIC_KEY;
  }

  async function requireSemantic(feature) {
    const reason = await semanticUnavailableReason();
    if (reason === NO_SEMANTIC_KEY) throw new Error(`${feature} not available (${NO_SEMANTIC_KEY})`);
    if (reason) throw new Error(reason);
  }

  /** Fresh note listing plus the link resolver built from it (graph tools never use the startup snapshot). */
  async function freshGraph() {
    const allFiles = await fileIndex.listFresh();
    return { allFiles, resolver: createLinkResolver(allFiles) };
  }

  // ── File I/O ────────────────────────────────────────────────────────

  async function handleRead(args) {
    const { abs: filePath } = await resolveNote(args.path);
    let content;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`File not found: ${args.path}`, { cause: e });
      throw e;
    }

    // Validate mutual exclusivity
    const modeCount = [
      args.heading !== undefined,
      args.tail !== undefined,
      args.tail_sections !== undefined,
      args.chunk !== undefined,
      args.lines !== undefined,
    ].filter(Boolean).length;
    if (modeCount > 1) {
      throw new Error("Only one of 'heading', 'tail', 'tail_sections', 'chunk', or 'lines' can be specified at a time");
    }

    // Auto-redirect: return peek data for large files without explicit pagination
    const hasExplicitMode = args.heading !== undefined || args.tail !== undefined ||
      args.tail_sections !== undefined || args.chunk !== undefined || args.lines !== undefined;
    if (!hasExplicitMode && !args.force && content.length > AUTO_REDIRECT_THRESHOLD) {
      const relativePath = toVaultRel(path.relative(vaultPath, filePath));
      const peekData = computePeek(content, relativePath);
      return { content: [{ type: "text", text: formatPeek(peekData, { redirected: true, formatPath: linkFor }) }] };
    }

    // Force hard cap
    if (args.force && content.length > FORCE_HARD_CAP) {
      const relativePath = toVaultRel(path.relative(vaultPath, filePath));
      const peekData = computePeek(content, relativePath);
      const text = formatPeek(peekData, { redirected: true, formatPath: linkFor }) +
        `\n\n**Hard cap reached.** File is ${content.length.toLocaleString()} chars, exceeding the ~400k char limit even with force=true. Use heading, chunk, or lines params to read portions.`;
      return { content: [{ type: "text", text }] };
    }

    let text = content;
    // Every explicit mode is capped like a full read: the auto-redirect threshold, or the hard cap with force
    const cap = args.force ? FORCE_HARD_CAP : AUTO_REDIRECT_THRESHOLD;
    const totalLines = content.split("\n").length;
    const capFrom = (selection, firstLine) => capReadOutput(selection, { firstLine, totalLines, cap });

    if (args.heading) {
      const range = findSection(content, args.heading);
      text = capFrom(content.slice(range.headingStart, range.sectionEnd), range.heading.line);
    } else if (args.tail) {
      // Frontmatter is always prepended
      const { bodyOffset } = splitFrontmatter(content);
      const tailLines = content.slice(bodyOffset).split("\n").slice(-positiveInt(args.tail, 20));
      text = content.slice(0, bodyOffset) + capFrom(tailLines.join("\n"), totalLines - tailLines.length + 1);
    } else if (args.tail_sections) {
      const { frontmatter, start, line } = findTailSections(content, positiveInt(args.tail_sections, 3), positiveInt(args.section_level, 2));
      text = frontmatter + capFrom(content.slice(start), line);
    } else if (args.chunk !== undefined) {
      // A chunk is at most CHUNK_SIZE chars, which never exceeds the cap
      const chunk = positiveInt(args.chunk, 0);
      const totalChunks = Math.ceil(content.length / CHUNK_SIZE);
      if (chunk < 1 || chunk > totalChunks) {
        throw new Error(`Invalid chunk: ${chunk}. File has ${totalChunks} chunk${totalChunks === 1 ? "" : "s"} (1-indexed).`);
      }
      const start = (chunk - 1) * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, content.length);
      text = `[Chunk ${chunk} of ${totalChunks}, chars ${start + 1}-${end} of ${content.length}]\n\n` + content.slice(start, end);
    } else if (args.lines) {
      const allLines = content.split("\n");
      const start = positiveInt(args.lines.start, null);
      const end = positiveInt(args.lines.end, null);
      if (start === null || end === null) {
        throw new Error("lines.start and lines.end must be positive integers");
      }
      if (end < start || start > allLines.length) {
        throw new Error(`Invalid line range: ${start}-${end}. File has ${allLines.length} lines.`);
      }
      const clampedEnd = Math.min(end, allLines.length);
      text = `[Lines ${start}-${clampedEnd} of ${allLines.length}]\n\n` + capFrom(allLines.slice(start - 1, clampedEnd).join("\n"), start);
    }

    return { content: [{ type: "text", text }] };
  }

  async function handlePeek(args) {
    const { abs: filePath } = await resolveNote(args.path);
    let content;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`File not found: ${args.path}`, { cause: e });
      throw e;
    }
    const relativePath = toVaultRel(path.relative(vaultPath, filePath));
    const peekData = computePeek(content, relativePath);
    return { content: [{ type: "text", text: formatPeek(peekData, { formatPath: linkFor }) }] };
  }

  async function handleWrite(args) {
    const { template: templateName, path: outputPath, variables = {}, frontmatter = {}, createDirs = true } = args;

    const templateInfo = templateRegistry.get(templateName);
    if (!templateInfo) {
      const available = Array.from(templateRegistry.keys()).join(", ");
      throw new Error(`Template "${templateName}" not found. Available templates: ${available || "(none)"}`);
    }

    const filePath = await safe(outputPath);
    await writableNote(outputPath);

    const title = path.basename(outputPath, ".md");
    const substituted = substituteTemplateVariables(templateInfo.content, {
      title,
      custom: variables,
      frontmatter
    });

    const validation = validateFrontmatterStrict(substituted);
    if (!validation.valid) {
      throw new Error(`Template validation failed:\n${validation.errors.join("\n")}`);
    }

    if (createDirs) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
    }

    try {
      await writeNew(filePath, substituted);
    } catch (e) {
      if (e.code === "EEXIST") {
        throw new Error(`File already exists: ${outputPath}. Use vault_edit or vault_append to modify existing files.`, { cause: e });
      }
      throw relError(e, outputPath);
    }

    fileIndex.add(outputPath);
    semanticIndex?.notifyChanged?.(await onDiskPath(outputPath));

    const fm = validation.frontmatter;
    const createdStr = fm.created instanceof Date
      ? fm.created.toISOString().split("T")[0]
      : fm.created;
    return {
      content: [{
        type: "text",
        text: `Created ${linkFor(outputPath)} from template "${templateName}"\n\nFrontmatter:\n- type: ${fm.type}\n- created: ${createdStr}\n- tags: ${(fm.tags || []).filter(Boolean).join(", ")}`
      }]
    };
  }

  async function handleAppend(args) {
    if (!args.content) {
      throw new Error("content must be a non-empty string");
    }
    const filePath = await safe(args.path);
    await writableNote(args.path);
    try {
      await mutateFile(filePath, (existing) => applyAppend(existing, args));
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${args.path}. Use vault_write to create new files.`, { cause: e });
      }
      throw relError(e, args.path);
    }
    semanticIndex?.notifyChanged?.(await onDiskPath(args.path));
    return { content: [{ type: "text", text: `Appended to ${linkFor(args.path)}${args.position ? ` (${args.position})` : ""}` }] };
  }

  async function handleEdit(args) {
    if (!args.old_string) {
      throw new Error("old_string must be a non-empty string");
    }
    const filePath = await safe(args.path);
    await writableNote(args.path);
    let matchLines = [];
    try {
      await mutateFile(filePath, (content) => {
        matchLines = occurrenceLines(content, args.old_string);
        if (matchLines.length !== 1) return content;
        return content.replace(args.old_string, () => args.new_string);
      });
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${args.path}`, { cause: e });
      }
      throw relError(e, args.path);
    }

    const count = matchLines.length;
    if (count === 0) {
      return {
        content: [{ type: "text", text: `No match found for the specified old_string in ${args.path}` }],
        isError: true
      };
    }

    if (count > 1) {
      return {
        content: [{ type: "text", text: `Found ${count} matches for old_string in ${args.path} (lines ${formatLineList(matchLines)}). Please provide a more specific string that matches exactly once.` }],
        isError: true
      };
    }

    semanticIndex?.notifyChanged?.(await onDiskPath(args.path));
    return { content: [{ type: "text", text: `Successfully edited ${linkFor(args.path)}` }] };
  }

  // ── Search & Discovery ──────────────────────────────────────────────

  async function handleSearch(args) {
    const searchDir = args.folder ? await resolveFolder(args.folder) : vaultPath;
    const folderPrefix = args.folder ? toVaultRel(path.relative(vaultPath, searchDir)) : "";
    const files = await getAllMarkdownFiles(searchDir);
    const results = [];
    const query = args.query.toLowerCase();
    const limit = positiveInt(args.limit, 10);

    for (const file of files) {
      if (results.length >= limit) break;
      const filePath = path.join(searchDir, file);
      let content;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      if (content.toLowerCase().includes(query)) {
        const lines = content.split("\n");
        const matchingLines = lines
          .map((line, i) => ({ line, num: i + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(query))
          .slice(0, 3);

        results.push({
          path: folderPrefix ? path.posix.join(folderPrefix, file) : file,
          matches: matchingLines.map(m => `L${m.num}: ${m.line.trim().slice(0, 100)}`)
        });
      }
    }

    return {
      content: [{
        type: "text",
        text: results.length > 0
          ? results.map(r => `**${linkFor(r.path)}**\n${r.matches.join("\n")}`).join("\n\n")
          : "No matches found"
      }]
    };
  }

  // Linear-time glob matching (no regex, no backtracking)
  function globMatch(pattern, str) {
    const parts = pattern.split("*");
    if (parts.length === 1) return str === pattern;

    if (!str.startsWith(parts[0])) return false;
    const lastPart = parts[parts.length - 1];
    if (!str.endsWith(lastPart)) return false;

    let pos = parts[0].length;
    const endLimit = str.length - lastPart.length;
    for (let i = 1; i < parts.length - 1; i++) {
      if (parts[i] === "") continue; // consecutive wildcards
      const idx = str.indexOf(parts[i], pos);
      if (idx === -1 || idx + parts[i].length > endLimit) return false;
      pos = idx + parts[i].length;
    }
    return pos <= endLimit;
  }

  // ── Listing & Activity ──────────────────────────────────────────────

  async function handleList(args) {
    const inputPath = args.path || "";
    const listPath = inputPath ? await resolveFolder(inputPath) : vaultPath;
    const relativePath = inputPath ? toVaultRel(path.relative(vaultPath, listPath)) : "";
    let entries;
    try {
      entries = await fs.readdir(listPath, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`Folder not found: ${inputPath || "/"}`, { cause: e });
      throw e;
    }

    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const itemPath = path.posix.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        items.push(`[dir] ${itemPath}/`);
        if (args.recursive) {
          const subItems = await getAllMarkdownFiles(path.join(listPath, entry.name));
          items.push(...subItems.map(f => `  ${linkFor(path.posix.join(itemPath, f))}`));
        }
      } else if (!args.pattern || globMatch(args.pattern, entry.name)) {
        items.push(linkFor(itemPath));
      }
    }

    return { content: [{ type: "text", text: items.join("\n") || "Empty directory" }] };
  }

  async function handleRecent(args) {
    const searchDir = args.folder ? await resolveFolder(args.folder) : vaultPath;
    const folderPrefix = args.folder ? toVaultRel(path.relative(vaultPath, searchDir)) : "";
    const files = await getAllMarkdownFiles(searchDir);
    const limit = positiveInt(args.limit, 10);

    const withStats = (await Promise.all(
      files.map(async (file) => {
        try {
          const stat = await fs.stat(path.join(searchDir, file));
          return { path: folderPrefix ? path.posix.join(folderPrefix, file) : file, mtime: stat.mtime };
        } catch (e) {
          if (e.code === "ENOENT") return null;
          throw e;
        }
      })
    )).filter(Boolean);

    const sorted = withStats
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit);

    return {
      content: [{
        type: "text",
        text: sorted.map(f => `${linkFor(f.path)} (${f.mtime.toISOString().split("T")[0]})`).join("\n")
      }]
    };
  }

  // ── Graph & Connections ─────────────────────────────────────────────

  async function handleLinks(args) {
    const { rel: resolvedVaultRelative, abs: filePath } = await resolveNote(args.path);
    let content;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`File not found: ${resolvedVaultRelative}`, { cause: e });
      throw e;
    }

    const result = { outgoing: [], incoming: [] };

    if (args.direction !== "incoming") {
      result.outgoing = extractWikilinks(content);
    }

    if (args.direction !== "outgoing") {
      const { allFiles, resolver } = await freshGraph();
      const linkingFiles = await findFilesLinkingTo(resolvedVaultRelative, vaultPath, allFiles, resolver);
      result.incoming = linkingFiles.map(({ file }) => file);
    }

    let output = "";
    if (result.outgoing.length > 0) {
      output += `**Outgoing links:**\n${result.outgoing.map(l => `- [[${l}]]`).join("\n")}\n\n`;
    }
    if (result.incoming.length > 0) {
      output += `**Incoming links:**\n${result.incoming.map(l => `- ${linkFor(l)}`).join("\n")}`;
    }

    return { content: [{ type: "text", text: output || "No links found" }] };
  }

  async function handleNeighborhood(args) {
    const { rel: resolvedPath, abs: resolvedAbs } = await resolveNote(args.path);
    const depth = Math.min(positiveInt(args.depth, 2), 5);
    const direction = args.direction || "both";
    const maxNodes = positiveInt(args.max_nodes, DEFAULT_MAX_NODES);

    const { allFiles, resolver } = await freshGraph();
    const result = await exploreNeighborhood({
      startPath: resolvedPath,
      vaultPath,
      allFiles,
      resolver,
      depth,
      direction,
      maxNodes,
    });

    let text = formatNeighborhood(result, {
      startPath: resolvedPath,
      depth,
      direction,
      formatPath: linkFor,
    });

    // --- Semantic expansion (Tier 3) ---
    const semanticSkipReason = args.include_semantic ? await semanticUnavailableReason() : null;
    if (semanticSkipReason) {
      text += `\n(Semantic expansion skipped: ${semanticSkipReason})\n`;
    } else if (args.include_semantic) {
      const noteContent = await fs.readFile(resolvedAbs, "utf-8");
      const body = splitFrontmatter(noteContent).body.trim();

      if (body) {
        const semanticLimit = args.semantic_limit || 5;
        let semanticResults = [];
        try {
          semanticResults = await semanticIndex.searchRaw({
            query: body.slice(0, 8000),
            limit: semanticLimit * 2,
            excludeFiles: new Set([resolvedPath])
          });
        } catch (e) {
          // Quota ran out during this very call: keep the graph output, say why semantics are missing.
          if (semanticIndex.health?.().status !== "disabled") throw e;
          text += `\n(Semantic expansion skipped: ${e.message})\n`;
        }

        // Every linked node counts, including those beyond max_nodes
        const unlinked = semanticResults.filter(r => !result.discovered.has(r.path)).slice(0, semanticLimit);

        if (unlinked.length > 0) {
          text += `\n**Semantically related (unlinked)** (${unlinked.length} node${unlinked.length === 1 ? "" : "s"})\n`;
          for (const r of unlinked) {
            let line = `- ${linkFor(r.path)} (similarity: ${r.score})`;
            try {
              const fc = await fs.readFile(path.join(vaultPath, r.path), "utf-8");
              const fm = extractFrontmatter(fc);
              const meta = [];
              if (fm?.type) meta.push(`type: ${fm.type}`);
              const fmTags = toTagList(fm?.tags);
              if (fmTags.length) meta.push(`tags: ${fmTags.join(", ")}`);
              if (meta.length > 0) line += `\n  ${meta.join(" | ")}`;
            } catch (e) { if (e.code !== "ENOENT") throw e; }
            text += line + "\n";
          }
        }
      }
    }

    return { content: [{ type: "text", text }] };
  }

  async function handleQuery(args) {
    const searchDir = args.folder ? await resolveFolder(args.folder) : vaultPath;
    const files = await getAllMarkdownFiles(searchDir);
    const limit = positiveInt(args.limit, 50);
    const results = [];

    const filters = {
      type: args.type,
      status: args.status,
      tags: args.tags,
      tags_any: args.tags_any,
      created_after: args.created_after,
      created_before: args.created_before,
      custom_fields: args.custom_fields,
    };

    for (const file of files) {
      if (!args.sort_by && results.length >= limit) break;
      const filePath = path.join(searchDir, file);
      let content;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const metadata = extractFrontmatter(content);

      if (matchesFilters(metadata, filters)) {
        const { summary, tagLine } = formatMetadata(metadata);
        const relativePath = toVaultRel(path.relative(vaultPath, path.join(searchDir, file)));
        results.push({ path: relativePath, summary, tagLine, metadata });
      }
    }

    // Sort results if sort_by specified
    if (args.sort_by) {
      const sortField = args.sort_by;
      const sortDesc = args.sort_order === "desc";
      results.sort((a, b) => {
        const cmp = compareFrontmatterValues(a.metadata[sortField], b.metadata[sortField], sortField);
        return sortDesc ? -cmp : cmp;
      });
    }

    // Apply limit after sorting
    const limited = results.slice(0, limit);

    if (limited.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No notes found matching the query."
        }]
      };
    }

    const output = `Found ${limited.length} note${limited.length === 1 ? "" : "s"} matching query:\n\n` +
      limited.map(r => {
        let entry = `**${linkFor(r.path)}**\n${r.summary}`;
        if (r.tagLine) entry += `\n${r.tagLine}`;
        return entry;
      }).join("\n\n");

    return { content: [{ type: "text", text: output }] };
  }

  async function handleTags(args) {
    const searchDir = args.folder ? await resolveFolder(args.folder) : vaultPath;
    const files = await getAllMarkdownFiles(searchDir);
    const tagCounts = new Map();
    let notesWithTags = 0;

    for (const file of files) {
      const filePath = path.join(searchDir, file);
      let content;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }

      const fileTags = new Set();

      const metadata = extractFrontmatter(content);
      if (metadata) {
        for (const tag of toTagList(metadata.tags)) {
          if (tag) fileTags.add(String(tag).toLowerCase());
        }
      }

      if (args.include_inline) {
        for (const tag of extractInlineTags(content)) {
          fileTags.add(tag);
        }
      }

      if (fileTags.size > 0) {
        notesWithTags++;
        for (const tag of fileTags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }

    let results = Array.from(tagCounts.entries());
    if (args.pattern) {
      results = results.filter(([tag]) => matchesTagPattern(tag, args.pattern));
    }

    results.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No tags found matching criteria." }]
      };
    }

    const header = `Found ${results.length} unique tag${results.length === 1 ? "" : "s"} across ${notesWithTags} note${notesWithTags === 1 ? "" : "s"}\n`;
    const lines = results.map(([tag, count]) => `${tag} (${count})`);

    return {
      content: [{ type: "text", text: header + "\n" + lines.join("\n") }]
    };
  }

  async function handleActivity(args) {
    if (!activityLog) {
      throw new Error("Activity log unavailable (database failed to initialize at startup)");
    }
    const action = args.action || "query";

    if (action === "query") {
      const entries = activityLog?.query({
        limit: positiveInt(args.limit, 50),
        tool: args.tool,
        session: args.session,
        since: args.since,
        before: args.before,
        path: args.path
      }) || [];

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `No activity entries found. (current session: ${sessionId.slice(0, SESSION_ID_DISPLAY_LEN)})` }]
        };
      }

      const formatted = entries.map(e => {
        const ts = e.timestamp.replace("T", " ").slice(0, 19);
        const sessionShort = e.session_id.slice(0, SESSION_ID_DISPLAY_LEN);
        return `[${ts}] [${sessionShort}] ${e.tool_name}\n${e.args_json}`;
      }).join("\n\n");

      return {
        content: [{
          type: "text",
          text: `Activity log (${entries.length} entr${entries.length === 1 ? "y" : "ies"}, current session: ${sessionId.slice(0, SESSION_ID_DISPLAY_LEN)}):\n\n${formatted}`
        }]
      };
    }

    if (action === "clear") {
      const deleted = activityLog?.clear({
        session: args.session,
        tool: args.tool,
        before: args.before
      }) || 0;

      return {
        content: [{
          type: "text",
          text: `Cleared ${deleted} activity entr${deleted === 1 ? "y" : "ies"}.`
        }]
      };
    }

    throw new Error(`Unknown action: ${action}. Use 'query' or 'clear'.`);
  }

  async function handleSemanticSearch(args) {
    await requireSemantic("Semantic search");

    const resolvedFolder = args.folder ? toVaultRel(path.relative(vaultPath, await resolveFolder(args.folder))) : undefined;

    // --- Anchor blending (Tier 3) ---
    if (args.anchor) {
      // Containment first, so an escaping anchor reports an escape rather than "Anchor note not found" from the catch below.
      await safe(args.anchor);
      let resolvedAnchor;
      try {
        ({ rel: resolvedAnchor } = await resolveNote(args.anchor));
      } catch (e) {
        throw new Error(`Anchor note not found: ${args.anchor}. Provide a valid vault-relative path.`, { cause: e });
      }
      const targetLimit = args.limit || 5;
      const rawResults = await semanticIndex.searchRaw({
        query: args.query,
        limit: targetLimit * 2,
        folder: resolvedFolder,
        threshold: args.threshold,
        excludeFiles: new Set([resolvedAnchor])
      });

      const { allFiles, resolver } = await freshGraph();
      const neighborhood = await exploreNeighborhood({
        startPath: resolvedAnchor,
        vaultPath,
        allFiles,
        resolver,
        depth: 3,
        direction: "both",
      });

      const graphWeight = args.graph_weight ?? 0.3;
      if (typeof graphWeight !== "number" || Number.isNaN(graphWeight) || graphWeight < 0 || graphWeight > 1) {
        throw new Error(`graph_weight must be a number between 0 and 1, got: ${args.graph_weight}`);
      }
      const trimmed = blendWithGraph(rawResults, neighborhood, graphWeight, targetLimit);
      const staleFooter = formatStaleFooter(semanticIndex.health?.().staleFiles ?? 0);

      if (trimmed.length === 0) {
        return { content: [{ type: "text", text: `No semantically related notes found.${staleFooter}` }] };
      }

      const formatted = trimmed.map(r => {
        const graphInfo = r.depth !== null ? `graph: depth ${r.depth}` : "not in graph";
        return `**${linkFor(r.path)}** (combined: ${r.combined}, semantic: ${r.score}, ${graphInfo})\n${r.preview}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${trimmed.length} result${trimmed.length === 1 ? "" : "s"} (anchored to ${linkFor(args.anchor)}):\n\n${formatted}${staleFooter}` }]
      };
    }

    // Normal path (no anchor)
    const text = await semanticIndex.search({
      query: args.query,
      limit: args.limit || 5,
      folder: resolvedFolder,
      threshold: args.threshold,
      formatPath: linkFor,
    });
    return { content: [{ type: "text", text }] };
  }

  async function handleSuggestLinks(args) {
    await requireSemantic("Link suggestions");

    const resolvedFolder = args.folder ? toVaultRel(path.relative(vaultPath, await resolveFolder(args.folder))) : undefined;

    let inputText = args.content;
    const sourcePath = args.path;
    if (!inputText && !sourcePath) {
      throw new Error("Either 'content' or 'path' must be provided");
    }
    const source = sourcePath ? await resolveNote(sourcePath) : null;
    if (!inputText) {
      inputText = await fs.readFile(source.abs, "utf-8");
    }

    const body = splitFrontmatter(inputText).body.trim();
    if (!body) throw new Error("No content to analyze");

    const { allFiles, resolver } = await freshGraph();
    const linkedPaths = collectLinkedPaths(inputText, resolver);

    const excludeFiles = new Set();
    if (source) excludeFiles.add(source.rel);

    const overfetch = args.graph_context ? 5 : 3;
    const results = await semanticIndex.searchRaw({
      query: body.slice(0, 8000),
      limit: (args.limit || 5) * overfetch,
      folder: resolvedFolder,
      threshold: args.threshold,
      excludeFiles
    });

    const candidateLimit = args.graph_context ? (args.limit || 5) * overfetch : (args.limit || 5);
    const suggestions = [];
    for (const r of results) {
      if (suggestions.length >= candidateLimit) break;
      if (linkedPaths.has(r.path)) continue;
      suggestions.push(r);
    }

    // --- Graph context blending (Tier 3) ---
    if (args.graph_context && !sourcePath) {
      throw new Error("graph_context requires 'path' parameter (cannot build graph neighborhood from raw content)");
    }
    if (args.graph_context && sourcePath) {
      const neighborhood = await exploreNeighborhood({
        startPath: source.rel,
        vaultPath,
        allFiles,
        resolver,
        depth: 2,
        direction: "both",
      });

      const blended = blendWithGraph(suggestions, neighborhood, 0.3, args.limit || 5);
      const trimmedBlended = blended.map(r => ({ ...r, missingLink: r.depth === null }));

      if (trimmedBlended.length === 0) {
        return { content: [{ type: "text", text: "No link suggestions found." }] };
      }

      const formatted = trimmedBlended.map(r => {
        const graphInfo = r.depth !== null ? `graph: depth ${r.depth}` : "missing link";
        return `**${linkFor(r.path)}** (combined: ${r.combined}, semantic: ${r.score}, ${graphInfo})\n${r.preview}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${trimmedBlended.length} link suggestion${trimmedBlended.length === 1 ? "" : "s"} for ${linkFor(sourcePath)}:\n\n${formatted}` }]
      };
    }

    if (suggestions.length === 0) {
      return { content: [{ type: "text", text: "No link suggestions found." }] };
    }

    const formatted = suggestions.map(r =>
      `**${linkFor(r.path)}** (score: ${r.score})\n${r.preview}`
    ).join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${suggestions.length} link suggestion${suggestions.length === 1 ? "" : "s"}:\n\n${formatted}` }]
    };
  }

  // ── Organization & Maintenance ──────────────────────────────────────

  async function handleTrash(args) {
    const resolvedRelative = toVaultRel(args.path);
    const filePath = await safe(resolvedRelative);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`ENOENT: File not found: ${resolvedRelative}`, { cause: e });
      throw e;
    }
    // Dot-folder directories fall through to the write rule; other folders get the folder message.
    if (stat.isDirectory() && !hasDotSegment(resolvedRelative)) {
      throw new Error(`Cannot trash a folder: ${resolvedRelative}. vault_trash only trashes individual notes; trash the notes inside it one by one.`);
    }
    await writableNote(resolvedRelative);

    // Find incoming links for warning output
    const { allFiles, resolver } = await freshGraph();
    const linkingFiles = await findFilesLinkingTo(resolvedRelative, vaultPath, allFiles, resolver);

    // Determine trash destination: .trash/<original-relative-path>
    let trashRelative = path.posix.join(".trash", toVaultRel(resolvedRelative));
    let trashAbsolute = path.join(vaultPath, trashRelative);

    // Handle collision: append timestamp suffix
    try {
      await fs.access(trashAbsolute);
      // Collision — add timestamp
      const ext = path.extname(resolvedRelative);
      const base = resolvedRelative.slice(0, -ext.length);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      trashRelative = path.posix.join(".trash", toVaultRel(`${base}.${timestamp}${ext}`));
      trashAbsolute = path.join(vaultPath, trashRelative);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // No collision — use original path
    }

    const indexedPath = await sameNameOnDisk(resolvedRelative);

    // Create trash directory and move file
    await fs.mkdir(path.dirname(trashAbsolute), { recursive: true });
    if (stat.isDirectory()) await fs.rename(filePath, trashAbsolute);
    else await withNoteLock(filePath, () => fs.rename(filePath, trashAbsolute));

    fileIndex.remove(resolvedRelative);
    await semanticIndex?.notifyRemoved?.(indexedPath);

    // Build output
    let text = `Trashed ${resolvedRelative} → ${linkFor(trashRelative)}`;
    if (linkingFiles.length > 0) {
      text += `\n\n**Warning:** ${linkingFiles.length} file${linkingFiles.length === 1 ? "" : "s"} had links to this note (now broken):`;
      for (const { file } of linkingFiles) {
        text += `\n- ${linkFor(file)}`;
      }
    }

    return { content: [{ type: "text", text }] };
  }

  async function handleMove(args) {
    // Both source and destination require exact paths (destructive operation)
    const oldRelative = toVaultRel(args.old_path);
    const oldAbsolute = await safe(oldRelative);
    const newRelative = toVaultRel(args.new_path);
    const newAbsolute = await safe(newRelative);

    let sourceStat;
    try {
      sourceStat = await fs.stat(oldAbsolute);
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`ENOENT: File not found: ${oldRelative}`, { cause: e });
      throw e;
    }
    const assertMovable = sourceStat.isDirectory() ? writableFolder : writableNote;
    await assertMovable(oldRelative);
    await assertMovable(newRelative);

    // On a case-insensitive filesystem "Note.md" -> "note.md" stats the source itself.
    // Only a case variant of the same entry may proceed; any other existing destination is refused.
    let destStat = null;
    try {
      destStat = await fs.stat(newAbsolute);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const caseOnlyRename = destStat !== null &&
      destStat.ino === sourceStat.ino && destStat.dev === sourceStat.dev &&
      oldRelative !== newRelative && oldRelative.toLowerCase() === newRelative.toLowerCase();
    if (destStat && !caseOnlyRename) {
      throw new Error(`Destination already exists: ${newRelative}. Use vault_edit or vault_trash + vault_write instead.`);
    }

    // Links are judged against the vault as it was before the move
    const isNote = !sourceStat.isDirectory();
    const updateLinks = args.update_links !== false && isNote;
    const { allFiles: filesBefore, resolver } = await freshGraph();
    const linkingFiles = updateLinks
      ? await findFilesLinkingTo(oldRelative, vaultPath, filesBefore, resolver)
      : [];

    // New link text: bare basename when it will resolve uniquely to the moved note, else the full path
    const filesAfter = filesBefore.filter(f => f !== oldRelative).concat(newRelative);
    const newBasename = path.posix.basename(newRelative, ".md");
    const afterResolution = createLinkResolver(filesAfter).resolve(newBasename);
    const basenameUnique = afterResolution.status === "resolved" && afterResolution.path === newRelative;
    const newLinkTarget = basenameUnique ? newBasename : newRelative.replace(/\.md$/, "");

    const indexedOldPath = await sameNameOnDisk(oldRelative);

    // Create destination directory and move file
    await fs.mkdir(path.dirname(newAbsolute), { recursive: true });
    const renameNote = async () => {
      if (!caseOnlyRename) return fs.rename(oldAbsolute, newAbsolute);
      // Some case-insensitive filesystems ignore a direct case-only rename; go through a temp name.
      const tempAbsolute = path.join(path.dirname(oldAbsolute), `.${path.basename(oldAbsolute)}.${process.pid}.${Date.now()}.case-rename`);
      await fs.rename(oldAbsolute, tempAbsolute);
      try {
        await fs.rename(tempAbsolute, newAbsolute);
      } catch (e) {
        await fs.rename(tempAbsolute, oldAbsolute);
        throw e;
      }
    };
    // Under the note's lock, an in-flight append finishes first and a later one finds the old path gone.
    try {
      if (sourceStat.isDirectory()) await renameNote();
      else await withNoteLock(oldAbsolute, renameNote);
    } catch (e) {
      if (e.code === "ENOENT") throw new Error(`ENOENT: File not found: ${oldRelative}`, { cause: e });
      throw e;
    }

    fileIndex.rename(oldRelative, newRelative);
    semanticIndex?.notifyMoved?.(indexedOldPath, newRelative);

    // Rewrite wikilinks in referring files, and in the moved note itself for its self-links
    let updatedCount = 0;
    const failedRewrites = [];
    if (updateLinks) {
      // Each rewrite is recomputed from the file's current content, not the scan-time copy.
      const toRewrite = [...linkingFiles.map(({ file }) => file), newRelative];
      for (const file of new Set(toRewrite)) {
        let result;
        try {
          result = await mutateFile(path.join(vaultPath, file), (content) => rewriteWikilinks(content, { resolver, movedFrom: oldRelative, newTarget: newLinkTarget }));
        } catch (e) {
          if (e.code === "ENOENT") continue;
          failedRewrites.push(file);
          continue;
        }
        if (result.after !== result.before) {
          updatedCount++;
          semanticIndex?.notifyChanged?.(toVaultRel(file));
        }
      }
    }

    // Build output
    let text = `Moved ${oldRelative} → ${linkFor(newRelative)}`;
    if (updatedCount > 0) {
      text += `\nUpdated wikilinks in ${updatedCount} file${updatedCount === 1 ? "" : "s"}`;
    }
    if (failedRewrites.length > 0) {
      text += `\nCould not update links in ${failedRewrites.length} file${failedRewrites.length === 1 ? "" : "s"} (changing on disk, read-only or locked); fix by hand: ${failedRewrites.join(", ")}`;
    }
    if (isNote && !basenameUnique) {
      const sameName = filesAfter.filter(f => path.posix.basename(f, ".md").toLowerCase() === newBasename.toLowerCase()).length;
      text += `\n\n**Note:** Basename "${newBasename}" is ambiguous (${sameName} files). Links were rewritten using full paths.`;
    }

    return { content: [{ type: "text", text }] };
  }

  async function handleUpdateFrontmatter(args) {
    const filePath = await safe(args.path);
    await writableNote(args.path);
    let frontmatter;
    try {
      await mutateFile(filePath, (content) => {
        const updated = updateFrontmatter(content, args.fields || {});
        frontmatter = updated.frontmatter;
        return updated.content;
      });
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${args.path}`, { cause: e });
      }
      throw relError(e, args.path);
    }

    semanticIndex?.notifyChanged?.(await onDiskPath(args.path));
    const lines = Object.entries(frontmatter).map(([k, v]) => {
      const display = Array.isArray(v) ? `[${v.join(", ")}]` : String(v);
      return `${k}: ${display}`;
    });
    return {
      content: [{ type: "text", text: `Updated frontmatter in ${linkFor(args.path)}:\n${lines.join("\n")}` }]
    };
  }

  async function handleAddLinks(args) {
    const { path: filePath, links, section = "## Related", create_section = true } = args;

    if (!links || links.length === 0) {
      throw new Error("At least one link is required");
    }

    // Exact path only — destructive operation
    const absPath = await safe(filePath);
    await writableNote(filePath);
    const { allFiles, resolver } = await freshGraph();
    const noteSet = new Set(allFiles);

    let added = [];
    let skipped = [];
    try {
      await mutateFile(absPath, (original) => {
        added = [];
        skipped = [];
        let content = original;

        // Deduplicate against the notes the existing links resolve to (ambiguous links count for each candidate)
        const alreadyLinked = collectLinkedPaths(content, resolver);

        for (const { target, annotation = "" } of links) {
          const targetWithExt = target.endsWith(".md") ? target : target + ".md";

          if (!noteSet.has(targetWithExt)) {
            skipped.push({ target, reason: "not found" });
            continue;
          }

          if (alreadyLinked.has(targetWithExt)) {
            skipped.push({ target, reason: "already linked" });
            continue;
          }

          // Bare basename only when it resolves back to this exact note
          const basename = path.posix.basename(targetWithExt, ".md");
          const byBasename = resolver.resolve(basename);
          const displayName = byBasename.status === "resolved" && byBasename.path === targetWithExt
            ? basename
            : targetWithExt.replace(/\.md$/, "");
          const entry = annotation
            ? `- [[${displayName}]] — ${annotation}`
            : `- [[${displayName}]]`;
          added.push(entry);
          alreadyLinked.add(targetWithExt);
        }

        if (added.length === 0) return original;

        if (matchHeadings(parseHeadings(content), section).length === 0) {
          if (!create_section) {
            throw new Error(`Section "${section}" not found in ${filePath}. Set create_section: true to create it.`);
          }
          const sectionBlock = (content.endsWith("\n") ? "\n" : "\n\n") + section + "\n";
          content = content + sectionBlock;
          if (matchHeadings(parseHeadings(content), section).length === 0) {
            throw new Error(`Failed to create section "${section}" in ${filePath}. Ensure the section parameter is a valid markdown heading (e.g., "## Related").`);
          }
        }
        const range = findSection(content, section);

        const insertText = added.join("\n") + "\n";
        return content.slice(0, range.sectionEnd) + insertText + content.slice(range.sectionEnd);
      });
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`File not found: ${filePath}. Use vault_write to create new files.`, { cause: e });
      }
      throw relError(e, filePath);
    }

    if (added.length > 0) semanticIndex?.notifyChanged?.(await onDiskPath(filePath));
    if (added.length === 0 && skipped.length > 0) {
      const skipSummary = skipped.map(s => `${path.basename(s.target, ".md")} (${s.reason})`).join(", ");
      return {
        content: [{ type: "text", text: `No links added to ${filePath}.\nSkipped ${skipped.length}: ${skipSummary}` }]
      };
    }

    let summary = `Added ${added.length} link${added.length === 1 ? "" : "s"} to ${linkFor(filePath)} (${section}):\n${added.join("\n")}`;
    if (skipped.length > 0) {
      const skipSummary = skipped.map(s => `${path.basename(s.target, ".md")} (${s.reason})`).join(", ");
      summary += `\nSkipped ${skipped.length}: ${skipSummary}`;
    }
    return { content: [{ type: "text", text: summary }] };
  }

  async function handleLinkHealth(args) {
    const { checks = ["orphans", "broken", "weak", "ambiguous"], limit = 20 } = args;
    const { allFiles: allFilesList, resolver } = await freshGraph();

    // Scope to folder if specified
    let scopedFiles;
    if (args.folder) {
      const resolvedFolder = await resolveFolder(args.folder);
      const relFolder = toVaultRel(path.relative(vaultPath, resolvedFolder));
      scopedFiles = allFilesList.filter(f => f.startsWith(relFolder + "/"));
    } else {
      scopedFiles = allFilesList;
    }

    const sections = [];
    const totalScanned = scopedFiles.length;

    // Pre-compute: outgoing links per file (single pass)
    const fileData = new Map();
    for (const file of scopedFiles) {
      let content;
      try {
        content = await fs.readFile(path.join(vaultPath, file), "utf-8");
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const outgoing = extractWikilinks(content);
      const resolved = outgoing.map(link => {
        const resolution = resolver.resolve(link);
        return { raw: link, paths: resolutionPaths(resolution), ambiguous: resolution.status === "ambiguous" };
      });
      const fm = extractFrontmatter(content);
      fileData.set(file, { resolved, frontmatter: fm });
    }

    // Build incoming index once — O(M) instead of per-file findFilesLinkingTo O(N*M)
    const needsIncoming = checks.includes("orphans") || checks.includes("weak");
    const incomingIndex = needsIncoming
      ? await buildIncomingIndex(vaultPath, allFilesList, resolver)
      : null;

    if (checks.includes("orphans")) {
      const orphans = [];
      for (const file of scopedFiles) {
        const data = fileData.get(file);
        if (!data) continue;
        const hasOutgoing = data.resolved.some(r => r.paths.length > 0);
        const incomingCount = incomingIndex.get(file)?.size || 0;
        if (!hasOutgoing && incomingCount === 0) {
          const fm = data.frontmatter;
          orphans.push(`- ${linkFor(file)} (type: ${fm?.type || "unknown"}, created: ${fm?.created || "unknown"})`);
        }
        if (orphans.length >= limit) break;
      }
      sections.push(`**Orphan notes** (${orphans.length}):\n${orphans.length > 0 ? orphans.join("\n") : "None found"}`);
    }

    if (checks.includes("broken")) {
      const broken = [];
      for (const file of scopedFiles) {
        const data = fileData.get(file);
        if (!data) continue;
        for (const r of data.resolved) {
          if (r.paths.length === 0) {
            // Skip non-markdown targets (images, PDFs, etc.) — they aren't notes by design
            const raw = r.raw;
            const dotIdx = raw.lastIndexOf(".");
            if (dotIdx !== -1) {
              const ext = raw.slice(dotIdx + 1).toLowerCase();
              if (ext !== "md") continue;
            }
            broken.push(`- ${linkFor(file)} → [[${r.raw}]] (no matching file)`);
            if (broken.length >= limit) break;
          }
        }
        if (broken.length >= limit) break;
      }
      sections.push(`**Broken links** (${broken.length}):\n${broken.length > 0 ? broken.join("\n") : "None found"}`);
    }

    if (checks.includes("weak")) {
      const weak = [];
      for (const file of scopedFiles) {
        const data = fileData.get(file);
        if (!data) continue;
        const validOutgoing = data.resolved.filter(r => r.paths.length > 0).length;
        const incomingCount = incomingIndex.get(file)?.size || 0;
        const total = validOutgoing + incomingCount;
        if (total === 1) {
          weak.push(`- ${linkFor(file)} (${validOutgoing} outgoing, ${incomingCount} incoming)`);
        }
        if (weak.length >= limit) break;
      }
      sections.push(`**Weakly connected** (${weak.length}):\n${weak.length > 0 ? weak.join("\n") : "None found"}`);
    }

    if (checks.includes("ambiguous")) {
      const ambiguous = [];
      const seen = new Set();
      for (const file of scopedFiles) {
        const data = fileData.get(file);
        if (!data) continue;
        for (const r of data.resolved) {
          if (r.ambiguous && !seen.has(r.raw)) {
            seen.add(r.raw);
            ambiguous.push(`- ${linkFor(file)} → [[${r.raw}]] resolves to ${r.paths.length} files`);
            if (ambiguous.length >= limit) break;
          }
        }
        if (ambiguous.length >= limit) break;
      }
      sections.push(`**Ambiguous links** (${ambiguous.length}):\n${ambiguous.length > 0 ? ambiguous.join("\n") : "None found"}`);
    }

    const header = args.folder
      ? `Link health report for ${args.folder}/ (${totalScanned} notes scanned)`
      : `Link health report (${totalScanned} notes scanned)`;

    return { content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n")}` }] };
  }

  return new Map([
    ["vault_read", handleRead],
    ["vault_write", handleWrite],
    ["vault_append", handleAppend],
    ["vault_edit", handleEdit],
    ["vault_search", handleSearch],
    ["vault_list", handleList],
    ["vault_recent", handleRecent],
    ["vault_links", handleLinks],
    ["vault_neighborhood", handleNeighborhood],
    ["vault_query", handleQuery],
    ["vault_tags", handleTags],
    ["vault_activity", handleActivity],
    ["vault_semantic_search", handleSemanticSearch],
    ["vault_suggest_links", handleSuggestLinks],
    ["vault_peek", handlePeek],
    ["vault_trash", handleTrash],
    ["vault_move", handleMove],
    ["vault_update_frontmatter", handleUpdateFrontmatter],
    ["vault_add_links", handleAddLinks],
    ["vault_link_health", handleLinkHealth],
  ]);
}
