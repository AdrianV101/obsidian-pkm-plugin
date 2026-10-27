---
name: migrate-devlog
description: Split a project's single-file devlog into per-day notes and turn devlog.md into the hub; previews first, writes only after you confirm
argument-hint: "[project]"
allowed-tools: [Bash, AskUserQuestion]
---

# Migrate a Project's Devlog

Move a project's old single-file `devlog.md` into one note per day in its `development/devlog/` folder, and turn `devlog.md` into the hub that lists them. The original is moved to the vault's `.trash`, so nothing is lost.

## Step 1: Pick the project

Use `$ARGUMENTS` when it is given. Otherwise use the vault path from this session's `## PKM Project Context:` header, without a trailing ` (compact)` (after a compaction the header ends with it). If neither exists, ask the user which project to migrate. A project is a folder name under `01-Projects/` or a vault-relative project path.

## Step 2: Warn about other devices

Tell the user to upgrade the plugin on every device that uses this vault before migrating. An older version would keep writing old-style entries into the hub.

## Step 3: Preview

Run this and show its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.js" migrate-devlog "<project>"
```

The preview writes nothing.

## Step 4: Stop when there is nothing to do

If the output says `Nothing to migrate`, or reports a line starting with `Blocker:`, stop and explain it to the user. Do not continue.

## Step 5: Ask

Ask the user with AskUserQuestion whether to apply the migration, naming the project and the number of day notes the preview showed.

## Step 6: Apply

If the user says yes, run the same command with the flag that applies it, and show the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/cli.js" migrate-devlog "<project>" --apply
```

If the exit code is not 0, show the output and stop. The command tries to restore the starting state on failure; report what its output says about that.
