#!/usr/bin/env bash
# Inject a PKM capture reminder into Claude's context before git commits.
# Triggered by PreToolUse hook on Bash(git commit*).
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "IMPORTANT: After this commit completes, dispatch the pkm-capture agent in the background to update the project devlog and capture any PKM-worthy content from this work block."
  }
}
EOF
