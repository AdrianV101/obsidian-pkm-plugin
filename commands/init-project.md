---
name: init-project
description: Configure this project for Obsidian PKM — connects the repo to a vault project folder and writes CLAUDE.md integration directives
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, mcp__plugin_vault-pkm_vault-pkm__vault_list, mcp__plugin_vault-pkm_vault-pkm__vault_write, mcp__plugin_vault-pkm_vault-pkm__vault_peek]
---

# Initialize Project for Obsidian PKM

You are configuring this code repository for Obsidian PKM integration. Walk the user through these steps.

## Step 1: Detect Vault Project Path

Determine which vault project folder corresponds to this repository.

1. Get the current working directory name (the repo folder name)
2. Use `vault_list` to check if a matching folder exists in `01-Projects/`:
   ```
   vault_list({ path: "01-Projects" })
   ```
3. Look for a case-insensitive basename match between the CWD and the `01-Projects/` entries

**If a match is found**, proceed to Step 2 with the detected path.

**If no match is found**, ask the user:
> "I couldn't find a matching project folder in your vault. What's the vault project path? (e.g., `01-Projects/MyApp`)"

## Step 2: Confirm with User

Present the detected (or provided) path and ask for confirmation:
> "I found `01-Projects/<name>/` in your vault. Is this the right project for this repository?"

If the user corrects the path, use their provided path instead.

## Step 3: Scaffold Vault Folder (if needed)

Use `vault_list` to check if the confirmed path exists in the vault.

**If the folder doesn't exist**, ask:
> "The folder `01-Projects/<name>/` doesn't exist in your vault yet. Want me to create it with a project index?"

If yes:
1. Create the project index:
   ```
   vault_write({
     template: "project-index",
     path: "01-Projects/<name>/_index.md",
     frontmatter: { tags: ["project"], status: "active" }
   })
   ```
2. Subdirectories (`development/decisions/`, `development/debug/`, `research/`, `tasks/`, `planning/`) will be created automatically when notes are first written to them (`vault_write` has `createDirs: true` by default). Inform the user of this.

If no, proceed without scaffolding.

## Step 4: Write CLAUDE.md

Read the existing CLAUDE.md in the current working directory (using the Read tool). If no CLAUDE.md exists, you will create one.

### 4a: Add/update `# PKM:` annotation

The annotation must be on its own line at the top of the file, before any other content:

```
# PKM: 01-Projects/<name>
```

- If the file already has a `# PKM:` line (regex: `/^#\s+PKM:\s*.+$/m`), replace it with the correct path
- If not, prepend it to the file with a blank line after it

### 4b: Add/update `## PKM Integration` section

The section content (substitute the actual project path):

```
## PKM Integration

- **Vault project**: `01-Projects/<name>/`
- **MCP Server**: `vault-pkm` plugin

Document decisions, research findings, and debugging sessions as you work. The `pkm-capture` agent captures devlog entries and PKM-worthy content in the background (triggered automatically after git commits), or use the `vault-pkm:pkm-write` skill for structured notes with linking.

Use `vault-pkm:pkm-explore` to research what the vault already knows about a topic before creating new content.

At the end of each session, run `vault-pkm:pkm-session-end` to update the devlog and capture undocumented work.

### Referring to vault files

Whenever you mention a vault note, PKM file, or file inside `01-Projects/<name>/` in your response to the user — whether quoting tool output, summarizing what you read, or referring to a file by name — format it as a markdown link to its `obsidian://` URI so the user can click to open it in Obsidian:

`[01-Projects/<name>/some/note.md](obsidian://open?vault=<vault-name>&file=01-Projects%2F<name>%2Fsome%2Fnote)`

Encoding rules: percent-encode `/` as `%2F` and spaces as `%20`. Strip the trailing `.md` from the URL `file=` parameter, but keep `.md` in the visible link text. The vault name is shown in any vault-pkm tool output (the part after `vault=`); reuse it.

The vault-pkm MCP tools already emit paths in this format. Preserve the link form when relaying; don't revert to bare paths like `01-Projects/<name>/some/note.md` for inline mentions. Apply the same format proactively when mentioning a vault file you haven't just queried (e.g., when answering "what's in the devlog?" or "see ADR-002").
```

**If `## PKM Integration` already exists**: replace everything from `## PKM Integration` up to (but not including) the next `## ` heading or end of file. This makes re-runs idempotent.

**If `## PKM Integration` does not exist**: append the section at the end of the file.

## Step 5: Confirm

Tell the user:

> "Done! Your project is connected to the vault at `01-Projects/<name>/`."
>
> The vault-pkm plugin will now:
> - Load project context automatically at session start
> - Capture decisions, tasks, and research in the background
> - Document session progress when you run `pkm-session-end`
>
> **Restart your Claude Code session** for the SessionStart hook to pick up the new CLAUDE.md configuration.
