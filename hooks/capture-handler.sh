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

Using the vault tools available to you, create a properly structured vault note:

- **adr**: vault_write with template 'adr'. Path: 01-Projects/{project}/development/decisions/ADR-NNN-{kebab-title}.md. List existing ADRs with vault_list to determine next number. Expand content into Context, Decision, Consequences sections.
- **task**: First vault_query to check for existing task with similar title. If exists, vault_update_frontmatter to update. If not, vault_write with template 'task'. Path: 01-Projects/{project}/tasks/{kebab-title}.md.
- **research**: vault_write with template 'research-note'. Path: 01-Projects/{project}/research/{kebab-title}.md.
- **bug**: vault_write with template 'troubleshooting-log'. Path: 01-Projects/{project}/development/debug/{kebab-title}.md.

Always verify the note was created successfully. If vault_write fails (e.g., file exists), adapt — use vault_append or choose a different filename."

# Spawn claude -p in background (detached, no stdin/stdout)
echo "$PROMPT" | nohup claude -p --model opus --mcp-config "$MCP_CONFIG" --max-turns 10 > /dev/null 2>&1 &

exit 0
