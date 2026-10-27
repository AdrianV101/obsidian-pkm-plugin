---
name: pkm-session-end
description: "The capture workflow the pkm-capture agent follows. To capture session work, dispatch the pkm-capture agent in the background; don't run this in the main conversation."
---

# PKM Session End — Knowledge Capture and Graph Maintenance

**If you are not the pkm-capture agent, stop here.** Dispatch pkm-capture in the background with the user's request (and any focus note) and do nothing else. `/vault-pkm:pkm-session-end` works the same way, through the agent.

Workflow for session wrap-up, run by the pkm-capture agent. Its capture context supplies the project (`Project:` line) and the boundary of what to capture (`New activity:` file); the agent's Step 0 reads both before this workflow begins.

## Step 1: Devlog Entry

Each Claude Code session has its own note in `<project>/development/devlog/`. Add one section to it per capture. `devlog.md` is a hub that embeds a table of those notes: never append or write to `devlog.md`, except to create it once when it is missing (below).

Read the `Devlog:` line of your capture context and act on its form:

- `Devlog: <note vault path> (add a section)`: the session's note exists. Append to it.
- `Devlog: new note <folder>/<prefix> <Title>.md (session: <id>)`: no note yet. Replace `<Title>` with a title of 3 to 6 words (letters, digits, spaces and hyphens) that names the session's work, then create the note:

  ```
  vault_write({
    template: "devlog-session",
    path: "<folder>/<prefix> <Title>.md",
    frontmatter: { tags: ["devlog"], project: "<Project>", session: "<id>" }
  })
  ```

  Never rename a note later. If `vault_write` fails with "File already exists", pick another title.
- `Devlog: unavailable (<reason>); ...`: the plugin could not look. Find this session's note first:

  ```
  vault_query({ folder: "<project>/development/devlog", custom_fields: { session: "<id>" } })
  ```

  If it returns a note, append to it. Otherwise create one as above, using the current local time as the `YYYY-MM-DD HHmm` prefix.

Then append exactly one section at the end of the note (`vault_append` with no heading):

```
vault_append({
  path: "<note vault path>",
  content: "\n## YYYY-MM-DD HH:mm <short heading>\n\n### Summary\n- <what was accomplished>\n\n### Decisions\n- <decisions made, link to ADRs if created>\n\n### Blockers\n- <problems encountered, or \"None\">\n\n### Next steps\n- <what remains>\n"
})
```

Use the **actual local date and time** and fill in real content from the session. The short heading says what this capture covers. Keep sections concise but specific. Read back any multi-line `vault_append` section and fix literal `\n` sequences left in the text.

**Missing hub**: if `<project>/development/devlog.md` doesn't exist, create it once:

```
vault_write({
  template: "devlog",
  path: "<project>/development/devlog.md",
  frontmatter: { tags: ["devlog"], project: "<Project>" },
  variables: { devlog_folder: "<project>/development/devlog" }
})
```

**Wikilinks in devlog sections**: Include `[[wikilinks]]` to tasks, ADRs, research notes, and other vault notes that were completed, created, or significantly updated during the session. For example: `- Completed [[task-api-refactor]]` or `- Decided on caching strategy ([[ADR-003-caching]])`. Link only notes that exist in the vault, never repo files or agent memory.

## Step 2: Review Session Work

The `New activity:` file from the capture context is the **boundary** for what counts as this capture: a condensed transcript of the session since the last capture. Capture only work that appears in it, plus any earlier activity file the delegation prompt names (the range a failed capture missed), which is inside the boundary too. The activity log is a discovery aid for files you may have missed, not a scope definition.

If the capture context says `New activity: unavailable`, fall back to the activity log for this session plus `git log` and `git diff --stat`.

Query the activity log to find files touched:

```
vault_activity({ limit: 1 })
```

The response header shows `current session: <id>` (an 8-character prefix). Filter to the same session for full file history:

```
vault_activity({ session: "<id-from-header>", limit: 50 })
```

Cross-reference the touched files against the new-activity file. Files that never appear in it, or that earlier devlog entries already cover, are not yours to capture again.

## Step 3: Capture Undocumented Work

Review the new activity for significant work that only exists in chat history. Most exchanges produce nothing worth capturing beyond the devlog entry in Step 1. When in doubt, don't capture — a missed capture is better than vault noise.

Skip entirely if the session was purely mechanical (config changes, minor fixes). A small docs-only or mechanical change gets the devlog entry only: no task note just to track a PR awaiting review.

Notes already written during the session are not created again. Check they read cleanly and link them from the devlog entry.

**For each PKM-worthy item independently**, determine whether to update an existing note or create a new one:

### 3a: Check for existing coverage

For each item, search the vault:

```
vault_semantic_search({ query: "<topic/title>", limit: 5 })
```

If it is unavailable or returns an error (for example, a disabled index), use `vault_search` with key terms + `vault_query` with matching tags.

**Route based on results.** Read scores on the compressed scale described in the `vault_semantic_search` tool description.

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
- A reversed decision is not an edit: create a new ADR, mark the old one superseded, and link the two both ways

### 3c: Create new note

Follow the pkm-write skill workflow for duplicate checking, template selection, location (its table lists every content type) and linking. `<project>` is the vault path from the capture context's `Project:` line.

### 3d: Update task status

When a task's status, priority, or details changed during the session:

1. `vault_query({ type: "task", custom_fields: { project: "<Project>" } })` to find the task
2. `vault_update_frontmatter` to update status/priority
3. Optionally `vault_append` to add context about what changed
4. Add a heading-anchored backlink from the task to the devlog section. Important: `vault_add_links` resolves `target` by file basename only — `#heading` suffixes in `target` are not parsed and the call will fail with `not found`. To link to a specific session section, use `vault_append` to add an inline wikilink in the task body. Use the note's path under the devlog folder (`<project>/development/devlog/<note name>`) rather than the bare basename, since vaults can have several notes with similar names:
   ```
   vault_append({
     path: "<task-path>",
     content: "\n**Status change**: pending → done on YYYY-MM-DD HH:mm. See [[<project>/development/devlog/<note name without .md>#YYYY-MM-DD HH:mm <short heading>]] for the session that completed this."
   })
   ```
   Substitute the actual project path, note name and the section heading from Step 1. This produces a clickable heading-anchored backlink that Obsidian renders correctly. Bidirectional traceability: the devlog section links to the task (Step 1), the task body links back to the specific session section.

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

Act only on notes this session touched. For any **orphan** notes found (no connections), add links using `vault_add_links`. Broken links (pointing to non-existent files) may self-resolve if the missing notes were created earlier in this session — confirm a "broken" target is really missing before changing anything, and otherwise note it for manual review. For deeper audit (weak connections, ambiguous links, full vault scan), delegate to the link-auditor agent separately.

## Step 6: Index Update

Check and update if changed during the session:
- **Project `_index.md`**: add links to new ADRs under `## Architecture Decisions` and update Current Status in place. Add no other links.
- **Relevant MOCs**: Add links to new notes that belong in topic index maps
