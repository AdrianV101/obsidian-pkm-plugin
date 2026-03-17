#!/usr/bin/env bash
# PostToolUse hook: explicit PKM capture via vault_capture tool
# Runs async after vault_capture returns. Spawns claude -p with Opus
# to create a properly structured vault note.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract tool_input fields
TOOL_INPUT=$(echo "$INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(JSON.stringify(j.tool_input||{}))})")
CAPTURE_TYPE=$(echo "$TOOL_INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.type||'')})")
CAPTURE_TITLE=$(echo "$TOOL_INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.title||'')})")
CAPTURE_CONTENT=$(echo "$TOOL_INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.content||'')})")
CAPTURE_PRIORITY=$(echo "$TOOL_INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.priority||'normal')})")
CAPTURE_PROJECT=$(echo "$TOOL_INPUT" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.project||'')})")

# Skip if missing required fields
if [ -z "$CAPTURE_TYPE" ] || [ -z "$CAPTURE_TITLE" ] || [ -z "$CAPTURE_CONTENT" ]; then
  exit 0
fi

# MCP config for obsidian-pkm server
SCRIPT_DIR=$(dirname "$(readlink -f "$0")")
MCP_CONFIG='{"mcpServers":{"obsidian-pkm":{"command":"node","args":["'"${SCRIPT_DIR}/../index.js"'"],"env":{"VAULT_PATH":"'"${VAULT_PATH:-$HOME/Documents/PKM}"'"}}}}'

# Build project context for prompt
PROJECT_HINT=""
if [ -n "$CAPTURE_PROJECT" ]; then
  PROJECT_HINT="The project is: $CAPTURE_PROJECT"
else
  PROJECT_HINT="The project is not specified. Check vault_activity recent entries to infer the active project."
fi

PROMPT="You are a PKM note creation agent. A Claude Code session has explicitly signaled that something is worth capturing.

## Capture Details

- Type: $CAPTURE_TYPE
- Title: $CAPTURE_TITLE
- Content: $CAPTURE_CONTENT
- Priority: $CAPTURE_PRIORITY
- $PROJECT_HINT

## Instructions

You MUST complete TWO steps — creating the note AND filling in its content.

### Step 1: Create the note from template

- **adr**: vault_write with template 'adr'. Path: 01-Projects/{project}/development/decisions/ADR-NNN-{kebab-title}.md. List existing ADRs with vault_list to determine next number.
- **task**: First vault_query to check for existing task with similar title. If exists, vault_update_frontmatter to update and stop. If not, vault_write with template 'task'. Path: 01-Projects/{project}/tasks/{kebab-title}.md.
- **research**: vault_write with template 'research-note'. Path: 01-Projects/{project}/research/{kebab-title}.md.
- **bug**: vault_write with template 'troubleshooting-log'. Path: 01-Projects/{project}/development/debug/{kebab-title}.md.

If vault_write fails (e.g., file exists), adapt — use vault_append or choose a different filename.

### Step 2: Replace template placeholders with real content

After creating the note, use vault_edit to replace EACH template placeholder section with content expanded from the Capture Details above. The template will contain generic text like 'Brief description of the technology, tool, or concept.' — you must replace these with substantive content derived from the Title and Content fields.

For research notes, fill in: What It Is, Why Consider It, Pros, Cons, and Verdict.
For ADRs, fill in: Context, Decision, Options Considered, and Consequences.
For bugs, fill in: Problem, Symptoms, Root Cause, Solution, and Prevention.
For tasks, fill in: Description, Context, and Acceptance Criteria.

Do NOT leave any template placeholder text in the final note. Every section must contain real content or be removed if not applicable."

# Spawn claude -p in background (detached, no stdin/stdout)
echo "$PROMPT" | nohup claude -p --model sonnet --mcp-config "$MCP_CONFIG" --max-turns 10 > /dev/null 2>&1 &

exit 0
