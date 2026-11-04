# Privacy Policy

_Last updated: 2026-11-04_

This document describes how the `vault-pkm` plugin (also published as `obsidian-pkm` on npm) handles your data. The plugin is open source under the MIT license; the authoritative source of truth is the code in this repository.

## Summary

- **Local-first.** Your vault contents never leave your machine unless you explicitly enable semantic search.
- **No telemetry.** The plugin does not send analytics, crash reports, usage data, or any other information to the maintainer or to Anthropic.
- **No third-party services** are contacted by default. The only outbound network request the plugin can make is to OpenAI, and only when you opt in by configuring an API key.

## What the plugin stores locally

Persistent data is stored on your own machine, mostly inside your vault directory (`VAULT_PATH`) and in per-machine cache and state folders (`<vault-hash>` is a short hash of the vault's path):

- **Notes you create or edit** via `vault_write`, `vault_append`, `vault_edit`, `vault_update_frontmatter`, `vault_add_links`, `vault_move`, and `vault_trash` — written as plain Markdown files in your vault.
- **Activity log** (`activity-log.db`, in the state folder: `~/Library/Application Support/vault-pkm/<vault-hash>/` on macOS, `$XDG_STATE_HOME/vault-pkm/<vault-hash>/` or `~/.local/state/vault-pkm/<vault-hash>/` on Linux, `%LOCALAPPDATA%\vault-pkm\<vault-hash>\` on Windows) — a SQLite database recording MCP tool calls (tool name, timestamp, session ID, note path and summarised arguments — any argument longer than 200 characters, such as note content or a long frontmatter value, is stored only as its length; vault paths, meaning the top-level path arguments and `vault_add_links` link targets, are kept in full) so Claude can recall prior session activity. Entries older than 90 days are deleted at server start (`VAULT_PKM_ACTIVITY_RETENTION_DAYS`, `0` = keep forever). You can clear it at any time via `vault_activity({ action: "clear" })` or by deleting the file. Deleted entries are overwritten with zeros in the database file. An older copy at `$VAULT_PATH/.obsidian/activity-log.db` is copied to the state folder on first start and left in place; delete it if you do not want to keep it.
- **Semantic index** (`index.db`, in the cache folder: `~/Library/Caches/vault-pkm/<vault-hash>/` on macOS, `$XDG_CACHE_HOME/vault-pkm/<vault-hash>/` or `~/.cache/vault-pkm/<vault-hash>/` on Linux, `%LOCALAPPDATA%\vault-pkm\Cache\<vault-hash>\` on Windows; only if semantic search is enabled) — a SQLite database containing OpenAI embedding vectors for your note chunks. It is a regenerable cache; deleting it is safe. Earlier versions kept it at `$VAULT_PATH/.obsidian/semantic-index.db`, which is no longer used and can be deleted.
- **Shared embedding packs** in `$VAULT_PATH/06-System/vault-pkm/embeddings/` (only if semantic search is enabled and `VAULT_PKM_SHARED_CACHE` is not `off`) — files of embedding vectors keyed by a hash of each chunk's text, so your other machines do not pay to embed the same text again. They contain vectors, not note text, but the vectors are derived from your note content. They live in the vault, so a sync service carries them to your other devices (Obsidian Sync needs "Sync all other types" turned on). Deleting the folder is safe; the vectors are recomputed when needed.

Nothing the plugin stores is uploaded anywhere by this plugin. If your vault is synced via Obsidian Sync, iCloud, Dropbox, etc., those services apply their own privacy terms.

## What the plugin sends to third parties

### OpenAI (opt-in only)

When — and only when — you set `VAULT_PKM_OPENAI_KEY` (or the legacy `OPENAI_API_KEY` / `OBSIDIAN_PKM_OPENAI_KEY` fallbacks), the following two tools become available:

- `vault_semantic_search`
- `vault_suggest_links` (when called with `graph_context: true`)

These tools, plus the background indexer that keeps the semantic index fresh, send note text to OpenAI's embeddings endpoint (`https://api.openai.com/v1/embeddings`, model `text-embedding-3-small`) so it can be converted into vector embeddings for similarity search. The data sent includes:

- The text of notes in your vault (whole notes for short files, chunks of about 1,000 tokens for longer ones, each starting with the note title and heading path).
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
- **Delete local data** by removing the cache and state folders described above (`index.db`, `activity-log.db`) and the `06-System/vault-pkm/embeddings/` folder in your vault; delete the old `$VAULT_PATH/.obsidian/activity-log.db` and `semantic-index.db` too if they exist.
- **Stop sharing vectors between machines** with `VAULT_PKM_SHARED_CACHE=off` on a machine.
- **Clear activity history** with `vault_activity({ action: "clear" })`, optionally scoped by date with `before`.
- **Inspect what is sent** by reading the source — embedding requests are made in `embeddings.js`, and the activity log is implemented in `activity.js`.

## Contact

Questions or concerns: open an issue at <https://github.com/AdrianV101/obsidian-pkm-plugin/issues>.
