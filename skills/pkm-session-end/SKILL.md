---
name: pkm-session-end
description: Use when wrapping up a work session — creates devlog entry, captures undocumented decisions/research/debugging, audits link health of session work, and updates project index. Primarily used via the pkm-capture agent.
---

# PKM Session End — Knowledge Capture and Graph Maintenance

Workflow for session wrap-up. When running as a subagent, the delegation prompt provides the project path and devlog boundary context. The agent's system prompt handles transcript discovery (Step 0) before this workflow begins.

## Step 1: Devlog Entry

Append a session summary to the project devlog, most recent entry first.

**If the devlog file doesn't exist yet** (new project, first session), create it first:

```
vault_write({
  template: "devlog",
  path: "01-Projects/<Project>/development/devlog.md",
  frontmatter: { tags: ["devlog"], project: "<Project>" }
})
```

Then append the session entry:

```
vault_append({
  path: "01-Projects/<Project>/development/devlog.md",
  heading: "## Sessions",
  position: "after_heading",
  content: "### YYYY-MM-DD HH:mm\n\n#### Session Summary\n- <what was accomplished>\n\n#### Key Decisions\n- <decisions made, link to ADRs if created>\n\n#### Blockers / Issues\n- <problems encountered, or \"None\">\n\n#### Next Steps\n- <what remains>\n\n---\n"
})
```

Use the **actual date** and fill in real content from the session. Keep entries concise but specific. Using `after_heading` inserts each new entry at the top, keeping the log in reverse-chronological order.

**Wikilinks in devlog entries**: Include `[[wikilinks]]` to tasks, ADRs, research notes, and other vault notes that were completed, created, or significantly updated during the session. For example: `- Completed [[task-api-refactor]]` or `- Decided on caching strategy ([[ADR-003-caching]])`.

**Existing devlogs**: Older devlogs may use `## YYYY-MM-DD` entries without a `## Sessions` heading. If `vault_append` fails with "Heading not found", add the heading first: `vault_append({ path: "...", content: "\n## Sessions\n" })`.

## Step 2: Review Session Work

The parent agent's session-context message in the delegation prompt is the **primary boundary** for what counts as "this session." Use it to decide which work is in-scope to capture. The activity log is a discovery aid — useful for spotting files-touched you may have missed — not a session-scope definition.

Why this matters: the MCP server's session ID can span work that was already captured in earlier devlog entries within the same session, so filtering purely by session ID risks re-capturing already-documented work or capturing work outside the parent's intended scope.

Query the activity log to find files touched:

```
vault_activity({ limit: 1 })
```

The response header shows `current session: <id>` (an 8-character prefix). Filter to the same session for full file history:

```
vault_activity({ session: "<id-from-header>", limit: 50 })
```

Cross-reference the touched files against the parent's session context. Files outside the parent's stated scope, or files already covered by prior devlog entries in the same session, are not your responsibility to capture again.

## Step 3: Capture Undocumented Work

Review the session's conversation for significant work that only exists in chat history. Most exchanges produce nothing worth capturing beyond the devlog entry in Step 1. When in doubt, don't capture — a missed capture is better than vault noise.

Skip entirely if the session was purely mechanical (config changes, minor fixes).

**For each PKM-worthy item independently**, determine whether to update an existing note or create a new one:

### 3a: Check for existing coverage

For each item, search the vault:

```
vault_semantic_search({ query: "<topic/title>", limit: 5 })
```

If unavailable, use `vault_search` with key terms + `vault_query` with matching tags.

**Route based on results.** Note on score interpretation: `vault_semantic_search` uses `text-embedding-3-large` (3072-dim) cosine similarity, which compresses hard. Even a verbatim title/heading of an existing note typically scores around 0.55–0.65; scores above 0.7 are essentially never observed.

- **Likely duplicate (top hit ≥ 0.5)**: Read the top hit with `vault_read` and confirm it's actually about the same topic before routing — a 0.5 score can be a real duplicate or a same-domain neighbor. If same topic: go to **3b** (update). If neighbor: go to **3c** (create with links).
- **No close match (top hit < 0.5)**: Go to **3c** (create new note).
- **Task status change**: Go to **3d** (update task).

### 3b: Update existing note

When a note already covers this topic, enrich it rather than creating a duplicate:

- `vault_read` the existing note to understand its current content
- `vault_append` to add new findings, with a date-stamped section if the note uses chronological entries
- `vault_edit` to update outdated information (e.g., refining a decision's rationale, adding a new root cause to a troubleshooting log)
- `vault_update_frontmatter` to update status or other metadata if changed
- After updating, run `vault_suggest_links` to discover new connections worth adding

### 3c: Create new note

Follow the pkm-write skill workflow for proper duplicate checking, template selection, and linking:

| Content Type | Template | Default Path |
|---|---|---|
| Architecture/design decisions | `adr` | `<project>/development/decisions/ADR-NNN-{title}.md` |
| Research findings or evaluations | `research-note` | `<project>/research/{title}.md` |
| Complex debugging sessions | `troubleshooting-log` | `<project>/development/debug/{title}.md` |
| Reusable insights or patterns | `permanent-note` | `03-Resources/Development/{title}.md` |
| New tasks identified | `task` | `<project>/tasks/{title}.md` |

Where `<project>` is the vault project path from session context.

### 3d: Update task status

When a task's status, priority, or details changed during the session:

1. `vault_query({ type: "task", custom_fields: { project: "<Project>" } })` to find the task
2. `vault_update_frontmatter` to update status/priority
3. Optionally `vault_append` to add context about what changed
4. Add a heading-anchored backlink from the task to the devlog entry. Important: `vault_add_links` resolves `target` by file basename only — `#heading` suffixes in `target` are not parsed and the call will fail with `not found`. To link to a specific session entry, use `vault_append` to add an inline wikilink in the task body. Use the disambiguated devlog path (`<project>/development/devlog`) rather than the bare basename, since vaults can have multiple `devlog.md` files (one per project) and Obsidian's basename resolver may pick the wrong one:
   ```
   vault_append({
     path: "<task-path>",
     content: "\n**Status change**: pending → done on YYYY-MM-DD HH:mm. See [[<project>/development/devlog#YYYY-MM-DD HH:mm]] for the session that completed this."
   })
   ```
   Substitute the actual project path and timestamp. Use the same `### YYYY-MM-DD HH:mm` heading from Step 1 as the wikilink target. This produces a clickable heading-anchored backlink that Obsidian renders correctly. Bidirectional traceability: the devlog entry links to the task (Step 1), the task body links back to the specific session heading.

## Step 4: Quality Check

Read back each note created in Step 3 using `vault_read`. Verify:
- No template placeholder text remains (e.g., "Brief description of the technology, tool, or concept", "What was the situation or context?", "Describe the problem")
- Frontmatter has real values (not template defaults)
- Content is specific to the session, not generic

Fix any issues with `vault_edit`. If a note is entirely placeholder text, delete it with `vault_trash` — an empty note is worse than no note.

## Step 5: Quick Link Check

Run a targeted link health check on files touched during this session:

```
vault_link_health({ folder: "<project-folder>", checks: ["orphans", "broken"] })
```

For any **orphan** notes found (no connections), add links using `vault_add_links`. Broken links (pointing to non-existent files) may self-resolve if the missing notes were created earlier in this session — otherwise note them for manual review. For deeper audit (weak connections, ambiguous links, full vault scan), delegate to the link-auditor agent separately.

## Step 6: Index Update

Check and update if changed during the session:
- **Project `_index.md`**: Add links to new ADRs, update project status, add key links
- **Relevant MOCs**: Add links to new notes that belong in topic index maps
