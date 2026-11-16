import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CAPTURE_AGENT_RE,
  capturesDir,
  cursorPath,
  deltaPath,
  pruneCaptures,
  readCursor,
  safeId,
  startPoint,
  writeCursor,
} from "../hooks/capture-state.js";

const DAY = 24 * 60 * 60 * 1000;
const FRESH = { version: 1, transcript_path: null, committed: null };

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-state-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("capturesDir", () => {
  it("uses the plugin data directory, or the home fallback when it is unset, empty or unexpanded", () => {
    const home = path.join("/h", "me");
    const fallback = path.join(home, ".claude", "vault-pkm", "captures");
    const table = [
      [{ CLAUDE_PLUGIN_DATA: path.join("/data", "p") }, path.join("/data", "p", "captures")],
      [{}, fallback],
      [{ CLAUDE_PLUGIN_DATA: "" }, fallback],
      [{ CLAUDE_PLUGIN_DATA: "${CLAUDE_PLUGIN_DATA}" }, fallback],
    ];
    for (const [env, expected] of table) {
      assert.equal(capturesDir(env, home), expected, JSON.stringify(env));
    }
  });
});

describe("safeId", () => {
  it("accepts plain ids and rejects anything that could escape the directory or poison an object key", () => {
    const ok = ["3f2b8c1e-aaaa-4bbb-8ccc-123456789abc", "a1b2c3d4e5f6", "agent_1"];
    const bad = ["../x", "a/b", "a\\b", "", "__proto__", ".hidden", "-x", null, undefined, 42, {}, "a".repeat(129)];
    for (const id of ok) assert.equal(safeId(id), true, String(id));
    for (const id of bad) assert.equal(safeId(id), false, String(id));
  });

  it("refuses to build a path from an unsafe id", () => {
    assert.throws(() => cursorPath(dir, "../x"));
    assert.throws(() => deltaPath(dir, "s1", "a/b"));
    assert.equal(path.dirname(deltaPath(dir, "s1", "a1")), dir);
  });
});

describe("readCursor", () => {
  it("returns a fresh empty cursor for a missing file, corrupt JSON, another version or no committed key", async () => {
    const cases = {
      missing: null,
      corrupt: "{not json",
      version: JSON.stringify({ version: 2, transcript_path: "/t", committed: { uuid: "u", at: "x" } }),
      noCommitted: JSON.stringify({ version: 1, transcript_path: "/t" }),
      badCommitted: JSON.stringify({ version: 1, transcript_path: "/t", committed: { at: "x" } }),
    };
    for (const [name, body] of Object.entries(cases)) {
      const id = `s-${name}`;
      if (body !== null) await fs.writeFile(path.join(dir, `${id}.json`), body);
      assert.deepEqual(await readCursor(dir, id), FRESH, name);
    }
  });

  it("ignores a pending key left by an older layout", async () => {
    const committed = { uuid: "u1", at: "2026-10-21T09:00:00.000Z" };
    await fs.writeFile(
      path.join(dir, "s1.json"),
      JSON.stringify({ version: 1, transcript_path: "/t", committed, pending: { a1: { uuid: "u2", at: "x" } } }),
    );
    assert.deepEqual(await readCursor(dir, "s1"), { version: 1, transcript_path: "/t", committed });
  });
});

describe("writeCursor", () => {
  it("round-trips, creates the directory and leaves no temp file", async () => {
    const nested = path.join(dir, "a", "b");
    const cursor = { version: 1, transcript_path: "/t.jsonl", committed: { uuid: "u9", at: "2026-10-21T10:00:00.000Z" } };
    await writeCursor(nested, "s1", cursor);
    assert.deepEqual(await readCursor(nested, "s1"), cursor);
    assert.deepEqual(await fs.readdir(nested), ["s1.json"]);
  });

  it("keeps the file valid and equal to one writer's data under twenty concurrent writes", async () => {
    // Writers race on a last-rename-wins basis, so one update can be lost; the
    // worst case is that a range gets captured twice.
    const writes = Array.from({ length: 20 }, (_, i) =>
      writeCursor(dir, "s1", { version: 1, transcript_path: "/t", committed: { uuid: `u${i}`, at: "t" } }),
    );
    const results = await Promise.allSettled(writes);
    // Windows can fail a rename that races another rename with EPERM.
    assert.ok(results.some((r) => r.status === "fulfilled"));
    const read = await readCursor(dir, "s1");
    assert.match(read.committed.uuid, /^u\d+$/);
    assert.deepEqual(read, { version: 1, transcript_path: "/t", committed: { uuid: read.committed.uuid, at: "t" } });
    assert.deepEqual(await fs.readdir(dir), ["s1.json"]);
  });
});

describe("startPoint", () => {
  it("is the committed uuid, or null when nothing has been committed", () => {
    assert.equal(startPoint(FRESH), null);
    assert.equal(startPoint({ ...FRESH, committed: { uuid: "u7", at: "t" } }), "u7");
  });
});

describe("pruneCaptures", () => {
  async function touch(name, ageMs, now) {
    const p = path.join(dir, name);
    await fs.writeFile(p, "x");
    const t = new Date(now - ageMs);
    await fs.utimes(p, t, t);
  }

  it("deletes only expired cursor, delta and temp files and keeps everything else", async () => {
    const now = Date.now();
    await touch("old.json", 31 * DAY, now);
    await touch("new.json", 29 * DAY, now);
    await touch("old-a1.md", 8 * DAY, now);
    await touch("new-a1.md", 6 * DAY, now);
    await touch("old.json.123.abc.tmp", 8 * DAY, now);
    await touch("new.json.123.abc.tmp", 1 * DAY, now);
    await touch("notes.txt", 90 * DAY, now);
    await fs.mkdir(path.join(dir, "sub.json"));
    await pruneCaptures(dir, now);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["new-a1.md", "new.json", "new.json.123.abc.tmp", "notes.txt", "sub.json"]);
  });

  it("tolerates a missing directory", async () => {
    await assert.doesNotReject(pruneCaptures(path.join(dir, "absent"), Date.now()));
  });
});

describe("CAPTURE_AGENT_RE", () => {
  it("matches pkm-capture with or without a plugin prefix and nothing else", () => {
    for (const t of ["pkm-capture", "vault-pkm:pkm-capture"]) assert.equal(CAPTURE_AGENT_RE.test(t), true, t);
    for (const t of ["vault-explorer", "pkm-capture-helper", "general-purpose", "", "x:pkm-capture:y", "vault-pkm:pkm-capture\n"]) {
      assert.equal(CAPTURE_AGENT_RE.test(t), false, JSON.stringify(t));
    }
  });
});
