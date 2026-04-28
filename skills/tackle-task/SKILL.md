---
name: tackle-task
description: Use when starting work on a specific vault task, when a task title or path is mentioned, or when coming from triage output.
---

# Tackle Task

Open a task, understand what it requires, execute it at the right level of rigor, and close it properly.

## Step 1: Resolve the task

From the user's message, extract either a task path or a task title/name.

- **Path given**: `vault_read(path)` directly
- **Title/name given**: issue two queries and match by H1 title or basename:
  ```
  vault_query({ type: "task", status: "pending" })
  vault_query({ type: "task", status: "active" })
  ```
  If multiple tasks match, show candidates and ask the user to pick. Fall back to `vault_search(title)` if queries return nothing.

If the task can't be found, tell the user and stop.

Once found, mark it active: `vault_update_frontmatter({ path, fields: { status: "active" } })`.

## Step 2: Read and assess

Read the full task note. Extract:
- **Title** and **description**
- **Acceptance criteria** (if present — key signal for scope clarity)
- **Priority** and **due date**
- **Project** context

## Step 3: Complexity check

Classify into one tier using these signals. This should take seconds, not minutes — trust your first read.

| Tier | Signals | Route to |
|------|---------|----------|
| **Trivial** | Single concern, obvious change, clear AC, file/location already known | Step 5 directly (skip Step 4) |
| **Standard** | Multi-file change, small feature or bugfix, scope is clear but needs a plan | Step 4 → Explore → Plan → Code → Commit |
| **Significant** | New feature, architectural impact, vague requirements, multiple unknowns | Step 4 → `superpowers:brainstorming` → full pipeline |

When uncertain between tiers, go one tier up. A few extra minutes of planning is almost always cheaper than an incomplete or wrong implementation.

Complexity keywords that push up a tier: "design", "architecture", "integrate", "migrate", "refactor across", "not sure how", any missing acceptance criteria.

## Step 4: Explore context (Standard and Significant only)

- `vault_neighborhood(task_path, depth: 2)` — find related ADRs, research notes, prior decisions linked from the task
- `vault_activity({ path: project_folder, limit: 20 })` — see recent related work to avoid duplicating effort
- Read any directly relevant linked notes (ADRs, research) before proceeding

For **Significant** tasks: after exploring, invoke `superpowers:brainstorming` to clarify intent and requirements before writing any code. The brainstorming output should inform the plan.

## Step 5: Execute

**Trivial**: Read the relevant file(s), make the change, run verification. Commit.

**Standard**: Follow the Small Tasks workflow — Explore, confirm approach with user if non-obvious, Code, verify, Commit.

**Significant**: Follow the Significant Features workflow — brainstorm → worktree → plan → execute → finish branch.

Don't re-summarize what you read in Step 2. Move directly into the work.

## Step 6: Close the task

After the work is complete and verified:

1. Update status: `vault_update_frontmatter({ path: task_path, fields: { status: "done" } })`
2. Check for existing completion timestamp: `vault_read(task_path)` — if the note already contains `**Completed**`, skip the append. Otherwise:
   `vault_append({ path: task_path, content: "\n**Completed**: YYYY-MM-DD\n" })`
3. If the work produced ADRs, research notes, or other vault notes, link them back to the task: `vault_add_links({ path: task_path, links: [{ target: "...", annotation: "..." }] })`
4. Confirm to the user: one sentence — what was done and what tier it was.
