
// Appended to tools whose output renders vault paths as obsidian:// markdown links.
// Tells the model how to extract a canonical path from those links when feeding them
// back to other vault tools — preventing it from passing a `[path](url)` string
// into a `path` argument.
const LINK_FORMAT_NOTE = " Paths in this tool's output are formatted as markdown links `[vault-relative-path.md](obsidian://...)` so users can Cmd/Ctrl-click to open in Obsidian. Preserve the link form when relaying paths to the user; pass only the bracket text (e.g. `01-Projects/Foo/note.md`) to other vault tools' `path` arguments, never the full markdown link.";

/**
 * Build the MCP tool definitions list.
 * @param {string} templateDescriptions - formatted template list for vault_write description
 * @param {string[]} templateNames - available template names for vault_write enum
 * @param {boolean} hasSemanticIndex - whether semantic search tools should be included
 * @returns {Array<Object>} MCP tool definitions
 */
export function createToolsList(templateDescriptions, templateNames, hasSemanticIndex) {
  const tools = [
    {
      name: "vault_read",
      description: "Read the contents of a markdown file from the vault. Supports pagination: read a single section by heading, last N lines, last N heading-level sections, chunk number, or line range. Files exceeding ~80k characters auto-redirect to peek data (file structure/outline) unless a pagination param or force=true is specified." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root (supports short names, e.g. 'devlog')" },
          heading: { type: "string", description: "Read only the section under this heading (exact match, case-sensitive). Returns heading line + content until next same-or-higher-level heading." },
          tail: { type: "number", description: "Return the last N lines of the file. Frontmatter is always prepended." },
          tail_sections: { type: "number", description: "Return the last N sections at the specified heading level. Frontmatter is always prepended." },
          section_level: { type: "number", description: "Heading level for tail_sections (1=`#`, 2=`##`, etc). Default: 2.", default: 2 },
          chunk: { type: "number", description: "Read a specific chunk of the file (1-indexed). Each chunk is ~80k characters. Use vault_peek to see total chunks." },
          lines: {
            type: "object",
            description: "Read a range of lines from the file (1-indexed, inclusive).",
            properties: {
              start: { type: "number", description: "Start line (1-indexed, inclusive)" },
              end: { type: "number", description: "End line (1-indexed, inclusive)" }
            },
            required: ["start", "end"]
          },
          force: { type: "boolean", description: "Bypass auto-redirect for large files. WARNING: only use when full content is essential, as large files degrade model performance. Hard-capped at ~400k chars (~100k tokens)." }
        },
        required: ["path"]
      }
    },
    {
      name: "vault_peek",
      description: "Inspect a file's metadata and structure without reading full content. Returns file size, frontmatter, heading outline with approximate section sizes, and a brief preview. Use this to plan which sections to read from large files." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root (supports fuzzy resolution: 'devlog' resolves to full path)" }
        },
        required: ["path"]
      }
    },
    {
      name: "vault_write",
      description: `Create a new note from a template. Notes must be created from templates to ensure proper frontmatter.

Available templates:
${templateDescriptions || "(Loading...)"}

Built-in variables (auto-substituted):
- <% tp.date.now("YYYY-MM-DD") %> - Current date
- <% tp.file.title %> - Derived from output path filename

Required: frontmatter.tags - provide at least one tag for the note.
Optional: frontmatter.status, frontmatter.priority, frontmatter.project, frontmatter.deciders, frontmatter.due, frontmatter.source (depending on template type).
Pass custom <%...%> variables via the 'variables' parameter.` + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "Template name (filename without .md from 05-Templates/)",
            enum: templateNames
          },
          path: { type: "string", description: "Output path relative to vault root" },
          variables: {
            type: "object",
            description: "Custom variables for <%...%> patterns in body (key-value string pairs)",
            additionalProperties: { type: "string" }
          },
          frontmatter: {
            type: "object",
            description: "Frontmatter fields to set (e.g., {tags: ['tag1', 'tag2'], status: 'active'})",
            properties: {
              tags: { type: "array", items: { type: "string" }, description: "Tags for the note (required)" },
              status: { type: "string", description: "Note status. For tasks: pending, active, done, cancelled" },
              priority: { type: "string", description: "Priority level. For tasks: low, normal, high, urgent" },
              project: { type: "string", description: "Project name (for devlogs)" },
              deciders: { type: "string", description: "Decision makers (for ADRs)" },
              due: { type: "string", description: "Due date (for tasks)" },
              source: { type: "string", description: "Source reference (for tasks)" }
            }
          },
          createDirs: { type: "boolean", description: "Create parent directories if they don't exist", default: true }
        },
        required: ["template", "path"]
      }
    },
    {
      name: "vault_append",
      description: "Append content to an existing file, optionally under a specific heading. When 'position' is specified, heading is required and must exist in the file." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root" },
          content: { type: "string", description: "Content to append" },
          heading: { type: "string", description: "Optional: append under this heading (e.g., '## Notes')" },
          position: { type: "string", enum: ["after_heading", "before_heading", "end_of_section"], description: "Where to insert relative to heading. after_heading: right after the heading line. before_heading: right before the heading line. end_of_section: at the end of the section (before the next same-or-higher-level heading, or EOF). Requires heading." }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "vault_edit",
      description: "Edit a file by replacing an exact string match. The old_string must appear exactly once in the file for safety." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root" },
          old_string: { type: "string", description: "Exact string to find (must match exactly once)" },
          new_string: { type: "string", description: "Replacement string" }
        },
        required: ["path", "old_string", "new_string"]
      }
    },
    {
      name: "vault_update_frontmatter",
      description: "Update YAML frontmatter fields in an existing note. Parses existing frontmatter, updates specified fields, preserves everything else. Set a field to null to remove it. Protected fields (type, created, tags) cannot be removed. Field values are validated against the note's type (e.g. task status must be: pending, active, done, cancelled; task priority must be: low, normal, high, urgent)." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root (exact path required)" },
          fields: {
            type: "object",
            description: "Fields to update. Set value to null to remove a field. Arrays (like tags) are replaced wholesale.",
            additionalProperties: true
          }
        },
        required: ["path", "fields"]
      }
    },
    {
      name: "vault_search",
      description: "Search for text across all markdown files in the vault." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (case-insensitive)" },
          folder: { type: "string", description: "Optional: limit search to this folder (supports partial names, e.g. 'MyApp')" },
          limit: { type: "number", description: "Max results to return", default: 10 }
        },
        required: ["query"]
      }
    },
    {
      name: "vault_list",
      description: "List files and folders in the vault." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to vault root (supports partial names, e.g. 'MyApp'; default: root)", default: "" },
          recursive: { type: "boolean", description: "List recursively", default: false },
          pattern: { type: "string", description: "Glob pattern to filter (e.g., '*.md')" }
        }
      }
    },
    {
      name: "vault_recent",
      description: "Get recently modified files." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of files to return", default: 10 },
          folder: { type: "string", description: "Optional: limit to this folder (supports partial names, e.g. 'MyApp')" }
        }
      }
    },
    {
      name: "vault_links",
      description: "Get incoming and outgoing links for a note." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the note (supports short names, e.g. 'devlog')" },
          direction: { type: "string", enum: ["incoming", "outgoing", "both"], default: "both" }
        },
        required: ["path"]
      }
    },
    {
      name: "vault_neighborhood",
      description: "Explore the graph neighborhood around a note by traversing wikilinks. Returns notes grouped by hop distance from the starting note, with frontmatter metadata for each node. Useful for understanding clusters, finding related context, and discovering connections." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the starting note (supports short names, e.g. 'devlog')" },
          depth: { type: "number", description: "Traversal depth — how many hops to follow (default: 2, max: 5)", default: 2 },
          direction: {
            type: "string",
            enum: ["both", "outgoing", "incoming"],
            description: "Link direction to follow (default: both)",
            default: "both"
          },
          include_semantic: {
            type: "boolean",
            description: "Append semantically related but unlinked notes (requires VAULT_PKM_OPENAI_KEY, default: false)"
          },
          semantic_limit: {
            type: "number",
            description: "Max semantic results to include (default: 5)"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "vault_query",
      description: "Query notes by YAML frontmatter metadata (type, status, tags, dates, custom fields, sorting)." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by note type (exact match)" },
          status: { type: "string", description: "Filter by status (exact match)" },
          tags: { type: "array", items: { type: "string" }, description: "ALL tags must be present (case-insensitive)" },
          tags_any: { type: "array", items: { type: "string" }, description: "ANY tag must be present (case-insensitive)" },
          created_after: { type: "string", description: "Notes created on or after this date (YYYY-MM-DD)" },
          created_before: { type: "string", description: "Notes created on or before this date (YYYY-MM-DD)" },
          folder: { type: "string", description: "Limit search to this folder (supports partial names, e.g. 'MyApp')" },
          limit: { type: "number", description: "Max results to return", default: 50 },
          custom_fields: {
            type: "object",
            description: "Filter by arbitrary frontmatter fields (exact match). Use null to match missing fields.",
            additionalProperties: true
          },
          sort_by: {
            type: "string",
            description: "Sort results by this frontmatter field. Smart ordering: priority uses rank (urgent>high>normal>low), dates sort chronologically, others alphabetically. Nulls sort last."
          },
          sort_order: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction (default: asc)",
            default: "asc"
          },
        }
      }
    },
    {
      name: "vault_tags",
      description: "Discover all tags used across the vault with per-note occurrence counts. Useful for exploring tag conventions, finding hierarchical tag trees, and understanding vault organization.",
      inputSchema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Optional: limit to this folder (supports partial names, e.g. 'MyApp')" },
          pattern: { type: "string", description: "Glob-like filter: 'pkm/*' (hierarchical), '*research*' (substring), 'dev*' (prefix)" },
          include_inline: { type: "boolean", description: "Also parse inline #tags from note bodies (default: false, frontmatter only)", default: false }
        }
      }
    },
    {
      name: "vault_activity",
      description: "Query or clear the activity log. Shows tool calls made across sessions with timestamps and arguments. Use action 'query' to retrieve entries, 'clear' to delete entries.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["query", "clear"],
            description: "Action to perform (default: query)",
            default: "query"
          },
          limit: {
            type: "number",
            description: "Max entries to return (query only, default: 50)",
            default: 50
          },
          tool: {
            type: "string",
            description: "Filter by tool name (e.g., 'vault_read', 'vault_write')"
          },
          session: {
            type: "string",
            description: "Filter by session ID"
          },
          since: {
            type: "string",
            description: "Filter entries on or after this ISO timestamp (e.g., '2026-02-08')"
          },
          before: {
            type: "string",
            description: "Filter entries before this ISO timestamp"
          },
          path: {
            type: "string",
            description: "Filter by file path substring in arguments"
          }
        }
      }
    },
    {
      name: "vault_trash",
      description: "Soft-delete a file by moving it to .trash/ (Obsidian convention). Reports files with broken incoming links as warnings. Use vault_move to relocate files instead." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to trash (exact path required)" }
        },
        required: ["path"]
      }
    },
    {
      name: "vault_move",
      description: "Move or rename a markdown file within the vault. Automatically updates wikilinks in all files that reference the moved file. Both paths must be exact." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          old_path: { type: "string", description: "Current file path (exact path required)" },
          new_path: { type: "string", description: "Destination path (exact, must not already exist)" },
          update_links: { type: "boolean", description: "Update wikilinks in other files pointing to this note (default: true)", default: true }
        },
        required: ["old_path", "new_path"]
      }
    },
    {
      name: "vault_add_links",
      description: "Add annotated wikilinks to a note's section (default: ## Related). " +
        "Deduplicates by basename (skips links already present). " +
        "Creates the section if missing. Requires exact path." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact path to the note (vault-relative, e.g., '01-Projects/MyApp/research/caching.md')"
          },
          links: {
            type: "array",
            description: "Links to add",
            items: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "Vault-relative path to link target (e.g., 'notes/architecture-patterns.md')"
                },
                annotation: {
                  type: "string",
                  description: "One-line explanation of the relationship (e.g., 'foundational patterns this decision builds on')"
                }
              },
              required: ["target"]
            }
          },
          section: {
            type: "string",
            description: "Target section heading (default: '## Related')"
          },
          create_section: {
            type: "boolean",
            description: "Create section if missing (default: true)"
          }
        },
        required: ["path", "links"]
      }
    },
    {
      name: "vault_link_health",
      description: "Graph health report — finds orphan notes, broken wikilinks, weakly connected notes, " +
        "and ambiguous links. Scans all markdown files (or a specific folder). " +
        "Use to audit link quality and find notes that need better connections." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          folder: {
            type: "string",
            description: "Optional: scope to this folder (supports fuzzy folder resolution, e.g., 'MyApp')"
          },
          checks: {
            type: "array",
            items: {
              type: "string",
              enum: ["orphans", "broken", "weak", "ambiguous"]
            },
            description: "Which checks to run (default: all four). orphans = no links in/out, broken = links to missing files, weak = only 1 total link, ambiguous = basename resolves to multiple files"
          },
          limit: {
            type: "number",
            description: "Max results per category (default: 20)"
          }
        }
      }
    }
  ];

  if (hasSemanticIndex) {
    tools.push({
      name: "vault_semantic_search",
      description: "Search the vault using semantic similarity. Finds conceptually related notes even when they use different words. Requires VAULT_PKM_OPENAI_KEY." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query (e.g., 'managing information overload')" },
          limit: { type: "number", description: "Max results to return (default: 5)", default: 5 },
          folder: { type: "string", description: "Optional: limit search to this folder (e.g., '01-Projects')" },
          threshold: { type: "number", description: "Minimum similarity score 0-1 (default: no threshold)" },
          anchor: {
            type: "string",
            description: "Vault-relative path of a note to bias results toward (graph-distance weighting). Results closer to the anchor in the wikilink graph rank higher."
          },
          graph_weight: {
            type: "number",
            description: "Weight of graph proximity vs semantic similarity (0-1, default: 0.3). Higher values bias more toward graph neighbors."
          }
        },
        required: ["query"]
      }
    });
    tools.push({
      name: "vault_suggest_links",
      description: "Suggest relevant notes to link to based on content similarity. Accepts text content or a file path, finds semantically related notes, and excludes notes already linked via [[wikilinks]]. One of 'content' or 'path' is required." + LINK_FORMAT_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Text content to find link suggestions for. Takes precedence over path." },
          path: { type: "string", description: "Path to an existing note to suggest links for (supports short names, e.g. 'devlog'). Used if content is not provided." },
          limit: { type: "number", description: "Max suggestions to return (default: 5)", default: 5 },
          folder: { type: "string", description: "Optional: limit suggestions to this folder (e.g., '01-Projects')" },
          threshold: { type: "number", description: "Minimum similarity score 0-1 (default: no threshold)" },
          graph_context: { type: "boolean", description: "Blend semantic scores with graph proximity (default: false). When enabled, results include combined scores and flag notes not in the graph as missing links." }
        }
      }
    });
  }

  return tools;
}
