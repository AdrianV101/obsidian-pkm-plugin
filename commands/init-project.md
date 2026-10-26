---
name: init-project
description: Link this repo to an Obsidian vault project through the project's repos list, or a CLAUDE.local.md line when there is no remote
allowed-tools: [Bash, Read, Write, Edit, Glob, AskUserQuestion, mcp__plugin_vault-pkm_vault-pkm__vault_list, mcp__plugin_vault-pkm_vault-pkm__vault_write, mcp__plugin_vault-pkm_vault-pkm__vault_peek, mcp__plugin_vault-pkm_vault-pkm__vault_read, mcp__plugin_vault-pkm_vault-pkm__vault_update_frontmatter]
---

# Link This Repo to a Vault Project

Link the current repository to a vault project folder. The link lives in the vault (the project's `repos:` list) or, when there is no remote, in `CLAUDE.local.md`. Never edit `CLAUDE.md`.

## Step 1: Check for an existing link

First, look for a `# PKM:` line, whether or not this session has a project context header. Check `CLAUDE.local.md`, `CLAUDE.md` and `.claude/CLAUDE.md` in each folder from the current one up to the repo's top level (`git rev-parse --show-toplevel`), then in the main checkout root (Step 3 shows how to find it). Outside git, check only the current folder. The first line found is the one that counts. Only a line that starts with `# PKM:` counts: one inside an HTML comment (as in the shipped sample) is inactive and is ignored. If there is one:

- Explain that it overrides any `repos:` entry: while it is there, linking through `repos:` has no effect.
- Say whether it points at an existing vault folder (`vault_list` its path). If it doesn't, the line is invalid and blocks resolution entirely.
- If the line is invalid, or the user wants `repos:` to take effect: offer to fix or remove the line when it is in `CLAUDE.local.md`. When it is in `CLAUDE.md` or `.claude/CLAUDE.md`, tell the user to edit it themselves.

Then, if this session's context has a `## PKM Project Context: <path>` header, the repo is already linked. Work out how, in this order:

1. The `# PKM:` line found above.
2. Otherwise, the repo's normalised remote (see Step 2) listed under `repos:` in that project's `_index.md` (`vault_read` it).
3. Otherwise, the folder name matching the project.

Report the path and how it was found, then ask whether to relink to a different project. If not, stop. If yes, continue with Step 2. A `# PKM:` line wins over `repos:`, so relinking an annotated repo means changing or removing that line as described above. Without a header, continue with Step 2.

## Step 2: Read and normalise the remotes

Read the remote URLs without their credentials, so a token in a URL never reaches the conversation:

```
git config --get-regexp '^remote\..*\.url$' | sed -E 's#(://)[^/@]*@#\1#'
```

Each line is `remote.<name>.url <url>`. Collect the URLs, `origin` first. If this isn't a git repo or there are no remotes, go to Step 5.

Normalise each URL: drop the scheme and any credentials, turn `host:path` into `host/path` and remove a port, strip a trailing `/` and `.git`, and lowercase the result. For example, `git@github.com:Acme/App.git` and `https://token@github.com/Acme/App/` both become `github.com/acme/app`.

## Step 3: Pick or create the project

Use `vault_list({ path: "01-Projects" })`. Suggest the folder whose name matches the main checkout's folder name (case-insensitive). In a git worktree the working directory's name differs, so derive the main checkout: run `git rev-parse --path-format=absolute --git-common-dir`; when that path ends in `.git`, its parent directory is the main checkout, otherwise use `git rev-parse --show-toplevel`. Outside git, use the current folder's name. Always ask the user to confirm the suggestion or choose another project, even when the name matches. If none fits, ask for a name and create it:

```
vault_write({
  template: "project-index",
  path: "01-Projects/<name>/_index.md",
  frontmatter: { tags: ["project"], status: "active" }
})
```

Subdirectories are created when notes are first written to them.

## Step 4: Add the remote to `repos:`

1. Find every other project that already lists the remote, because two projects listing one remote leave the repo ambiguous and unlinked. Scan every project index, as session start does: list the project folders with `vault_list({ path: "01-Projects" })`, then read each folder's `_index.md` frontmatter with `vault_peek` (it skips the body, which can be large) and skip folders that have no `_index.md`. Normalise each `repos:` entry with the Step 2 rules and compare it with the remote. Where one matches, offer to remove it: write that project's list back with `vault_update_frontmatter`, keeping all its other entries unchanged. On a relink, removing it from the old project is required: if the user declines, stop. This also repairs a repo that session start reported as listed by more than one project.
2. `vault_read` the chosen project's `_index.md` and read its `repos:` list (it may be missing, inline or a block list).
3. Build the full list: every existing entry unchanged, plus the normalised remote (the `origin` one, unless the user picks another). Normalise each existing entry with the Step 2 rules before comparing, and add the remote only if its normalised form matches none of them, so a hand-written `git@github.com:Acme/App.git` isn't re-added. Keep existing entries' original text when writing the list back.
4. `vault_update_frontmatter({ path: "01-Projects/<name>/_index.md", fields: { repos: [<full list>] } })`.

Then go to Step 6.

## Step 5: No remote

Offer to put this line at the top of `CLAUDE.local.md` in the main checkout's root (Step 3), creating the file if needed:

```
# PKM: 01-Projects/<name>
```

Use the main checkout even when working in a linked worktree: the resolver checks the main checkout's root, and a file in a worktree disappears with the worktree. Outside git, use the current folder. Replace an existing `# PKM:` line instead of adding a second one. Check with `git -C <main checkout> check-ignore CLAUDE.local.md`; if the file isn't git-ignored, warn the user so it isn't committed by accident.

## Step 6: Confirm

Report the project path and how the repo is linked. Tell the user the link takes effect at the next session start or `/clear`. If `CLAUDE.md` has an old `## PKM Integration` section, say it can be deleted, since the plugin now supplies those rules. Do not edit `CLAUDE.md` yourself.
