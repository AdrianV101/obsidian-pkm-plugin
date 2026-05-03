# Privacy Policy

_Last updated: 2026-05-03_

This document describes how the `vault-pkm` plugin (also published as `obsidian-pkm` on npm) handles your data. The plugin is open source under the MIT license; the authoritative source of truth is the code in this repository.

## Summary

- **Local-first.** Your vault contents never leave your machine unless you explicitly enable semantic search.
- **No telemetry.** The plugin does not send analytics, crash reports, usage data, or any other information to the maintainer or to Anthropic.
- **No third-party services** are contacted by default. The only outbound network request the plugin can make is to OpenAI, and only when you opt in by configuring an API key.

## What the plugin stores locally

All persistent data is stored inside your vault directory (`VAULT_PATH`) on your own machine:

- **Notes you create or edit** via `vault_write`, `vault_append`, `vault_edit`, `vault_update_frontmatter`, `vault_add_links`, `vault_move`, and `vault_trash` — written as plain Markdown files in your vault.
- **Activity log** at `$VAULT_PATH/.obsidian/activity-log.db` — a SQLite database recording MCP tool calls (tool name, timestamp, session ID, and path) so Claude can recall prior session activity. You can clear it at any time via `vault_activity({ action: "clear" })` or by deleting the file.
- **Semantic index** at `$VAULT_PATH/.obsidian/semantic-index.db` (only if semantic search is enabled) — a SQLite database containing OpenAI embedding vectors for your note chunks. It is a regenerable cache; deleting it is safe.

Nothing in `.obsidian/` is uploaded anywhere by this plugin. If your vault is synced via Obsidian Sync, iCloud, Dropbox, etc., those services apply their own privacy terms.

## What the plugin sends to third parties

### OpenAI (opt-in only)

When — and only when — you set `VAULT_PKM_OPENAI_KEY` (or the legacy `OPENAI_API_KEY` / `OBSIDIAN_PKM_OPENAI_KEY` fallbacks), the following two tools become available:

- `vault_semantic_search`
- `vault_suggest_links` (when called with `graph_context: true`)

These tools, plus the background indexer that keeps the semantic index fresh, send note text to OpenAI's embeddings endpoint (`https://api.openai.com/v1/embeddings`, model `text-embedding-3-large`) so it can be converted into vector embeddings for similarity search. The data sent includes:

- The text of notes in your vault (whole notes for short files, heading-based chunks for longer ones).
- Any query string you pass to `vault_semantic_search`.

OpenAI's handling of API data is governed by their [API data usage policies](https://openai.com/policies/api-data-usage-policies). As of this writing, OpenAI states that data submitted via the API is not used to train their models and is retained only for limited abuse-monitoring purposes.

If you do not set an OpenAI API key, the semantic tools are hidden from the tool list and no note content ever leaves your machine through this plugin.

### Anthropic (Claude Code)

This plugin runs as an MCP server inside Claude Code. Claude Code itself communicates with Anthropic's API to power the assistant. That data flow is covered by [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) and is independent of this plugin.

The plugin does not send anything to Anthropic directly.

## What the plugin does NOT do

- It does not collect or transmit telemetry, analytics, or crash reports.
- It does not contact any server controlled by the maintainer.
- It does not read files outside your configured `VAULT_PATH` (path traversal is blocked).
- It does not modify files in your vault unless you (or Claude, on your behalf) call a write/edit tool.

## Your controls

- **Disable semantic search** by unsetting `VAULT_PKM_OPENAI_KEY` (and any legacy fallbacks). The semantic tools will disappear from the tool list and no further calls will be made to OpenAI.
- **Delete local data** by removing files under `$VAULT_PATH/.obsidian/` (`activity-log.db`, `semantic-index.db`).
- **Clear activity history** with `vault_activity({ action: "clear" })`, optionally scoped by date with `before`.
- **Inspect what is sent** by reading the source — embedding requests are made in `embeddings.js`, and the activity log is implemented in `activity.js`.

## Contact

Questions or concerns: open an issue at <https://github.com/AdrianV101/obsidian-pkm-plugin/issues>.
