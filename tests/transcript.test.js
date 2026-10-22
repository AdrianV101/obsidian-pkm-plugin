import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { condenseTranscript, MAX_DELTA_CHARS } from "../hooks/transcript.js";

let seq = 0;
const nextUuid = () => `u${String(++seq).padStart(4, "0")}`;
const ts = (minute) => `2026-10-21T09:${String(minute).padStart(2, "0")}:30.000Z`;

function user(content, extra = {}) {
  return { type: "user", uuid: nextUuid(), timestamp: ts(0), message: { role: "user", content }, ...extra };
}
function assistant(blocks, extra = {}) {
  return { type: "assistant", uuid: nextUuid(), timestamp: ts(1), message: { role: "assistant", content: blocks }, ...extra };
}
const text = (t) => ({ type: "text", text: t });
const toolUse = (name, input) => ({ type: "tool_use", id: "t1", name, input });
const toolResult = (content, isError) => user([{ type: "tool_result", tool_use_id: "t1", content, is_error: isError }]);
const jsonl = (entries, sep = "\n") => entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(sep) + sep;
const lines = (r) => r.text.split("\n");

describe("condenseTranscript", () => {
  it("exports the 40,000 character budget", () => {
    assert.equal(MAX_DELTA_CHARS, 40000);
  });

  it("keeps typed prompts and Claude's text with UTC timestamps, in order", () => {
    const entries = [
      user("string prompt", { timestamp: "2026-10-21T09:05:00.000Z", origin: { kind: "human" } }),
      assistant([text("first answer")], { timestamp: "2026-10-21T09:06:00.000Z" }),
      user([text("block prompt")], { timestamp: "2026-10-21T23:59:00.000Z" }),
      assistant([text("second answer")], { timestamp: "2026-10-22T00:01:00.000Z" }),
    ];
    const r = condenseTranscript(jsonl(entries));
    assert.deepEqual(lines(r), [
      "[2026-10-21 09:05] User: string prompt",
      "[2026-10-21 09:06] Claude: first answer",
      "[2026-10-21 23:59] User: block prompt",
      "[2026-10-22 00:01] Claude: second answer",
    ]);
    assert.equal(r.entryCount, 4);
  });

  const excluded = [
    ["thinking block", assistant([{ type: "thinking", thinking: "SECRET" }])],
    ["sidechain user", user("SECRET", { isSidechain: true })],
    ["sidechain assistant", assistant([text("SECRET")], { isSidechain: true })],
    ["meta entry", user("SECRET", { isMeta: true })],
    ["compact summary", user("SECRET", { isCompactSummary: true })],
    ["task notification", user("SECRET", { origin: { kind: "task-notification" } })],
    ["peer message", user("SECRET", { origin: { kind: "peer" } })],
    ["coordinator message", user("SECRET", { origin: { kind: "coordinator" } })],
    ["system entry", { type: "system", uuid: nextUuid(), timestamp: ts(2), content: "SECRET" }],
    ["attachment entry", { type: "attachment", uuid: nextUuid(), timestamp: ts(2), attachment: { text: "SECRET" } }],
  ];
  for (const [name, entry] of excluded) {
    it(`never includes a ${name}`, () => {
      const r = condenseTranscript(jsonl([entry]));
      assert.equal(r.text, "");
      assert.equal(r.entryCount, 0);
      assert.equal(r.lastUuid, entry.uuid);
    });
  }

  const toolCases = [
    ["Bash with a description", toolUse("Bash", { command: "ls -la", description: "List files" }), "  Bash: List files"],
    ["Bash without a description", toolUse("Bash", { command: "x".repeat(300) }), `  Bash: ${"x".repeat(120)}`],
    ["Bash with a multi-line command and no description", toolUse("Bash", { command: "cat <<EOF\n  line one\n\nline two\nEOF" }), "  Bash: cat <<EOF line one line two EOF"],
    ["Edit", toolUse("Edit", { file_path: "/a/b.js", old_string: "o", new_string: "n" }), "  Edit: /a/b.js"],
    ["Read", toolUse("Read", { file_path: "/a/c.js" }), "  Read: /a/c.js"],
    ["Write", toolUse("Write", { file_path: "/a/d.js", content: "BODY" }), "  Write: /a/d.js"],
    ["Agent", toolUse("Agent", { description: "Explore code", prompt: "long prompt" }), "  Agent: Explore code"],
    ["MCP vault tool", toolUse("mcp__plugin_vault-pkm_vault-pkm__vault_read", { path: "01-Projects/X/_index.md" }), "  vault_read 01-Projects/X/_index.md"],
    ["unknown tool", toolUse("WebSearch", { query: "q" }), "  WebSearch"],
  ];
  for (const [name, block, expected] of toolCases) {
    it(`${name} becomes one line`, () => {
      const r = condenseTranscript(jsonl([assistant([block])]));
      assert.equal(r.text, expected);
      assert.equal(r.entryCount, 1);
    });
  }

  const resultCases = [
    ["string error", toolResult("boom: failed\nstack line 2", true), "  Error: boom: failed"],
    ["text-block error", toolResult([text("first line\nsecond"), text("more")], true), "  Error: first line"],
  ];
  for (const [name, entry, expected] of resultCases) {
    it(`a ${name} shows its first line`, () => {
      assert.equal(condenseTranscript(jsonl([entry])).text, expected);
    });
  }

  it("a successful result never appears", () => {
    const entries = [toolResult("SECRET output", false), toolResult([text("SECRET")], undefined)];
    const r = condenseTranscript(jsonl(entries));
    assert.equal(r.text, "");
    assert.equal(r.entryCount, 0);
  });

  it("long user and assistant text is cut at its limit and marked", () => {
    const r = condenseTranscript(jsonl([user("u".repeat(2500)), assistant([text("a".repeat(3500))])]));
    const [u, a] = lines(r);
    assert.ok(u.startsWith(`[2026-10-21 09:00] User: ${"u".repeat(2000)}`));
    assert.ok(!u.includes("u".repeat(2001)));
    assert.match(u, /truncated 500 chars/);
    assert.ok(a.startsWith(`[2026-10-21 09:01] Claude: ${"a".repeat(3000)}`));
    assert.ok(!a.includes("a".repeat(3001)));
    assert.match(a, /truncated 500 chars/);
  });

  it("text exactly at its limit is not marked", () => {
    const r = condenseTranscript(jsonl([user("u".repeat(2000))]));
    assert.doesNotMatch(r.text, /truncated/);
  });

  it("with a cursor only later entries appear, lastUuid is the file's last entry", () => {
    const e = [user("one"), assistant([text("two")]), user("three"), { type: "system", uuid: nextUuid(), timestamp: ts(3) }];
    const r = condenseTranscript(jsonl(e), { afterUuid: e[1].uuid });
    assert.equal(r.text, "[2026-10-21 09:00] User: three");
    assert.equal(r.entryCount, 1);
    assert.equal(r.lastUuid, e[3].uuid);
  });

  const fromStart = [["a null cursor", null], ["an undefined cursor", undefined], ["a cursor not in the file", "nope"]];
  for (const [name, cursor] of fromStart) {
    it(`${name} starts from the beginning`, () => {
      const e = [user("one"), assistant([text("two")])];
      const r = condenseTranscript(jsonl(e), { afterUuid: cursor });
      assert.equal(r.entryCount, 2);
      assert.equal(r.lastUuid, e[1].uuid);
    });
  }

  it("nothing after the cursor gives an empty result", () => {
    const e = [user("one"), assistant([text("two")])];
    const r = condenseTranscript(jsonl(e), { afterUuid: e[1].uuid });
    assert.deepEqual(r, {
      text: "", lastUuid: e[1].uuid, entryCount: 0, truncated: false, firstTimestamp: null, lastTimestamp: null,
    });
  });

  it("an empty file keeps the cursor", () => {
    const r = condenseTranscript("", { afterUuid: "cur" });
    assert.equal(r.lastUuid, "cur");
    assert.equal(r.entryCount, 0);
  });

  it("over maxChars the oldest lines drop, the newest stay, behind a marker", () => {
    const e = Array.from({ length: 20 }, (_, i) => user(`message-${String(i).padStart(2, "0")} ${"p".repeat(60)}`));
    const r = condenseTranscript(jsonl(e), { maxChars: 600 });
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 600, `length ${r.text.length}`);
    assert.match(lines(r)[0], /^\[.*omitted.*\]$/);
    assert.ok(r.text.includes("message-19"));
    assert.ok(!r.text.includes("message-00"));
    const kept = (r.text.match(/message-/g) || []).length;
    assert.match(lines(r)[0], new RegExp(`${20 - kept} `));
    assert.equal(r.entryCount, 20);
  });

  it("output within maxChars is not truncated", () => {
    const r = condenseTranscript(jsonl([user("hi")]), { maxChars: 600 });
    assert.equal(r.truncated, false);
    assert.doesNotMatch(r.text, /omitted/);
  });

  it("malformed lines are skipped without breaking the cursor or order", () => {
    const e1 = user("one");
    const e2 = assistant([text("two")]);
    const raw = [
      JSON.stringify(e1), "{not json", JSON.stringify({ type: "user", message: { content: "no uuid" } }),
      "42", "null", '"str"', "[1,2]", "", "   ", JSON.stringify(e2),
    ];
    for (const sep of ["\n", "\r\n"]) {
      const r = condenseTranscript(jsonl(raw, sep), { afterUuid: e1.uuid });
      assert.equal(r.text, "[2026-10-21 09:01] Claude: two");
      assert.equal(r.lastUuid, e2.uuid);
    }
  });

  it("first and last timestamps come from contributing entries only", () => {
    const e = [
      { type: "system", uuid: nextUuid(), timestamp: "2026-10-21T01:00:00.000Z" },
      user("a", { timestamp: "2026-10-21T02:00:00.000Z" }),
      assistant([text("b")], { timestamp: "2026-10-21T03:00:00.000Z" }),
      { type: "system", uuid: nextUuid(), timestamp: "2026-10-21T04:00:00.000Z" },
    ];
    const r = condenseTranscript(jsonl(e));
    assert.equal(r.firstTimestamp, "2026-10-21T02:00:00.000Z");
    assert.equal(r.lastTimestamp, "2026-10-21T03:00:00.000Z");
  });

  it("a 10 MB transcript with a 5 MB successful result condenses fast and leaves it out", () => {
    const big = "R".repeat(5 * 1024 * 1024);
    const filler = Array.from({ length: 2000 }, (_, i) => (i % 2 ? assistant([text("f".repeat(3000))]) : user("g".repeat(2000))));
    const entries = [user("start"), assistant([toolUse("Bash", { command: "cat big" })]), toolResult(big, false), ...filler];
    const input = jsonl(entries);
    assert.ok(input.length > 9 * 1024 * 1024);
    const t0 = Date.now();
    const r = condenseTranscript(input);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(!r.text.includes("RRRR"));
    assert.ok(r.text.length <= 40000);
    assert.equal(r.truncated, true);
  });
});
