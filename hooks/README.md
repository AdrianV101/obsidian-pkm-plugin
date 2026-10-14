# PKM Hook System

Claude Code hooks that load project context from the vault at the start of each session and prompt a PKM capture when a pull request is opened.

## Overview

| Hook | Event | Purpose |
|------|-------|---------|
| `session-start.js` | SessionStart | Loads project context from the vault at the start of each session |
| `capture-reminder.js` | PostToolUse (Bash) | After a successful `gh pr create`, asks Claude to dispatch pkm-capture in the background |

### How it works

- **SessionStart** (`session-start.js`): Runs synchronously at session start, clear, or compact. Resolves the current working directory to a vault project, reads the project index, recent devlog entries, and active tasks, then injects them as context into the session.

- **PostToolUse** (`capture-reminder.js`): Runs after Bash calls that pass the `if: "Bash(gh pr create *)"` filter. That filter is best-effort: Claude Code runs the hook anyway when it can't parse a command. So the script makes the real decision, and it fires only when both of these hold:
  1. Some simple command in the Bash input is a real `gh pr create` invocation. The input is split on `&&`, `||`, `;`, `|` and newlines outside quotes, and leading `VAR=value` assignments are skipped.
  2. The command's stdout contains a `https://github.com/<owner>/<repo>/pull/<n>` URL.

  A mention such as `grep "gh pr create" notes.md`, or a create that printed no PR URL, produces no output. When it fires, it returns `additionalContext` with the PR URL, `transcript_path` and `session_id`, so the pkm-capture delegation can find the session transcript directly. It is plain Node with no dependencies (no `jq`) and no AI invocation.

## Setup

Hooks are registered automatically when you install the plugin:

```bash
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin install vault-pkm@claude-community
```

The plugin's `hooks/hooks.json` declares both hooks, and Claude Code manages their lifecycle. No manual configuration is needed.

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

Both hooks are `type: "command"` hooks that read the hook JSON from stdin and write a JSON result to stdout, which Claude Code injects into the session. `session-start.js` reads vault files directly. `capture-reminder.js` only inspects its stdin. Both exit within their configured timeouts.

### MCP config resolution

`session-start.js` imports its helper modules (`resolve-project.js`, `load-context.js`) using relative paths from the same directory. The `VAULT_PATH` environment variable must be set in the hook command because the hook script runs outside the MCP server process.

### Helper modules

`load-context.js` and `resolve-project.js` are shared helpers used by `session-start.js`:

- **`resolve-project.js`**: Maps the current working directory to a vault project path by reading the `# PKM:` annotation from the repo's `CLAUDE.md`
- **`load-context.js`**: Reads the project index, recent devlog entries, and active tasks from the vault and formats them as a context block

### Import rule

Hooks run with plain `node` from the plugin cache, where `node_modules` may be missing. Every hook script, and every module it imports (directly or through re-exports), may only use relative (`./`, `../`) or `node:` specifiers. `tests/manifest.test.js` walks the import graph from `hooks/*.js` and fails on any bare specifier, including unprefixed builtins like `"path"`.

## Troubleshooting

### Hook not firing

- If using the plugin: verify it's installed with `claude plugin list` and check that `VAULT_PATH` is set in `~/.claude/settings.json` under `env`
- If using manual config: verify the hook config is valid JSON in `~/.claude/settings.json`, the `matcher` pattern matches (`"startup|clear|compact"` for SessionStart, `"Bash"` for PostToolUse), and the script path is absolute
- The capture reminder stays silent unless `gh pr create` succeeded and printed the PR URL. A `gh pr create` that exits non-zero fires `PostToolUseFailure`, not `PostToolUse`.

### Script errors

- Check that `VAULT_PATH` is set correctly and the directory exists
- Verify `node` is available in the hook's PATH
- Test the scripts manually:
  ```bash
  echo '{"cwd":"/tmp","transcript_path":"/tmp/test","session_id":"abc123"}' | VAULT_PATH="/path/to/vault" node ./hooks/session-start.js
  echo '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"},"tool_response":{"stdout":"https://github.com/o/r/pull/1\n"},"session_id":"abc123","transcript_path":"/tmp/test"}' | node ./hooks/capture-reminder.js
  ```

### macOS compatibility

The scripts use standard ES module patterns for path resolution, so they work on both Linux and macOS without additional dependencies.
