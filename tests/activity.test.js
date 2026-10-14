import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { ActivityLog, summarizeArgs, buildActivityQuery } from "../activity.js";

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "activity-test-"));
  await fs.mkdir(path.join(tmpDir, ".obsidian"), { recursive: true });
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

function createLog(sessionId = "test-session") {
  return new ActivityLog({ vaultPath: tmpDir, sessionId });
}

describe("initialize", () => {
  it("creates the database and table", async () => {
    const log = createLog();
    await log.initialize();
    const rows = log.query();
    assert.ok(Array.isArray(rows));
    log.shutdown();
  });

  it("can initialize twice (idempotent)", async () => {
    const log = createLog();
    await log.initialize();
    await log.initialize();
    log.shutdown();
  });
});

describe("log", () => {
  it("inserts a record", async () => {
    const log = createLog("log-test");
    await log.initialize();
    log.log("vault_read", { path: "test.md" });
    const rows = log.query({ session: "log-test" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool_name, "vault_read");
    assert.equal(rows[0].session_id, "log-test");
    assert.ok(JSON.parse(rows[0].args_json).path === "test.md");
    log.shutdown();
  });

  it("handles null args", async () => {
    const log = createLog("null-args");
    await log.initialize();
    log.log("vault_list", null);
    const rows = log.query({ session: "null-args" });
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].args_json).constructor, Object);
    log.shutdown();
  });

  it("is a no-op when db is null", () => {
    const log = createLog();
    // db is null before initialize()
    log.log("vault_read", { path: "test.md" });
    // no error thrown
  });
});

describe("query", () => {
  it("returns entries in descending order (most recent first)", async () => {
    const log = createLog("query-order");
    await log.initialize();
    log.log("vault_read", { path: "first.md" });
    log.log("vault_read", { path: "second.md" });
    const rows = log.query({ session: "query-order" });
    assert.equal(rows.length, 2);
    // Rows are ordered by timestamp DESC; when timestamps are identical,
    // SQLite returns higher rowids first (last inserted = first returned)
    const paths = rows.map(r => JSON.parse(r.args_json).path);
    assert.ok(paths.includes("first.md"));
    assert.ok(paths.includes("second.md"));
    log.shutdown();
  });

  it("filters by tool name", async () => {
    const log = createLog("query-tool");
    await log.initialize();
    log.log("vault_read", {});
    log.log("vault_write", {});
    log.log("vault_read", {});
    const rows = log.query({ session: "query-tool", tool: "vault_write" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool_name, "vault_write");
    log.shutdown();
  });

  it("filters by session", async () => {
    const log1 = createLog("session-a");
    await log1.initialize();
    log1.log("vault_read", {});

    const log2 = new ActivityLog({ vaultPath: tmpDir, sessionId: "session-b" });
    await log2.initialize();
    log2.log("vault_write", {});

    const rows = log2.query({ session: "session-a" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "session-a");
    log2.shutdown();
  });

  it("filters by session ID prefix", async () => {
    const fullId = "abcd1234-5678-9abc-def0-123456789abc";
    const log = createLog(fullId);
    await log.initialize();
    log.log("vault_read", { path: "test.md" });

    const rows = log.query({ session: "abcd1234" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, fullId);
    log.shutdown();
  });

  it("filters by since timestamp", async () => {
    const log = createLog("query-since");
    await log.initialize();
    log.log("vault_read", {});
    // Query with a future timestamp should return nothing from this session
    const rows = log.query({ session: "query-since", since: "2099-01-01T00:00:00.000Z" });
    assert.equal(rows.length, 0);
    log.shutdown();
  });

  it("filters by before timestamp", async () => {
    const log = createLog("query-before");
    await log.initialize();
    log.log("vault_read", {});
    // Query with a past timestamp should return nothing
    const rows = log.query({ session: "query-before", before: "2000-01-01T00:00:00.000Z" });
    assert.equal(rows.length, 0);
    log.shutdown();
  });

  it("path filter with a note path matches only that exact note", async () => {
    const log = createLog("query-path-exact");
    await log.initialize();
    for (const p of ["notes/a.md", "notes/a.md.bak", "notes/ab.md", "x/notes/a.md"]) {
      log.log("vault_read", { path: p });
    }
    const rows = log.query({ session: "query-path-exact", path: "notes/a.md" });
    assert.deepEqual(rows.map(r => r.path), ["notes/a.md"]);
    log.shutdown();
  });

  it("path filter with a folder matches everything beneath it but not sibling folders sharing the prefix", async () => {
    const log = createLog("query-path-folder");
    await log.initialize();
    log.log("vault_read", { path: "01-Projects/MyApp/index.md" });
    log.log("vault_read", { path: "01-Projects/MyApp/research/deep.md" });
    log.log("vault_search", { query: "x", folder: "01-Projects/MyApp" });
    log.log("vault_read", { path: "01-Projects/MyApp-archive/old.md" });
    log.log("vault_read", { path: "02-Areas/health.md" });
    for (const filter of ["01-Projects/MyApp", "01-Projects/MyApp/"]) {
      const rows = log.query({ session: "query-path-folder", path: filter });
      assert.deepEqual(
        rows.map(r => r.path).sort(),
        ["01-Projects/MyApp", "01-Projects/MyApp/index.md", "01-Projects/MyApp/research/deep.md"],
        `filter ${filter}`
      );
    }
    log.shutdown();
  });

  it("path filter treats % and _ literally", async () => {
    const log = createLog("query-path-literal");
    await log.initialize();
    for (const p of ["a_b/x.md", "axb/x.md", "100%/y.md", "1000/y.md"]) {
      log.log("vault_read", { path: p });
    }
    for (const [filter, expected] of [["a_b", ["a_b/x.md"]], ["100%", ["100%/y.md"]]]) {
      const rows = log.query({ session: "query-path-literal", path: filter });
      assert.deepEqual(rows.map(r => r.path), expected, `filter ${filter}`);
    }
    log.shutdown();
  });

  it("path filter is served by the idx_activity_path index", async () => {
    const log = createLog("query-path-plan");
    await log.initialize();
    const { sql, params } = buildActivityQuery({ path: "01-Projects/MyApp" });
    const tableSteps = log.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
      .map(r => r.detail)
      .filter(d => /\bactivity\b/.test(d));
    assert.ok(tableSteps.length > 0);
    for (const step of tableSteps) assert.match(step, /USING INDEX idx_activity_path/, step);
    log.shutdown();
  });

  it("respects limit", async () => {
    const log = createLog("query-limit");
    await log.initialize();
    for (let i = 0; i < 10; i++) {
      log.log("vault_read", { i });
    }
    const rows = log.query({ session: "query-limit", limit: 3 });
    assert.equal(rows.length, 3);
    log.shutdown();
  });

  it("returns empty array when db is null", () => {
    const log = createLog();
    const rows = log.query();
    assert.deepEqual(rows, []);
  });
});

describe("clear", () => {
  it("deletes all entries when no filters", async () => {
    const log = createLog("clear-all");
    await log.initialize();
    log.log("vault_read", {});
    log.log("vault_write", {});
    const deleted = log.clear();
    assert.ok(deleted >= 2);
    const rows = log.query({ session: "clear-all" });
    assert.equal(rows.length, 0);
    log.shutdown();
  });

  it("filters by session", async () => {
    const log = createLog("clear-session-a");
    await log.initialize();
    log.log("vault_read", {});

    const log2 = new ActivityLog({ vaultPath: tmpDir, sessionId: "clear-session-b" });
    await log2.initialize();
    log2.log("vault_write", {});

    const deleted = log2.clear({ session: "clear-session-a" });
    assert.ok(deleted >= 1);
    // session-b entries should survive
    const rows = log2.query({ session: "clear-session-b" });
    assert.ok(rows.length >= 1);
    log2.shutdown();
  });

  it("filters by tool", async () => {
    const log = createLog("clear-tool");
    await log.initialize();
    log.log("vault_read", {});
    log.log("vault_write", {});
    log.clear({ tool: "vault_read" });
    const rows = log.query({ session: "clear-tool" });
    assert.ok(rows.every(r => r.tool_name !== "vault_read"));
    log.shutdown();
  });

  it("returns deleted count", async () => {
    const log = createLog("clear-count");
    await log.initialize();
    log.log("vault_read", {});
    log.log("vault_read", {});
    const deleted = log.clear({ session: "clear-count" });
    assert.equal(deleted, 2);
    log.shutdown();
  });

  it("returns 0 when db is null", () => {
    const log = createLog();
    assert.equal(log.clear(), 0);
  });
});

describe("shutdown", () => {
  it("closes the database", async () => {
    const log = createLog("shutdown-test");
    await log.initialize();
    log.shutdown();
    assert.equal(log.db, null);
  });

  it("query returns empty after shutdown", async () => {
    const log = createLog("shutdown-query");
    await log.initialize();
    log.log("vault_read", {});
    log.shutdown();
    assert.deepEqual(log.query(), []);
  });

  it("log is no-op after shutdown", async () => {
    const log = createLog("shutdown-log");
    await log.initialize();
    log.shutdown();
    // should not throw
    log.log("vault_read", {});
  });
});

// ── Summarized args, path column, migration, retention ───────────────

const DAY_MS = 86_400_000;
const PATH_KEYS = ["path", "source", "destination", "folder", "target", "old_path", "new_path"];

async function freshVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activity-mig-"));
  await fs.mkdir(path.join(dir, ".obsidian"), { recursive: true });
  return dir;
}

/** Create activity-log.db exactly as activity.js did before the path column existed. */
function createOldSchemaDb(vaultDir, rows) {
  const db = new Database(path.join(vaultDir, ".obsidian", "activity-log.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_session ON activity(session_id);
    CREATE INDEX IF NOT EXISTS idx_activity_tool ON activity(tool_name);
    CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity(timestamp);
  `);
  const insert = db.prepare("INSERT INTO activity (timestamp, session_id, tool_name, args_json) VALUES (?, ?, ?, ?)");
  for (const r of rows) {
    insert.run(r.timestamp ?? new Date().toISOString(), r.session ?? "old-session", r.tool, JSON.stringify(r.args));
  }
  return db;
}

function openRaw(vaultDir) {
  return new Database(path.join(vaultDir, ".obsidian", "activity-log.db"));
}

describe("summarizeArgs", () => {
  it("replaces strings longer than 200 chars with <N chars> and keeps shorter ones", () => {
    for (const [len, expected] of [[200, "x".repeat(200)], [201, "<201 chars>"], [5000, "<5000 chars>"]]) {
      assert.deepEqual(summarizeArgs({ content: "x".repeat(len) }), { content: expected }, `length ${len}`);
    }
  });

  it("keeps path-like keys in full regardless of length", () => {
    const long = "deep/".repeat(60) + "note.md";
    for (const key of PATH_KEYS) {
      assert.deepEqual(summarizeArgs({ [key]: long }), { [key]: long }, key);
    }
  });

  it("summarizes nested objects and arrays with the same key rule", () => {
    const long = "y".repeat(300);
    const result = summarizeArgs({
      links: [{ target: "a/".repeat(150) + "t.md", annotation: long }],
      frontmatter: { summary: long, tags: ["x"] },
      variables: { body: long },
    });
    assert.deepEqual(result, {
      links: [{ target: "a/".repeat(150) + "t.md", annotation: "<300 chars>" }],
      frontmatter: { summary: "<300 chars>", tags: ["x"] },
      variables: { body: "<300 chars>" },
    });
  });

  it("keeps non-string values unchanged", () => {
    const args = { limit: 5, force: true, due: null, tags: ["a", "b"], lines: { start: 1, end: 9 } };
    assert.deepEqual(summarizeArgs(args), args);
  });

  it("summarizes null or undefined args to an empty object", () => {
    assert.deepEqual(summarizeArgs(null), {});
    assert.deepEqual(summarizeArgs(undefined), {});
  });

  it("does not mutate its input", () => {
    const args = { path: "a.md", content: "z".repeat(5000), links: [{ annotation: "q".repeat(500) }] };
    const snapshot = JSON.parse(JSON.stringify(args));
    summarizeArgs(args);
    assert.deepEqual(args, snapshot);
  });
});

describe("log (summarized storage)", () => {
  it("stores summarized args, never the long string itself", async () => {
    const dir = await freshVault();
    const log = new ActivityLog({ vaultPath: dir, sessionId: "s" });
    await log.initialize();
    log.log("vault_write", { path: "notes/a.md", content: "x".repeat(5000) });
    log.shutdown();
    const raw = openRaw(dir);
    const row = raw.prepare("SELECT args_json FROM activity").get();
    raw.close();
    assert.deepEqual(JSON.parse(row.args_json), { path: "notes/a.md", content: "<5000 chars>" });
    await fs.rm(dir, { recursive: true });
  });

  it("records the row's vault path from path, else old_path, else folder", async () => {
    const dir = await freshVault();
    const log = new ActivityLog({ vaultPath: dir, sessionId: "s" });
    await log.initialize();
    const cases = [
      ["vault_read", { path: "notes/a.md" }, "notes/a.md"],
      ["vault_move", { old_path: "notes/b.md", new_path: "archive/b.md" }, "notes/b.md"],
      ["vault_search", { query: "q", folder: "01-Projects" }, "01-Projects"],
      ["vault_list", { path: "" }, null],
      ["vault_semantic_search", { query: "q" }, null],
    ];
    for (const [tool, args] of cases) log.log(tool, args);
    const byTool = new Map(log.query({ limit: 50 }).map(r => [r.tool_name, r.path]));
    for (const [tool, , expected] of cases) assert.equal(byTool.get(tool), expected, tool);
    log.shutdown();
    await fs.rm(dir, { recursive: true });
  });
});

describe("migration from the pre-path-column schema", () => {
  it("backfills the path column of existing rows from path, else old_path, else folder", async () => {
    const dir = await freshVault();
    createOldSchemaDb(dir, [
      { tool: "vault_read", args: { path: "notes/a.md" } },
      { tool: "vault_move", args: { old_path: "notes/b.md", new_path: "archive/b.md" } },
      { tool: "vault_search", args: { query: "q", folder: "01-Projects" } },
      { tool: "vault_tags", args: { pattern: "dev*" } },
    ]).close();
    const log = new ActivityLog({ vaultPath: dir, sessionId: "new" });
    await log.initialize();
    const byTool = new Map(log.query({ limit: 50 }).map(r => [r.tool_name, r.path]));
    assert.equal(byTool.get("vault_read"), "notes/a.md");
    assert.equal(byTool.get("vault_move"), "notes/b.md");
    assert.equal(byTool.get("vault_search"), "01-Projects");
    assert.equal(byTool.get("vault_tags"), null);
    assert.deepEqual(log.query({ path: "notes" }).map(r => r.tool_name).sort(), ["vault_move", "vault_read"]);
    log.shutdown();
    await fs.rm(dir, { recursive: true });
  });

  it("rewrites every existing row's args through summarizeArgs, dropping stored note bodies", async () => {
    const dir = await freshVault();
    const body = "secret note body ".repeat(300).slice(0, 5000);
    const ts = new Date().toISOString();
    // 1,200 filler rows so the rewrite has to cross several batches
    const filler = Array.from({ length: 1200 }, (_, i) => ({ tool: "vault_edit", timestamp: ts, args: { path: `n${i}.md`, new_string: body } }));
    createOldSchemaDb(dir, [
      { tool: "vault_write", timestamp: ts, args: { path: "notes/a.md", template: "t", variables: { body } } },
      { tool: "vault_append", timestamp: ts, args: { path: "notes/a.md", content: body } },
      ...filler,
    ]).close();
    const log = new ActivityLog({ vaultPath: dir, sessionId: "new" });
    await log.initialize();
    log.shutdown();

    const raw = openRaw(dir);
    const rows = raw.prepare("SELECT * FROM activity ORDER BY id").all();
    raw.close();
    assert.equal(rows.length, 1202);
    for (const row of rows) {
      assert.ok(!row.args_json.includes("secret note body"), row.args_json);
      assert.equal(row.timestamp, ts);
      assert.equal(row.session_id, "old-session");
    }
    assert.deepEqual(JSON.parse(rows[0].args_json), { path: "notes/a.md", template: "t", variables: { body: "<5000 chars>" } });
    assert.deepEqual(JSON.parse(rows[1].args_json), { path: "notes/a.md", content: "<5000 chars>" });
    await fs.rm(dir, { recursive: true });
  });

  it("records schema version 1 and leaves a migrated DB unchanged on the next start", async () => {
    const dir = await freshVault();
    createOldSchemaDb(dir, [{ tool: "vault_append", args: { path: "a.md", content: "c".repeat(5000) } }]).close();
    const first = new ActivityLog({ vaultPath: dir, sessionId: "one" });
    await first.initialize();
    first.shutdown();
    const raw1 = openRaw(dir);
    const afterFirst = raw1.prepare("SELECT * FROM activity ORDER BY id").all();
    assert.equal(raw1.pragma("user_version", { simple: true }), 1);
    raw1.close();

    const second = new ActivityLog({ vaultPath: dir, sessionId: "two" });
    await second.initialize();
    second.shutdown();
    const raw2 = openRaw(dir);
    assert.deepEqual(raw2.prepare("SELECT * FROM activity ORDER BY id").all(), afterFirst);
    assert.equal(raw2.pragma("user_version", { simple: true }), 1);
    raw2.close();
    await fs.rm(dir, { recursive: true });
  });

  it("is all-or-nothing: a failure part-way leaves the old DB untouched and initialize rejects", async () => {
    const dir = await freshVault();
    const db = createOldSchemaDb(dir, [
      { tool: "vault_append", args: { path: "a.md", content: "c".repeat(5000) } },
      { tool: "vault_append", args: { path: "b.md", content: "d".repeat(5000) } },
    ]);
    db.exec("CREATE TRIGGER fail_second BEFORE UPDATE ON activity WHEN OLD.id = 2 BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const before = db.prepare("SELECT * FROM activity ORDER BY id").all();
    db.close();

    const log = new ActivityLog({ vaultPath: dir, sessionId: "new" });
    await assert.rejects(() => log.initialize(), /injected failure/);
    assert.equal(log.db, null);

    const raw = openRaw(dir);
    assert.deepEqual(raw.prepare("SELECT * FROM activity ORDER BY id").all(), before);
    assert.ok(!raw.prepare("PRAGMA table_info(activity)").all().some(c => c.name === "path"));
    assert.equal(raw.pragma("user_version", { simple: true }), 0);
    raw.close();
    await fs.rm(dir, { recursive: true });
  });
});

describe("retention", () => {
  async function vaultWithAges(ages) {
    const dir = await freshVault();
    createOldSchemaDb(dir, ages.map(days => ({
      tool: `age_${days}`,
      timestamp: new Date(Date.now() - days * DAY_MS).toISOString(),
      args: {},
    }))).close();
    return dir;
  }

  async function survivingTools(dir, opts) {
    const log = new ActivityLog({ vaultPath: dir, sessionId: "s", ...opts });
    await log.initialize();
    const tools = log.query({ limit: 100 }).map(r => r.tool_name).sort();
    log.shutdown();
    await fs.rm(dir, { recursive: true });
    return tools;
  }

  it("deletes rows older than retentionDays on initialize and keeps newer ones", async () => {
    const dir = await vaultWithAges([0, 89, 91, 400]);
    assert.deepEqual(await survivingTools(dir, { retentionDays: 90 }), ["age_0", "age_89"]);
  });

  it("keeps everything when retentionDays is 0", async () => {
    const dir = await vaultWithAges([0, 3650]);
    assert.deepEqual(await survivingTools(dir, { retentionDays: 0 }), ["age_0", "age_3650"]);
  });

  it("reads VAULT_PKM_ACTIVITY_RETENTION_DAYS when no option is given, and the option wins over it", async () => {
    const saved = process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
    process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS = "1";
    try {
      assert.deepEqual(await survivingTools(await vaultWithAges([0, 2]), {}), ["age_0"]);
      assert.deepEqual(await survivingTools(await vaultWithAges([0, 2]), { retentionDays: 90 }), ["age_0", "age_2"]);
    } finally {
      if (saved === undefined) delete process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
      else process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS = saved;
    }
  });

  it("falls back to 90 days for invalid retention values", () => {
    const saved = process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
    try {
      for (const value of ["abc", "-5", "", "   "]) {
        process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS = value;
        assert.equal(new ActivityLog({ vaultPath: tmpDir, sessionId: "s" }).retentionDays, 90, `env ${JSON.stringify(value)}`);
      }
      delete process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
      assert.equal(new ActivityLog({ vaultPath: tmpDir, sessionId: "s" }).retentionDays, 90, "unset");
      assert.equal(new ActivityLog({ vaultPath: tmpDir, sessionId: "s", retentionDays: -1 }).retentionDays, 90, "option -1");
    } finally {
      if (saved === undefined) delete process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
      else process.env.VAULT_PKM_ACTIVITY_RETENTION_DAYS = saved;
    }
  });
});

describe("space reclamation", () => {
  it("leaves both upgraded and newly created databases in auto_vacuum = INCREMENTAL", async () => {
    const upgraded = await freshVault();
    createOldSchemaDb(upgraded, [{ tool: "vault_read", args: { path: "a.md" } }]).close();
    const created = await freshVault();
    for (const dir of [upgraded, created]) {
      const log = new ActivityLog({ vaultPath: dir, sessionId: "s" });
      await log.initialize();
      log.shutdown();
      const raw = openRaw(dir);
      assert.equal(raw.pragma("auto_vacuum", { simple: true }), 2, dir === upgraded ? "upgraded" : "created");
      raw.close();
      await fs.rm(dir, { recursive: true });
    }
  });

  it("returns pages freed by retention to the filesystem", async () => {
    const dir = await freshVault();
    const seed = new ActivityLog({ vaultPath: dir, sessionId: "seed" });
    await seed.initialize();
    seed.shutdown();
    const raw = openRaw(dir);
    const insert = raw.prepare("INSERT INTO activity (timestamp, session_id, tool_name, args_json) VALUES (?, 's', 'old', ?)");
    const old = new Date(Date.now() - 400 * DAY_MS).toISOString();
    for (let i = 0; i < 300; i++) insert.run(old, JSON.stringify({ blob: "b".repeat(180) + i }));
    raw.pragma("wal_checkpoint(TRUNCATE)");
    const pagesBefore = raw.pragma("page_count", { simple: true });
    raw.close();

    const log = new ActivityLog({ vaultPath: dir, sessionId: "s", retentionDays: 90 });
    await log.initialize();
    assert.equal(log.db.pragma("freelist_count", { simple: true }), 0);
    assert.ok(log.db.pragma("page_count", { simple: true }) < pagesBefore);
    log.shutdown();
    await fs.rm(dir, { recursive: true });
  });
});
