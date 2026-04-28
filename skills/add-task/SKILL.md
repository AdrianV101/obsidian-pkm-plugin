---
name: add-task
description: Use when you want to quickly capture a new task in the vault from a title, with optional priority and due date.
---

# Add Task — Fast Vault Task Capture

Create a task note with minimal friction. Duplicate check → create → confirm. Done in one pass.

## Step 1: Resolve Task Details

Extract from skill arguments or the user's message:

| Field | Source | Default |
|---|---|---|
| **title** | args / message | required — ask if missing |
| **priority** | args | `normal` |
| **due** | args (any recognisable date) | none |
| **description** | remaining text after title/priority/due | none |

Priority shorthands: `h` / `hi` / `high` → `high`; `u` / `urg` / `urgent` → `urgent`; `l` / `lo` / `low` → `low`; anything else → `normal`.

## Step 2: Detect Project

Read CLAUDE.md for the `# PKM: <path>` line (regex: `/^#\s+PKM:\s*(.+)$/m`):
- **Matched**: use the vault project path (e.g., `01-Projects/Obsidian-MCP`)
- **No match**: ask which project, or offer `00-Inbox` for unassigned tasks

Task path: `<project>/tasks/<kebab-title>.md`
- `<kebab-title>` = title lowercased, spaces → `-`, strip characters other than `a-z0-9-`
- `<project-folder-name>` for the `project:` frontmatter field is the **basename** of the vault path (e.g., `Obsidian-MCP` from `01-Projects/Obsidian-MCP`)

## Step 3: Duplicate Check

```
vault_semantic_search({ query: "<title>", folder: "<project>", limit: 3, threshold: 0.7 })
```

If unavailable (no `VAULT_PKM_OPENAI_KEY`):
```
vault_search({ query: "<title>", folder: "<project>" })
vault_query({ type: "task", status: "pending", folder: "<project>" })
```

If a similar task exists (similarity > 0.8 or exact/near-exact title in search results):
> "Similar task found: `<path>` — `<title>`. Create a new one anyway, or skip?"

If skipping, exit cleanly. If creating anyway, proceed.

## Step 4: Create Task Note

```
vault_write({
  template: "task",
  path: "<task-path>",
  frontmatter: {
    tags: ["task"],
    status: "pending",
    priority: "<priority>",
    project: "<project-folder-name>",
    ...(due ? { due: "<YYYY-MM-DD>" } : {})   // omit due entirely if not provided
  }
})
```

## Step 5: Fill Description (if provided)

If a description was given in Step 1, append it into the Description section:

```
vault_append({
  path: "<task-path>",
  heading: "## Description",
  position: "after_heading",
  content: "<description>"
})
```

Skip if no description was provided — leave the section blank for later.

## Step 6: Confirm

Report the created task concisely:

> **Task created**: `<project>/tasks/<kebab-title>.md`
> Priority: `<priority>` · Due: `<due or none>` · Status: `pending`
