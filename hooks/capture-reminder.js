#!/usr/bin/env node

// PostToolUse(Bash) hook: after a successful `gh pr create`, ask Claude to
// dispatch pkm-capture. The hooks.json `if` filter is best-effort (Claude Code
// runs the hook anyway when it cannot parse the command), so this script makes
// the authoritative decision. It runs from the plugin cache without
// node_modules, so it may only import node: builtins.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a shell command into simple commands on `&&`, `||`, `;`, `|` and
 * newlines outside quotes, and split each one into words with quotes removed.
 * `$(…)` and backtick substitutions stay inside the word they appear in.
 * @param {string} command
 * @returns {string[][]}
 */
function splitSimpleCommands(command) {
  const segments = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === "\"" && next !== undefined) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      word += command[++i];
      inWord = true;
      continue;
    }
    if (ch === "$" && next === "(") {
      let depth = 0;
      for (; i < command.length; i++) {
        word += command[i];
        if (command[i] === "(") depth++;
        else if (command[i] === ")" && --depth === 0) break;
      }
      inWord = true;
      continue;
    }
    if (ch === "`") {
      const close = command.indexOf("`", i + 1);
      const end = close === -1 ? command.length - 1 : close;
      word += command.slice(i, end + 1);
      i = end;
      inWord = true;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && next === "&")) {
      if (ch === "&" || (ch === "|" && next === "|")) i++;
      endSegment();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

/**
 * True when some simple command in `command` is a `gh pr create` invocation,
 * after stripping leading `VAR=value` assignments.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isPrCreateCommand(command) {
  if (typeof command !== "string") return false;
  return splitSimpleCommands(command).some((words) => {
    let i = 0;
    while (i < words.length && ASSIGNMENT_RE.test(words[i])) i++;
    return words[i] === "gh" && words[i + 1] === "pr" && words[i + 2] === "create";
  });
}

/**
 * First github.com pull request URL in the tool's standard output.
 * stderr is ignored: gh prints an existing PR's URL there when creation fails.
 * @param {unknown} toolResponse - Bash tool_response object, or a plain string
 * @returns {string|null}
 */
export function extractPrUrl(toolResponse) {
  const texts = [];
  if (typeof toolResponse === "string") {
    texts.push(toolResponse);
  } else if (toolResponse && typeof toolResponse === "object") {
    for (const key of ["stdout", "output"]) {
      if (typeof toolResponse[key] === "string") texts.push(toolResponse[key]);
    }
  }
  for (const text of texts) {
    const match = text.match(PR_URL_RE);
    if (match) return match[0];
  }
  return null;
}

/**
 * Hook output for a PostToolUse event, or null when no reminder is due.
 * @param {unknown} hookInput - parsed hook stdin
 * @returns {{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: string } } | null}
 */
export function buildReminder(hookInput) {
  if (!hookInput || typeof hookInput !== "object") return null;
  const input = /** @type {Record<string, any>} */ (hookInput);
  if (input.tool_name !== "Bash") return null;
  if (!isPrCreateCommand(input.tool_input?.command)) return null;
  const prUrl = extractPrUrl(input.tool_response);
  if (!prUrl) return null;

  const details = [`PR: ${prUrl}`];
  if (typeof input.transcript_path === "string" && input.transcript_path) {
    details.push(`transcript_path: ${input.transcript_path}`);
  }
  if (typeof input.session_id === "string" && input.session_id) {
    details.push(`session_id: ${input.session_id}`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `A pull request was just created (${prUrl}). Dispatch the pkm-capture agent in the background now to capture this work block into the vault. ` +
        "In the delegation prompt, include the lines below verbatim, whether this is the first capture this session " +
        "(if not, the previous devlog entry's timestamp), and the project's vault path.\n" +
        details.join("\n"),
    },
  };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const output = buildReminder(input);
  if (output) process.stdout.write(JSON.stringify(output) + "\n");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`capture-reminder: ${err.message}\n`);
  });
}
