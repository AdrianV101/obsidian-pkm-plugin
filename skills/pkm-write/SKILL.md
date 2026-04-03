---
name: pkm-write
description: Use when writing to the vault — creating new notes (vault_write), editing existing notes (vault_edit, vault_append, vault_update_frontmatter). Handles duplicate checking, link discovery, annotations, and index updates for new notes. Provides guidelines for modifications.
---

# PKM Write — Vault Writing with Knowledge Graph Integration

Follow these steps when creating new notes. When running as a subagent, the delegation prompt provides the note topic and project context.

## Step 1: Duplicate Check

Before creating, search for existing notes on the same topic:

```
vault_semantic_search({ query: "<topic/title of intended note>", limit: 5 })
```

If `vault_semantic_search` is unavailable (no `OBSIDIAN_PKM_OPENAI_KEY`), use `vault_search` with the note's title and key terms, and `vault_query` with matching tags to check for duplicates.

**Route based on results:**
- **Close match (similarity > 0.8)**: **Update the existing note** instead of creating a new one. Read it with `vault_read`, then use `vault_append` to add new content or `vault_edit` to refine existing content. Use `vault_update_frontmatter` if metadata changed. Skip to Step 4 (Discover Connections) after updating.
- **Partial matches (0.5–0.8)**: Mention as potentially related, proceed with creation at Step 2. Link to them in Step 6.
- **No close matches**: Proceed with creation at Step 2.

## Step 2: Create the Note

Use `vault_write` with the appropriate template. Select the template and path based on content type:

| Content Type | Template | Default Path |
|---|---|---|
| Architecture decision | `adr` | `<project>/development/decisions/ADR-NNN-{title}.md` |
| Research finding | `research-note` | `<project>/research/{title}.md` |
| Bug investigation | `troubleshooting-log` | `<project>/development/debug/{title}.md` |
| Reusable knowledge | `permanent-note` | `03-Resources/Development/{title}.md` |
| Task | `task` | `<project>/tasks/{title}.md` |
| Meeting record | `meeting-notes` | `<project>/planning/{title}.md` |
| Literature/article notes | `literature-note` | `03-Resources/{title}.md` |

Where `<project>` is the vault project path (e.g., `01-Projects/MyApp`). Determine from the delegation prompt, CLAUDE.md `# PKM:` annotation, or SessionStart hook context.

**Notes in `03-Resources/`** should be written as project-agnostic knowledge — useful regardless of where the insight originated. Use frontmatter tags or `## Related` links to trace the origin project, but write the content for a general audience.

If CLAUDE.md specifies a different location for a content type, use that instead.

```
vault_write({
  template: "<template>",
  path: "<path-from-table>",
  frontmatter: { tags: [...], ... }
})
```

Ensure:
- At least one meaningful tag
- `{title}` uses kebab-case (e.g., `cache-eviction-strategies`)
- For ADRs, use `vault_list` on the decisions directory to determine the next NNN number

## Step 3: Populate Content

`vault_write` creates a skeleton from the template — headings with HTML comment placeholders and empty bullets. You must fill in the actual content.

1. **Read the note** with `vault_read` to see the exact template output
2. **Replace placeholders** with `vault_edit`, using the exact text from the read output as `old_string`

Work section by section. Each `vault_edit` call must match text **exactly as it appears in the file** — do NOT guess what the template produced.

For templates with many sections, you can batch multiple sections into fewer edits by using a larger `old_string` that spans consecutive sections.

## Step 4: Discover Connections

Run `vault_suggest_links` on the new note to find related content:

```
vault_suggest_links({ path: "<path-to-new-note>", limit: 8 })
```

Select the top **3–5** most relevant suggestions.

If `vault_suggest_links` is unavailable (no `OPENAI_API_KEY`), use `vault_search` with key terms from the note's title/topic and `vault_query` with matching tags to manually identify good link targets.

If **no suggestions are returned** (new vault or isolated topic), skip Steps 5–7 — the note's `## Related` section will be filled as the graph grows.

## Step 5: Draft Annotations

For each selected link, write a one-line annotation explaining the relationship.

**Good annotations** use specific relationship language:
- "builds on", "supersedes", "implements", "contradicts", "provides context for", "extends", "is an instance of"

**Bad**: `- [[note]] — related to this topic`
**Good**: `- [[architecture-patterns]] — foundational patterns this decision builds on`

Use the note's content, shared tags, and conversation context to produce meaningful explanations.

## Step 6: Insert Links

Add annotated links to the note using `vault_add_links`:

```
vault_add_links({
  path: "<path-to-new-note>",
  links: [
    { target: "<vault-relative-path>", annotation: "relationship explanation" },
    { target: "<vault-relative-path>", annotation: "relationship explanation" }
  ]
})
```

The tool handles deduplication (skips already-linked targets), creates `## Related` if missing, and validates targets exist. Format annotations as specific relationship language (see Step 5).

If the note uses a non-standard section (e.g., `## References`), pass `section: "## References"`.

If the template does not include a `## Related` section, `vault_add_links` will create it automatically (default `create_section: true`). Templates with `## Related` built in: adr, permanent-note, research-note, troubleshooting-log, literature-note, moc, meeting-notes.

Note: MOC notes created before this version may use `## Related Topics` instead of `## Related`. If `vault_add_links` fails with "Section not found", try `section: "## Related Topics"`.

## Step 7: Bidirectional Linking

For **significant note types** (ADR, permanent-note, research-note, troubleshooting-log, literature-note, moc, meeting-notes):
- Check if the top 1–2 target notes would benefit from a backlink to this new note
- If yes, add a backlink to their `## Related` section using `vault_add_links`

**Skip** for ephemeral types (fleeting-note, daily-note) — Obsidian's native backlinks panel is sufficient.

## Step 8: Index Update

- If the note is an **ADR**: add a wikilink to the project's `_index.md`
- If the note is **project-scoped**: ensure the project `_index.md` references it where appropriate

---

## Modifying Existing Notes

Guidelines for edits, appends, and frontmatter updates. These don't require the full creation workflow above.

### vault_edit — Surgical String Replacement

- Check if edits affect link targets: renaming a heading breaks `[[note#heading]]` wikilinks pointing to it
- After significant content changes, consider running `vault_suggest_links` to discover new connections worth adding

### vault_append — Adding Content

- **Devlog entries**: Use `vault_append({ heading: "## Sessions", position: "after_heading" })` for reverse-chronological ordering
- **Section additions**: Specify the `heading` param to insert in the right location rather than appending at EOF

### vault_update_frontmatter — Atomic Field Updates

- Prefer `vault_update_frontmatter` over `vault_edit` for YAML fields — it parses and re-serializes safely
- Protected fields (`type`, `created`, `tags`) can be updated but not removed
- Task status/priority have enum validation: `status` must be pending/active/done/cancelled, `priority` must be low/normal/high/urgent
