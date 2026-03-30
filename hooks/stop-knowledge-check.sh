#!/usr/bin/env bash
# Block first Stop to prompt knowledge-sweeper consideration.
# Allow second Stop (stop_hook_active=true) to prevent infinite loops.
# Triggered by Stop hook.

INPUT=$(cat)
STOP_ACTIVE=$(echo "$INPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
    try { console.log(JSON.parse(d).stop_hook_active ? 'true' : 'false'); }
    catch(e) { console.log('false'); }
  });
")

if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

echo "Before stopping, evaluate whether this exchange produced decisions, research findings, or tasks worth capturing in the PKM vault. If so, dispatch the knowledge-sweeper agent in the background. If nothing is worth capturing or knowledge-sweeper was already dispatched, you may stop." >&2
exit 2
