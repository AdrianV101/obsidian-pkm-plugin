#!/usr/bin/env bash
# Inject a devlog reminder into Claude's context before git commits.
# Triggered by PreToolUse hook on Bash(git commit*).
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "IMPORTANT: After this commit completes, dispatch the devlog-updater agent in the background to update the project devlog with what was accomplished in this commit."
  }
}
EOF
