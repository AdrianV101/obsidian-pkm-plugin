---
name: init-project
description: Link this repo to an Obsidian vault project through the project's repos list, or a CLAUDE.local.md line when there is no remote
allowed-tools: [Bash, Read, Write, Edit, Glob, AskUserQuestion, mcp__plugin_vault-pkm_vault-pkm__vault_list, mcp__plugin_vault-pkm_vault-pkm__vault_write, mcp__plugin_vault-pkm_vault-pkm__vault_peek, mcp__plugin_vault-pkm_vault-pkm__vault_read, mcp__plugin_vault-pkm_vault-pkm__vault_update_frontmatter]
---

# Link This Repo to a Vault Project

Link the current repository to a vault project folder. The link lives in the vault (the project's `repos:` list) or, when there is no remote, in `CLAUDE.local.md`. Never edit `CLAUDE.md`.

## Step 1: Check for an existing link

If this session's context has a `## PKM Project Context: <path>` header, the repo is already linked. Work out how, in this order:

1. A `# PKM:` line in `CLAUDE.local.md`, `CLAUDE.md` or `.claude/CLAUDE.md` in the repo.
2. Otherwise, the repo's normalised remote (see Step 2) listed under `repos:` in that project's `_index.md` (`vault_read` it).
3. Otherwise, the folder name matching the project.

Report the path and how it was found, then ask whether to relink to a different project. If not, stop. If yes, continue with Step 2. A `# PKM:` line wins over `repos:`, so relinking an annotated repo means changing or removing that line in `CLAUDE.local.md`. If the line is in `CLAUDE.md`, tell the user to edit it themselves.

## Step 2: Read and normalise the remotes

Run `git remote -v` in the current directory. Collect the fetch URLs, `origin` first. If this isn't a git repo or there are no remotes, go to Step 5.

Normalise each URL: drop the scheme and any credentials, turn `host:path` into `host/path` and remove a port, strip a trailing `/` and `.git`, and lowercase the result. For example, `git@github.com:Acme/App.git` and `https://token@github.com/Acme/App/` both become `github.com/acme/app`.

## Step 3: Pick or create the project

Use `vault_list({ path: "01-Projects" })`. Suggest the folder whose name matches the main checkout's folder name (case-insensitive). In a git worktree the working directory's name differs, so derive the main checkout: run `git rev-parse --path-format=absolute --git-common-dir`; when that path ends in `.git`, its parent directory is the main checkout, otherwise use `git rev-parse --show-toplevel`. Outside git, use the current folder's name and ask the user to confirm or choose another. If none fits, ask for a name and create it:

```
vault_write({
  template: "project-index",
  path: "01-Projects/<name>/_index.md",
  frontmatter: { tags: ["project"], status: "active" }
})
```

Subdirectories are created when notes are first written to them.

## Step 4: Add the remote to `repos:`

1. `vault_read` the project's `_index.md` and read its `repos:` list (it may be missing, inline or a block list).
2. Build the full list: every existing entry unchanged, plus the normalised remote (the `origin` one, unless the user picks another). Normalise each existing entry with the Step 2 rules before comparing, and add the remote only if its normalised form matches none of them, so a hand-written `git@github.com:Acme/App.git` isn't re-added. Keep existing entries' original text when writing the list back.
3. `vault_update_frontmatter({ path: "01-Projects/<name>/_index.md", fields: { repos: [<full list>] } })`.

Then go to Step 6.

## Step 5: No remote

Offer to put this line at the top of `CLAUDE.local.md` in the repo root, creating the file if needed:

```
# PKM: 01-Projects/<name>
```

Replace an existing `# PKM:` line instead of adding a second one. Check with `git check-ignore CLAUDE.local.md`; if the file isn't git-ignored, warn the user so it isn't committed by accident.

## Step 6: Confirm

Report the project path and how the repo is linked. Tell the user the link takes effect at the next session start or `/clear`. If `CLAUDE.md` has an old `## PKM Integration` section, say it can be deleted, since the plugin now supplies those rules. Do not edit `CLAUDE.md` yourself.
