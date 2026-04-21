---
name: setup
description: Configure Vault PKM plugin — set vault path, API keys, and verify setup
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion]
---

# Vault PKM Setup

You are configuring the Vault PKM plugin. Walk the user through these steps:

## Step 1: Vault Path

Ask the user for their Obsidian vault path. Validate that:
- The path exists and is a directory
- It contains at least one `.md` file
- Suggest `~/Documents/PKM` as a default

If the path is valid, add it to `~/.claude/settings.json` under the `env` block:

```json
{
  "env": {
    "VAULT_PATH": "/absolute/path/to/vault"
  }
}
```

Read the file first, merge with existing env vars (don't overwrite other settings), and write back. Verify the MCP server can connect after setting it.

## Step 2: OpenAI API Key (Optional)

Ask if they want semantic search features (vault_semantic_search, vault_suggest_links). If yes:

- **NEVER ask the user to type their API key in the chat** — it would be stored in conversation history
- Tell them to open `~/.claude/settings.json` in their text editor (outside of Claude Code) and add `VAULT_PKM_OPENAI_KEY` to the `env` block:
  ```json
  {
    "env": {
      "VAULT_PATH": "/path/to/vault",
      "VAULT_PKM_OPENAI_KEY": "sk-your-key-here"
    }
  }
  ```
- Explain the variable is named `VAULT_PKM_OPENAI_KEY` (not `OPENAI_API_KEY`) to avoid conflicts with project-scoped OpenAI keys. Users upgrading from earlier releases can keep `OBSIDIAN_PKM_OPENAI_KEY` — it still works as a deprecated fallback — but should rename it at their convenience.
- Explain they can get a key from https://platform.openai.com/api-keys
- Explain this enables 2 additional tools (semantic search + link suggestions) but is completely optional
- Tell them to restart Claude Code after saving the file

## Step 3: Tool Permissions

Ask the user if they want to auto-approve all PKM vault tools (so they don't get prompted for each tool call). If yes, add this to the `permissions.allow` array in `~/.claude/settings.json`:

```
mcp__plugin_vault-pkm_vault-pkm__*
```

Read the file first, merge with existing permissions (don't overwrite), and write back. This allows all vault_read, vault_write, vault_search, etc. tools to run without per-call confirmation.

## Step 4: Vault Scaffolding

Check if the vault has templates:
1. Check if templates exist: `ls "$VAULT_PATH/05-Templates/" 2>/dev/null`
2. If missing, tell the user to run `npx obsidian-pkm init` in their terminal to scaffold the vault with templates and PARA folder structure. This is a separate interactive tool that handles vault scaffolding.

## Step 5: Verify Setup

Ask the user to verify by requesting a vault operation. For example, tell them to ask Claude: "List the folders in my vault." This calls `vault_list`, which exercises the full MCP server connection and vault path configuration.

- If it returns the vault's directory structure, setup is complete.
- If it fails, suggest restarting Claude Code (`/quit` and relaunch) and re-running `/vault-pkm:setup`.

## Step 6: Migration Check

Check if the old `pkm-mcp-server` is installed:
1. Run `npm list -g pkm-mcp-server --depth=0 2>/dev/null`
2. Check for stale hooks: `ls ~/.claude/hooks/pkm/ 2>/dev/null`

If found:
- Suggest: `npm uninstall -g pkm-mcp-server`
- Suggest removing `~/.claude/hooks/pkm/` directory (hooks are now managed by the plugin)
- Check `~/.claude/settings.json` for old hook entries and offer to clean them up

## Step 7: Done

> **IMPORTANT:** Restart Claude Code now (`/quit` then relaunch) before using any vault tools. The MCP server needs to restart to pick up the new environment variables.

Confirm setup is complete. Tell the user:
- "Your Vault PKM plugin is configured. Try asking me to list your vault folders to verify."
- If VAULT_PKM_OPENAI_KEY was set: "Semantic search will build its index in the background on first use."
- **Important**: "Restart your Claude Code session for the MCP server to pick up the new environment variables."
