# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue.** Instead, email the maintainer at **averhoosel@gmail.com** or use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You should receive a response within 72 hours.

## Scope

This project handles local file system access to an Obsidian vault. The main security considerations are:

- **Path traversal** -- The server validates all paths to prevent escaping the vault directory
- **SQL injection** -- All SQLite queries use parameterized statements
- **API keys** -- The `VAULT_PKM_OPENAI_KEY` (or `OPENAI_API_KEY` fallback, or the deprecated `OBSIDIAN_PKM_OPENAI_KEY`) is passed via environment variable, never stored in code or logs
- **Activity log** -- `vault_activity` stores tool call arguments in `$VAULT_PATH/.obsidian/activity-log.db`. Arguments are summarised first: strings longer than 200 characters (such as note bodies passed to `vault_append`/`vault_edit`) are stored as `<N chars>`, while path-like keys (`path`, `source`, `destination`, `folder`, `target`, `old_path`, `new_path`) are kept in full. Entries older than 90 days are deleted at server startup (change with `VAULT_PKM_ACTIVITY_RETENTION_DAYS`; `0` keeps everything), and a one-time cleanup rewrites entries stored by earlier versions the same way. Use `vault_activity({ action: "clear" })` to purge entries, or delete the DB file directly. Shorter strings, such as titles or search queries, are still stored as written

## Supported Versions

Only the latest published version is actively maintained.
