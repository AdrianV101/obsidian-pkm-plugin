import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaptureContext } from "../hooks/capture-context.js";
import { cursorPath, deltaPath } from "../hooks/capture-state.js";
import { makeProject } from "./git-fixture.js";

const SCRIPT = fileURLToPath(new URL("../hooks/capture-context.js", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT = "vault-pkm:pkm-capture";
const SESSION = "sess-1";
const AGENT_ID = "agent1";
const NOW = Date.parse("2026-10-22T10:00:00.000Z");

let tmp, vault, data, cwd, transcript;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "capture-hooks-"));
  vault = path.join(tmp, "vault");
  data = path.join(tmp, "data");
  cwd = path.join(tmp, "MyApp");
  transcript = path.join(tmp, "session.jsonl");
  await fs.mkdir(cwd, { recursive: true });
  await makeProject(vault, "MyApp");
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const entry = (uuid, type, minute, text) => ({
  type,
  uuid,
  timestamp: `2026-10-22T09:${String(minute).padStart(2, "0")}:00.000Z`,
  message: { role: type, content: type === "assistant" ? [{ type: "text", text }] : text },
});
async function writeTranscript(entries) {
  await fs.writeFile(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const input = (over = {}) => ({
  agent_id: AGENT_ID,
  agent_type: AGENT,
  cwd,
  hook_event_name: "SubagentStart",
  session_id: SESSION,
  transcript_path: transcript,
  ...over,
});
const env = (over = {}) => ({ VAULT_PATH: vault, CLAUDE_PLUGIN_DATA: data, ...over });
async function run(over = {}, envOver = {}, now = NOW) {
  return buildCaptureContext(input(over), { env: env(envOver), now, home: tmp });
}
const contextOf = (out) => out.hookSpecificOutput.additionalContext;
const linesOf = (out) => contextOf(out).split("\n");
const captures = () => path.join(data, "captures");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

describe("buildCaptureContext", () => {
  it("ignores every agent that is not pkm-capture: no output, nothing written", async () => {
    await writeTranscript([entry("u1", "user", 1, "hi")]);
    for (const agent_type of ["general-purpose", "vault-pkm:vault-explorer", "pkm-capture-helper", undefined]) {
      const out = await run({ agent_type });
      assert.equal(out, null, String(agent_type));
    }
    await assert.rejects(fs.stat(captures()));
  });

  it("answers the first capture with four lines and writes the delta and a committed cursor", async () => {
    await writeTranscript([entry("u1", "user", 1, "first prompt"), entry("u2", "assistant", 5, "first answer")]);
    const out = await run();
    assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart");
    const lines = linesOf(out);
    const delta = deltaPath(captures(), SESSION, AGENT_ID);
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "vault-pkm capture context");
    assert.equal(lines[1], "Project: 01-Projects/MyApp (via folder name: MyApp)");
    assert.equal(lines[2], `Session: ${SESSION} - first capture this session`);
    const body = await fs.readFile(delta, "utf8");
    assert.match(body, /first prompt/);
    assert.match(body, /first answer/);
    assert.equal(
      lines[3],
      `New activity: ${delta} (${body.length} chars, 2026-10-22T09:01:00.000Z to 2026-10-22T09:05:00.000Z)`,
    );
    const cursor = await readJson(cursorPath(captures(), SESSION));
    assert.equal(cursor.committed.uuid, "u2");
    assert.equal(cursor.committed.at, new Date(NOW).toISOString());
    assert.equal(cursor.transcript_path, transcript);
  });

  it("commits at once, so the next capture covers only newer entries and names the previous capture's time", async () => {
    await writeTranscript([entry("u1", "user", 1, "old prompt")]);
    await run();
    await writeTranscript([entry("u1", "user", 1, "old prompt"), entry("u2", "user", 8, "newer prompt")]);
    const later = NOW + 60_000;
    const lines = linesOf(await run({ agent_id: "agent2" }, {}, later));
    assert.equal(lines[2], `Session: ${SESSION} - previous capture ${new Date(NOW).toISOString()}`);
    const body = await fs.readFile(deltaPath(captures(), SESSION, "agent2"), "utf8");
    assert.match(body, /newer prompt/);
    assert.doesNotMatch(body, /old prompt/);
    assert.equal((await readJson(cursorPath(captures(), SESSION))).committed.uuid, "u2");
  });

  it("reports no new activity and writes no delta when nothing is newer than the cursor", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    await run();
    const later = NOW + 60_000;
    const lines = linesOf(await run({ agent_id: "agent2" }, {}, later));
    assert.equal(lines[3], "New activity: none since the last capture");
    await assert.rejects(fs.stat(deltaPath(captures(), SESSION, "agent2")));
    const { committed } = await readJson(cursorPath(captures(), SESSION));
    assert.equal(committed.uuid, "u1");
    assert.equal(committed.at, new Date(later).toISOString());
  });

  it("says why there is no project and still gives the session and activity lines", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    const unlinked = path.join(tmp, "Unlinked");
    await fs.mkdir(unlinked);
    const table = [
      [{ VAULT_PATH: undefined }, {}, /^Project: none \(VAULT_PATH is not set\)$/],
      [{}, { cwd: unlinked }, /^Project: none \(.+\)$/],
      [{}, { cwd: undefined }, /^Project: none \(the hook input has no cwd\)$/],
      [{}, { cwd: "" }, /^Project: none \(the hook input has no cwd\)$/],
    ];
    for (const [envOver, inputOver, projectLine] of table) {
      const lines = linesOf(await run(inputOver, envOver));
      assert.equal(lines.length, 4);
      assert.match(lines[1], projectLine);
      assert.match(lines[2], /^Session: sess-1 - /);
      assert.match(lines[3], /^New activity: /);
    }
  });

  it("gives an unreadable transcript as unavailable and leaves an existing cursor unchanged", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    await run();
    const before = await fs.readFile(cursorPath(captures(), SESSION), "utf8");
    const lines = linesOf(await run({ transcript_path: path.join(tmp, "missing.jsonl") }, {}, NOW + 60_000));
    assert.match(lines[3], /^New activity: unavailable \(.+\); use vault_activity for this session and git log instead$/);
    assert.equal(await fs.readFile(cursorPath(captures(), SESSION), "utf8"), before);
  });

  it("writes no cursor when the transcript is unreadable and there was none before", async () => {
    const lines = linesOf(await run({ transcript_path: path.join(tmp, "missing.jsonl") }));
    assert.match(lines[3], /^New activity: unavailable/);
    await assert.rejects(fs.stat(cursorPath(captures(), SESSION)));
  });

  it("writes nothing and reports an unknown session when the session or agent id is unusable", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    for (const over of [{ session_id: "../x" }, { agent_id: "a/b" }, { session_id: undefined }, { agent_id: 7 }]) {
      const lines = linesOf(await run(over));
      assert.equal(lines[2], "Session: unknown", JSON.stringify(over));
      assert.equal(
        lines[3],
        "New activity: unavailable (the hook input has no usable session or agent id); use vault_activity for this session and git log instead",
      );
    }
    await assert.rejects(fs.stat(captures()));
  });

  it("still returns the context, marked unavailable, when the state directory is unwritable", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    await fs.writeFile(data, "a file where the directory should be");
    const lines = linesOf(await run());
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^Project: 01-Projects\/MyApp/);
    assert.match(lines[3], /^New activity: unavailable \(.+\); use vault_activity/);
  });

  it("prunes expired capture files on every start", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    await fs.mkdir(captures(), { recursive: true });
    const oldDelta = path.join(captures(), "old-session-agent.md");
    const oldCursor = path.join(captures(), "old-session.json");
    await fs.writeFile(oldDelta, "x");
    await fs.writeFile(oldCursor, "{}");
    const longAgo = new Date(NOW - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldDelta, longAgo, longAgo);
    await fs.utimes(oldCursor, longAgo, longAgo);
    // prune compares against the injected clock, not the real one
    await run();
    await assert.rejects(fs.stat(oldDelta));
    await assert.rejects(fs.stat(oldCursor));
    await fs.stat(cursorPath(captures(), SESSION));
  });

  it("caps each line at 480 characters and the whole context under 2,000, even with a very long path", { skip: process.platform === "win32" }, async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    const longData = path.join(tmp, ...Array.from({ length: 6 }, (_, i) => `${i}`.repeat(100)));
    const out = await run({}, { CLAUDE_PLUGIN_DATA: longData });
    const lines = linesOf(out);
    assert.ok(lines.some((l) => l.length === 480 && l.endsWith("...")), "a line was cut to exactly 480 characters");
    for (const line of lines) assert.ok(line.length <= 480, line.length);
    assert.ok(contextOf(out).length < 2000);
  });
});

describe("capture-context script", () => {
  const spawnHook = (stdin, envOver = {}) =>
    spawnSync(process.execPath, [SCRIPT], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, VAULT_PATH: vault, ...envOver },
    });

  it("exits 0 with no output on malformed or non-object stdin", () => {
    for (const stdin of ["", "not json", "null", "42", "[1]", '"text"']) {
      const r = spawnHook(stdin);
      assert.equal(r.status, 0, stdin);
      assert.equal(r.stdout, "", stdin);
    }
  });

  it("keeps the real home directory out of the project search when no home is injected", { skip: process.platform === "win32" }, async () => {
    await fs.mkdir(path.join(tmp, ".claude"));
    await fs.writeFile(path.join(tmp, ".claude", "CLAUDE.md"), "# PKM: 01-Projects/MyApp\n");
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    const r = spawnHook(JSON.stringify(input({ cwd: tmp })), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.status, 0, r.stderr);
    const lines = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split("\n");
    assert.match(lines[1], /^Project: none \(/);
  });

  it("prints SubagentStart JSON and commits the cursor under the home fallback when CLAUDE_PLUGIN_DATA is unset", async () => {
    await writeTranscript([entry("u1", "user", 1, "prompt")]);
    const childEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp, VAULT_PATH: vault };
    delete childEnv.CLAUDE_PLUGIN_DATA;
    const r = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input()), encoding: "utf8", env: childEnv });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart");
    assert.match(out.hookSpecificOutput.additionalContext, /^vault-pkm capture context\n/);
    const cursor = await readJson(path.join(tmp, ".claude", "vault-pkm", "captures", `${SESSION}.json`));
    assert.equal(cursor.committed.uuid, "u1");
  });
});

describe("hooks.json", () => {
  it("wires only a SubagentStart entry, for pkm-capture, with a 10 second timeout", async () => {
    const { hooks } = await readJson(path.join(ROOT, "hooks", "hooks.json"));
    assert.equal(hooks.SubagentStop, undefined);
    assert.equal(hooks.SubagentStart.length, 1);
    const [group] = hooks.SubagentStart;
    assert.equal(group.matcher, "^vault-pkm:pkm-capture$");
    assert.equal(group.hooks.length, 1);
    assert.equal(group.hooks[0].timeout, 10);
    assert.equal(
      group.hooks[0].command,
      'VAULT_PATH="${VAULT_PATH}" node "${CLAUDE_PLUGIN_ROOT}/hooks/capture-context.js"',
    );
  });
});
