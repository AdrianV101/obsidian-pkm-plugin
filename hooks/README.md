# PKM Hook System

Claude Code hooks that load project context from the vault at the start of each session, prompt a PKM capture when a pull request is opened, and give the pkm-capture agent its project and new session activity when it starts.

## Overview

| Hook | Event | Purpose |
|------|-------|---------|
| `session-start.js` | SessionStart | Loads project context from the vault at the start of each session |
| `capture-context.js` | SubagentStart (`^vault-pkm:pkm-capture$`) | Hands pkm-capture its project, the session and a digest of the activity since the last capture |
| `capture-reminder.js` | PostToolUse (Bash) | After a successful `gh pr create`, asks Claude to dispatch pkm-capture in the background, on opus for a PR over 1,000 changed lines |

### How it works

- **SessionStart** (`session-start.js`): Runs synchronously at session start, clear, or compact. Resolves the current working directory to a vault project, reads the project index, its open tasks and the 10 newest devlog items (session notes, migrated day notes or the entries of an unmigrated `devlog.md`), then injects them as context into the session. The context starts with `## PKM Project Context: <full project path>`, and the summary line shown to the user ends with how the project was found, for example `(via repos: github.com/acme/app)`. In a git repo that resolves to no project it shows `vault-pkm: this repo isn't linked to a vault project. Run /vault-pkm:init-project to link it.` (with the reason appended when a remote is listed by more than one project), and an invalid `# PKM:` annotation or a missing vault is reported the same way. Outside git an unmatched folder stays silent. It shows the user nothing about a `## PKM Integration` section in the repo's `CLAUDE.md`; that section is one of the upgrade steps below, which only Claude sees.

  On `startup` and `clear` (not `compact` or `resume`), once a project resolved, it also runs the upgrade checks (`upgrade-checks.js`) and, when steps are left, appends a block for Claude only, headed `### vault-pkm: upgrade steps left`:
  - an old `05-Templates/devlog.md`;
  - a project `devlog.md` that still holds old-style entries, plus the other projects never migrated (read from the first 4 KB of each devlog);
  - a `## PKM Integration` section in a `CLAUDE.md` or `.claude/CLAUDE.md` the session reads.

  Each step carries its fix and its `obsidian-pkm upgrade dismiss` command, written as `obsidian-pkm <args>`; the block says once how to run them (`VAULT_PATH=<vault> npx -y <the npm spec in .claude-plugin/plugin.json> <args>`), so a long vault path is paid for only once. The block tells Claude to raise the steps once after the first request and to ask before running anything. The block is at most 1,200 characters and the project context's budget shrinks by its length; when it would run over, the other projects become a count, then optional steps, the other projects and required steps are dropped in that order, and a last line points at `obsidian-pkm doctor`. Steps dismissed on this device are left out, and a failing check, an unreadable dismissal file or an unreadable `plugin.json` only drops what it affects, with a stderr line.

- **SubagentStart** (`capture-context.js`): Runs only for the `vault-pkm:pkm-capture` agent (the matcher is anchored, and the script re-checks the agent type). It resolves the project the way session start does, reads the main session's transcript (`transcript_path` from the hook input), condenses everything after the previous capture into a delta file and returns an `additionalContext` of up to five lines (`vault-pkm capture context`, `Project:`, `Session:`, `New activity:` and, when a project resolved, `Devlog:`; each at most about 480 characters). `Devlog:` names the session's existing note to add a section to, the name of the note to create (`new note <folder>/<YYYY-MM-DD HHmm> <Title>.md`), or `unavailable (<why>)` with a pointer to `vault_query` on the `session` property. `New activity:` is the delta file with its size and time range, `none since the last capture`, or `unavailable (<why>)` with a pointer to `vault_activity` and `git log` when the transcript can't be read or the state directory can't be written. The capture position is recorded here, as soon as the delta is written, except when no project resolved: that capture writes nothing to a project, so its range stays open for the first capture after the repo is linked. Claude Code's SubagentStop input carries no final message, so there is no way to check that the agent succeeded when it stops; a capture that fails is therefore not retried automatically, and the agent's final status line (`Status: captured`, `nothing new`, `no project` or `failed - <reason>`) is how the main conversation finds out. The hook also prunes old state, and any error leaves the agent to start without context rather than fail.

- **PostToolUse** (`capture-reminder.js`): Runs after Bash calls that pass the `if: "Bash(gh pr create *)"` filter. That filter is best-effort: Claude Code runs the hook anyway when it can't parse a command. So the script makes the real decision, and it fires only when both of these hold:
  1. Some simple command in the Bash input is a real `gh pr create` invocation. The input is split on `&&`, `||`, `;`, `|` and newlines outside quotes, and leading `VAR=value` assignments are skipped.
  2. The command's stdout contains a `https://github.com/<owner>/<repo>/pull/<n>` URL.

  A mention such as `grep "gh pr create" notes.md`, or a create that printed no PR URL, produces no output. When it fires, it reads the PR's size with `gh pr view <url> --json additions,deletions` (5 s timeout) and returns a one-line `additionalContext` asking Claude to dispatch pkm-capture in the background with the PR URL in its prompt, with model `opus` when the PR adds and removes more than 1,000 lines and `sonnet` otherwise. A size it can't read (gh missing, failing, timing out or printing anything but integer counts) gets `sonnet`. It stays silent inside subagents (they can't dispatch agents), so a PR a subagent creates is left to the main conversation. It is plain Node with no dependencies (no `jq`) and no AI invocation; its only outside call is that `gh pr view`, made once a reminder is due.

## Setup

Hooks are registered automatically when you install the plugin:

```bash
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin install vault-pkm@claude-community
```

The plugin's `hooks/hooks.json` declares all three hooks, and Claude Code manages their lifecycle. No manual configuration is needed.

<details>
<summary>Manual setup (source installs / development)</summary>

If you're running from a local clone instead of the plugin, add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "VAULT_PATH=\"/path/to/your/vault\" node \"/path/to/obsidian-pkm-plugin/hooks/session-start.js\"",
            "timeout": 15,
            "statusMessage": "Loading PKM project context..."
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "^vault-pkm:pkm-capture$",
        "hooks": [
          {
            "type": "command",
            "command": "VAULT_PATH=\"/path/to/your/vault\" node \"/path/to/obsidian-pkm-plugin/hooks/capture-context.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(gh pr create *)",
            "command": "node \"/path/to/obsidian-pkm-plugin/hooks/capture-reminder.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/your/vault` with the absolute path to your Obsidian vault, and `/path/to/obsidian-pkm-plugin` with the absolute path to this repository.

</details>

## Architecture Notes

### Command hooks

All three are `type: "command"` hooks that read the hook JSON from stdin and write a JSON result to stdout, which Claude Code injects into the session (or into the subagent, for `capture-context.js`). `session-start.js` reads vault files directly, `capture-context.js` reads the session transcript and writes capture state, and `capture-reminder.js` only inspects its stdin. All exit 0 within their configured timeouts, and unexpected errors go to stderr only: a hook never fails a session.

### MCP config resolution

`session-start.js` and `capture-context.js` import their helper modules using relative paths from the same directory. The `VAULT_PATH` environment variable must be set in the hook command because the hook script runs outside the MCP server process.

### Helper modules

Shared helpers used by the hooks above:

- **`resolve-project.js`**: Maps the current working directory to a vault project path, in this order: a `# PKM: <vault path>` line in `CLAUDE.local.md`, `CLAUDE.md` or `.claude/CLAUDE.md` (searched from the working directory up to the repo top level, then the main checkout; never the home directory), then a `repos:` list in a project's `_index.md` (the first 8 KB is read) that contains one of the repo's remotes after normalisation, then the main checkout's folder name against `01-Projects/`. An invalid annotation stops resolution instead of falling through, and a remote listed by two projects is reported as ambiguous. Git calls time out after 2 seconds. It exports `describeVia`, which renders the `(via …)` text, and `normalizeRemote`.
- **`load-context.js`**: Reads the project index, up to 10 open tasks (one line each: file name, status, priority, due date) and the 10 newest devlog items from the vault and formats them as a context block of at most 9,500 characters
- **`transcript.js`**: Condenses a session transcript (JSONL) into a digest: typed user prompts and Claude's text, one line per tool call, and the first line of each error. Tool output, sidechain and meta entries and generated prompts are left out, text is capped per entry, and the digest is capped at 40,000 characters by dropping the oldest lines.
- **`capture-state.js`**: Per-session capture cursor (`<session_id>.json`, holding the last transcript entry already handed to a capture), delta file paths (`<session_id>-<agent_id>.md`) and pruning. Ids from hook input become file names, so only plain alphanumeric ids are accepted. A missing or corrupt cursor reads as "start from the beginning".

### Where state lives

Capture state goes to `$CLAUDE_PLUGIN_DATA/captures`, or `~/.claude/vault-pkm/captures` when that variable is unset, empty or unexpanded. Delta files copy conversation text, so the directory is created owner-only (`0700`) and its files `0600`, like Claude Code's own transcripts. Cursor files are removed after 30 days and delta files after 7. Delete the directory to reset every session's position. Nothing is written to the vault by the hooks.

Upgrade steps a user dismissed are kept in `~/.claude/vault-pkm/upgrade-dismissals.json`, always under the home directory and never `$CLAUDE_PLUGIN_DATA`, because `obsidian-pkm upgrade dismiss` runs from a Bash command that may not see that variable. Session start only reads it. `obsidian-pkm upgrade reset` empties it.

### Import rule

Hooks run with plain `node` from the plugin cache, where `node_modules` may be missing. Every hook script, and every module it imports (directly or through re-exports), may only use relative (`./`, `../`) or `node:` specifiers. `tests/manifest.test.js` walks the import graph from `hooks/*.js` and fails on any bare specifier, including unprefixed builtins like `"path"`.

## Troubleshooting

### Hook not firing

- If using the plugin: verify it's installed with `claude plugin list` and check that `VAULT_PATH` is set in `~/.claude/settings.json` under `env`
- If using manual config: verify the hook config is valid JSON in `~/.claude/settings.json`, the `matcher` pattern matches (`"startup|clear|compact"` for SessionStart, `"^vault-pkm:pkm-capture$"` for SubagentStart, `"Bash"` for PostToolUse), and the script path is absolute
- The capture reminder stays silent unless `gh pr create` succeeded and printed the PR URL. A `gh pr create` that exits non-zero fires `PostToolUseFailure`, not `PostToolUse`.

### Script errors

- Check that `VAULT_PATH` is set correctly and the directory exists
- Verify `node` is available in the hook's PATH
- If `capture-context.js` reports `New activity: unavailable`, the reason is in that line: usually the transcript could not be read or the captures directory is not writable.
- Test the scripts manually:
  ```bash
  echo '{"cwd":"'"$PWD"'","source":"startup"}' | VAULT_PATH="/path/to/vault" node ./hooks/session-start.js
  echo '{"agent_type":"vault-pkm:pkm-capture","agent_id":"a1","session_id":"abc123","cwd":"'"$PWD"'","transcript_path":"/path/to/session.jsonl"}' | VAULT_PATH="/path/to/vault" CLAUDE_PLUGIN_DATA="$(mktemp -d)" node ./hooks/capture-context.js
  echo '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"},"tool_response":{"stdout":"https://github.com/o/r/pull/1\n"}}' | node ./hooks/capture-reminder.js
  ```
- Run the hook tests: `node --test tests/capture-hooks.test.js tests/capture-state.test.js tests/transcript.test.js tests/resolve-project.test.js tests/session-start.test.js tests/upgrade-block.test.js tests/upgrade-checks.test.js tests/upgrade-dismissals.test.js`

### macOS compatibility

The scripts use standard ES module patterns for path resolution, so they work on both Linux and macOS without additional dependencies.
