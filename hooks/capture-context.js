#!/usr/bin/env node

// SubagentStart hook: when the pkm-capture agent starts, hand it the project, the
// session and a file with the transcript activity since the previous capture.
// The cursor is committed here, not when the agent finishes: Claude Code gives a
// stop hook no final message to judge success by, so a failed capture is not
// retried automatically. It runs from the plugin cache without node_modules, so it
// may only import relative modules and node: builtins.

import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_AGENT_RE,
  capturesDir,
  deltaPath,
  pruneCaptures,
  readCursor,
  safeId,
  startPoint,
  writeCursor,
} from "./capture-state.js";
import { devlogFolder, findSessionNote, sessionPrefix } from "../devlog.js";
import { describeVia, resolveProject } from "./resolve-project.js";
import { condenseTranscript } from "./transcript.js";

const LINE_CAP = 480;
const FALLBACK_HINT = "use vault_activity for this session and git log instead";

/** @param {string} line */
function cap(line) {
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP - 3)}...` : line;
}

/** @param {unknown} err */
function reasonOf(err) {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/** @param {unknown} err */
function unavailable(err) {
  return `New activity: unavailable (${typeof err === "string" ? err : reasonOf(err)}); ${FALLBACK_HINT}`;
}

/**
 * @param {unknown} cwd
 * @param {string|undefined} vaultPath
 * @param {string|undefined} home undefined lets the resolver use the real home directory
 * @returns {Promise<{ line: string, resolved: boolean, projectPath: string|null }>}
 */
async function projectLine(cwd, vaultPath, home) {
  const none = (reason) => ({ line: `Project: none (${reason})`, resolved: false, projectPath: null });
  if (!vaultPath) return none("VAULT_PATH is not set");
  if (typeof cwd !== "string" || !cwd) return none("the hook input has no cwd");
  try {
    const resolution = await resolveProject(cwd, vaultPath, home === undefined ? {} : { home });
    if (resolution.projectPath) {
      return { line: `Project: ${resolution.projectPath} (${describeVia(resolution)})`, resolved: true, projectPath: resolution.projectPath };
    }
    return none(resolution.reason ?? "not resolved");
  } catch (err) {
    return none(reasonOf(err));
  }
}

/**
 * Reads the new transcript activity and writes it to a delta file. The cursor is
 * committed only when `commit` is set: a capture without a project writes nothing
 * but inbox tasks, so its range stays open for the capture after the repo is linked.
 * `sessionStart` is the transcript's first timestamp; `transcriptError` is set when
 * the transcript could not be read at all.
 * @returns {Promise<{ session: string, activity: string, sessionStart: string|null, transcriptError: string|null }>}
 */
async function captureActivity(input, dir, nowMs, commit) {
  const sessionId = input.session_id;
  const agentId = input.agent_id;
  const cursor = await readCursor(dir, sessionId);
  const session = cursor.committed?.at
    ? `Session: ${sessionId} - previous capture ${cursor.committed.at}`
    : `Session: ${sessionId} - first capture this session`;

  let raw;
  try {
    if (typeof input.transcript_path !== "string" || !input.transcript_path) throw new Error("no transcript path");
    raw = await fs.readFile(input.transcript_path, "utf8");
  } catch (err) {
    return {
      session,
      activity: unavailable(`cannot read the transcript: ${reasonOf(err)}`),
      sessionStart: null,
      transcriptError: "cannot read the transcript",
    };
  }

  const condensed = condenseTranscript(raw, { afterUuid: startPoint(cursor) });
  try {
    let activity = "New activity: none since the last capture";
    if (condensed.entryCount > 0) {
      const file = deltaPath(dir, sessionId, agentId);
      // The delta copies conversation text, and Claude Code keeps transcripts owner-only.
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file, condensed.text, { mode: 0o600 });
      const omitted = condensed.truncated ? ", oldest part omitted" : "";
      activity = `New activity: ${file} (${condensed.text.length} chars, ${condensed.firstTimestamp} to ${condensed.lastTimestamp}${omitted})`;
    }
    if (commit && condensed.lastUuid) {
      await writeCursor(dir, sessionId, {
        version: 1,
        transcript_path: input.transcript_path,
        committed: { uuid: condensed.lastUuid, at: new Date(nowMs).toISOString() },
      });
    }
    return { session, activity, sessionStart: condensed.sessionStart, transcriptError: null };
  } catch (err) {
    return {
      session,
      activity: unavailable(`cannot write capture state: ${reasonOf(err)}`),
      sessionStart: condensed.sessionStart,
      transcriptError: null,
    };
  }
}

/**
 * Which note this session's capture goes into: the existing one, a name for a new
 * one, or why neither can be determined.
 * @param {string} vaultPath
 * @param {string} projectPath vault-relative
 * @param {string} sessionId
 * @param {string|null} sessionStart
 * @param {string|null} transcriptError
 */
async function devlogLine(vaultPath, projectPath, sessionId, sessionStart, transcriptError) {
  const unavailableLine = (reason, id = sessionId) =>
    `Devlog: unavailable (${reason}); find this session's note with vault_query (session: ${id}) or create one`;
  if (transcriptError) return unavailableLine(transcriptError);
  const prefix = sessionPrefix(sessionStart);
  if (!prefix) return unavailableLine("the transcript has no timestamp");
  const folder = devlogFolder(projectPath);
  try {
    const found = await findSessionNote(path.join(vaultPath, ...folder.split("/")), prefix, sessionId);
    return found
      ? `Devlog: ${folder}/${found} (add a section)`
      : `Devlog: new note ${folder}/${prefix} <Title>.md (session: ${sessionId})`;
  } catch (err) {
    return unavailableLine(`cannot read the devlog folder: ${reasonOf(err)}`);
  }
}

/**
 * Hook output for a SubagentStart event, or null when the agent is not pkm-capture.
 * Never throws.
 * @param {unknown} hookInput - parsed hook stdin
 * @param {{ env?: Record<string, string|undefined>, now?: number, home?: string }} [options]
 * @returns {Promise<{ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: string } } | null>}
 */
export async function buildCaptureContext(hookInput, { env = process.env, now = Date.now(), home } = {}) {
  try {
    if (!hookInput || typeof hookInput !== "object" || Array.isArray(hookInput)) return null;
    const input = /** @type {Record<string, any>} */ (hookInput);
    if (typeof input.agent_type !== "string" || !CAPTURE_AGENT_RE.test(input.agent_type)) return null;

    const dir = capturesDir(env, home);
    const project = await projectLine(input.cwd, env.VAULT_PATH, home);
    let session = "Session: unknown";
    let activity = unavailable("the hook input has no usable session or agent id");
    let devlog = "Devlog: unavailable (the hook input has no usable session id); find this session's note with vault_query (session: unknown) or create one";
    if (safeId(input.session_id) && safeId(input.agent_id)) {
      const captured = await captureActivity(input, dir, now, project.resolved);
      ({ session, activity } = captured);
      if (project.projectPath && env.VAULT_PATH) {
        devlog = await devlogLine(env.VAULT_PATH, project.projectPath, input.session_id, captured.sessionStart, captured.transcriptError);
      }
      await pruneCaptures(dir, now);
    }

    const lines = ["vault-pkm capture context", project.line, session, activity];
    if (project.resolved) lines.push(devlog);
    return {
      hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: lines.map(cap).join("\n") },
    };
  } catch (err) {
    process.stderr.write(`capture-context: ${reasonOf(err)}\n`);
    return null;
  }
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
  const output = await buildCaptureContext(input);
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
    process.stderr.write(`capture-context: ${reasonOf(err)}\n`);
  });
}
