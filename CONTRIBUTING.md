# Contributing

Thanks for your interest in contributing! Here's how to get started.

## First-Time Contributors

New to this project? We'd love your help! Check the [issue tracker](https://github.com/AdrianV101/obsidian-pkm-plugin/issues) for issues labeled **"good first issue"** -- these are specifically chosen as approachable entry points. Don't hesitate to ask questions on any issue; we're happy to provide guidance.

## Code of Conduct

Be respectful, constructive, and inclusive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Development Setup

**Prerequisites:** Node.js >= 20 (22 or 24 recommended). `better-sqlite3` normally installs a prebuilt binary; if npm has to compile it, you need C++ build tools: `xcode-select --install` on macOS, `sudo apt install build-essential python3` on Debian/Ubuntu, or Visual Studio Build Tools with the "Desktop development with C++" workload on Windows.

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Set environment variables (only needed to run the server, not for tests):
   ```bash
   export VAULT_PATH="/path/to/test/vault"
   # Optional: export VAULT_PKM_OPENAI_KEY="sk-..." for semantic search
   ```

3. Run the server:
   ```bash
   npm start
   ```

4. Run tests (uses Node.js built-in test runner with `node:test` and `assert/strict`):
   ```bash
   npm test                                          # full suite
   node --test tests/handlers.test.js                # single file
   node --test --test-name-pattern "vault_read" tests/handlers.test.js  # by name
   ```
   Tests use temp directories and don't require `VAULT_PATH` or a real vault.

5. Run the linter and the type checker:
   ```bash
   npm run lint        # ESLint over *.js, hooks/, scripts/, tests/
   npm run typecheck   # tsc over the JSDoc types (jsconfig.json)
   ```

## Architecture Overview

```
index.js        - MCP server setup, request routing
tools.js        - MCP tool definitions (names, descriptions, input schemas)
handlers.js     - Tool handler implementations (all 20 handlers)
helpers.js      - Pure helper functions (path resolution, filtering, templates, fuzzy matching, peek/redirect)
graph.js        - Wikilink resolution and BFS graph traversal
embeddings.js   - Semantic search (OpenAI embeddings, SQLite + sqlite-vec)
activity.js     - Activity logging (session tracking, SQLite)
utils.js        - Shared utilities (frontmatter parsing, file listing)
cli.js          - CLI entry point (routes `init` / `doctor` subcommands or starts server)
init.js         - Vault scaffolding wizard (templates, PARA folders)
doctor.js       - `obsidian-pkm doctor` setup diagnostics
hooks/          - Claude Code hooks (session context loading, project resolution, PR capture reminder)
scripts/        - Release tooling (publish-time tag/version check)
templates/      - Obsidian note templates (copy to vault's 05-Templates/)
sample-project/ - Sample CLAUDE.md for integrating PKM into your repos
```

## Code Style

- ES modules (`import`/`export`), no CommonJS
- Double quotes, semicolons (convention, not lint-enforced)
- `const` by default, `let` when reassignment is needed, never `var`
- JSDoc on exported functions
- Strict equality (`===`) always

Run `npm run lint` before submitting. The project uses ESLint with a flat config.

## Making Changes

1. Fork the repo and create a feature branch from `next` (the integration branch; `master` only receives release merges)
2. Make your changes
3. Add or update tests for new functionality
4. Run `npm test && npm run lint && npm run typecheck` and ensure all three pass
5. Open a pull request against `next` with a clear description of the change

A PR template is provided at `.github/PULL_REQUEST_TEMPLATE.md` to help structure your submission.

## Commit Message Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Each commit message should be prefixed with a type:

| Prefix | Purpose |
|--------|---------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `chore:` | Maintenance (dependencies, CI, tooling) |

Examples:

```
feat: add vault_semantic_search tool
fix: prevent path traversal in vault_read
docs: update README with semantic search setup
refactor: extract wikilink parsing into graph.js
test: add coverage for fuzzy path resolution
chore: bump sqlite-vec to 0.2.0
```

Keep the subject line under 72 characters. Add a body for non-trivial changes explaining the "why."

## Adding a New Tool

Each MCP tool requires changes in three files (`tools.js`, `handlers.js`, `tests/handlers.test.js`):

1. **Define the tool schema** in `tools.js` inside `createToolsList()`. Add a tool object with `name`, `description`, and `inputSchema` (JSON Schema for parameters); tools that need the semantic index go in the `hasSemanticIndex` block.

2. **Implement the handler** in `handlers.js` inside the `createHandlers()` closure. Write an `async function handleYourTool(args)` that returns `{ content: [{ type: "text", text: "..." }] }`. Use `resolvePath(args.path)` for path security, `positiveInt(args.limit, 10)` for numeric params, and the standard ENOENT catch pattern for file reads.

3. **Register it** in the `Map` returned at the end of `createHandlers()`: add `["vault_your_tool", handleYourTool]`. `tests/manifest.test.js` fails if the names in `tools.js` and this map differ.

4. **Add tests** in `tests/handlers.test.js`. Tests call `createHandlers({ vaultPath: tmpDir, templateRegistry, semanticIndex: null, activityLog: null, sessionId })` to build handlers against a temp vault with real files. Test both the happy path and error cases (missing files, invalid params).

Look at a simple handler like `handleList` or `handleRecent` for the pattern.

## Adding Templates

Place new templates in `templates/` following existing conventions:
- YAML frontmatter with `type`, `created`, `tags` fields
- Use `<% tp.date.now("YYYY-MM-DD") %>` and `<% tp.file.title %>` for auto-substitution
- Include HTML comments as guidance for users

## Reporting Issues

Open an issue on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS
