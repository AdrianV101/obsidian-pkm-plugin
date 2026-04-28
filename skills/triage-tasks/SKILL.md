---
name: triage-tasks
description: Use when you want to review and batch-update open vault task statuses for the current project or across all projects.
---

# Triage Tasks — Surface and Batch-Update Open Vault Tasks

Runs interactively: fetch open tasks, show them numbered with completion hints, wait for user decisions, apply updates.

## Step 1: Determine Scope

Detect the current project from CLAUDE.md:

```
Read("CLAUDE.md")  // look for: # PKM: <path>
```

Extract the vault project path from a line matching `/^#\s+PKM:\s*(.+)$/m` (e.g., `01-Projects/Obsidian-MCP`).

**Scope** (check skill args first, then default):
- **Current project** (default): use the detected project folder
- **All** (if args contain "all" or no project detected and user chooses all): omit `folder` from queries

If CLAUDE.md has no `# PKM:` line and no scope was specified, ask:
> "No project found in CLAUDE.md. Should I triage tasks across all projects, or a specific folder?"

## Step 2: Fetch Open Tasks

```
vault_query({ type: "task", status: "pending", folder: "<project>", sort_by: "priority", sort_order: "desc" })
vault_query({ type: "task", status: "active",  folder: "<project>", sort_by: "priority", sort_order: "desc" })
```

Omit `folder` for all-projects scope. If both return empty, report "No open tasks found — all clear!" and stop.

Combine: active tasks first (priority-sorted), then pending (priority-sorted). Assign sequential numbers 1–N.

## Step 3: Gather Completion Hints

Collect lightweight signals in two calls — **not** one call per task.

**Activity log** (check if any task was recently touched):
```
vault_activity({ since: "<date 30 days ago as YYYY-MM-DD>", limit: 100 })
```

**Git log** (look for commits related to task work):
```
Bash: git rev-parse --is-inside-work-tree 2>/dev/null && git log --oneline --since="30 days ago" | head -50
```
If `git rev-parse` fails (not a git repo), skip git hints silently — don't surface an error to the user.

For each task, derive a hint from these results:
- Task path appears in the activity log with a write tool (`vault_update_frontmatter`, `vault_edit`, `vault_append`): mark "recently updated"
- Any word from the task's filename (≥ 4 chars, case-insensitive, split on `-`) appears in a commit message: mark "⚡ git commits"
- Neither: no hint (omit hint entirely)

## Step 4: Present Numbered List

Format the list clearly, grouping active before pending:

```
### Open Tasks — 01-Projects/Obsidian-MCP (5 tasks)

**Active:**
1. [urgent] implement-semantic-caching  ⚡ git commits
   Implement caching layer for OpenAI embedding calls

**Pending:**
2. [high] add-triage-tasks-command
   Add /triage-tasks skill to vault-pkm plugin
3. [normal] project-init-update-command
   Add init --update subcommand for hook file updates
4. [normal] support-claude-ai-hosted-sessions
   Research making vault-pkm work with claude.ai sessions
5. [normal] rename-github-repo  ⚡ git commits
   Rename GitHub repo via UI

Reply with decisions, e.g.: `1,2 done | 4 cancel | 3 active`
Options: done · active · pending · cancel
Press Enter with no input to skip.
```

Include the task's first non-empty description line as a subtitle. Use `vault_peek(path)` per task (cheaper than `vault_read` — returns preview without full content). If the description section is empty or contains only a template placeholder, omit the subtitle entirely.

## Step 5: Parse User Decisions

Wait for user input. Parse leniently:

| Input form | Meaning |
|---|---|
| `1,3 done` | Tasks 1 and 3 → `done` |
| `2 active` | Task 2 → `active` |
| `4 cancel` or `4 cancelled` | Task 4 → `cancelled` |
| `5 pending` | Task 5 → `pending` (no-op if already pending) |
| empty / `skip` | No updates — exit cleanly |

Numbers out of range: ignore with a warning. Unrecognised tokens: ignore silently.

Confirm parsed decisions before applying:
> "Updating: 1, 3 → done · 4 → cancelled. Proceed? (y/n)"

## Step 6: Apply Updates

For each decision, update frontmatter atomically:

```
vault_update_frontmatter({
  path: "<task-path>",
  fields: { status: "<new-status>" }
})
```

For tasks marked `done`, check for an existing completion timestamp before appending:

```
vault_read({ path: "<task-path>" })
```

If the note already contains `**Completed**`, skip. Otherwise:

```
vault_append({
  path: "<task-path>",
  content: "\n**Completed**: <YYYY-MM-DD>\n"
})
```

## Step 7: Summary

Report what changed:

```
Updated 3 tasks:
- ✓ implement-semantic-caching → done
- ✓ add-triage-tasks-command → done
- ✗ rename-github-repo → cancelled
Skipped: 2 tasks unchanged.
```
