import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { openLocalIndex, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, SCHEMA_VERSION } from "../local-index.js";
import { cacheDir } from "../local-paths.js";

describe("openLocalIndex", () => {
  let tmp, vault, env, opened;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-local-index-"));
    vault = path.join(tmp, "vault");
    fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
    env = {
      platform: process.platform,
      homedir: path.join(tmp, "home"),
      XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
      LOCALAPPDATA: path.join(tmp, "local-app-data"),
    };
    opened = [];
  });

  afterEach(() => {
    for (const li of opened) { try { li.close(); } catch { /* already closed */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function open(extra = {}) {
    const li = openLocalIndex({ vaultPath: vault, env, ...extra });
    opened.push(li);
    return li;
  }

  const embeddingTables = (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('chunks','files','vec_chunks') ORDER BY name").all().map(r => r.name);

  it("creates the database in the cache folder, records its meta and writes nothing under .obsidian", () => {
    const li = open();
    const expected = path.join(cacheDir(vault, env), "index.db");
    assert.ok(fs.existsSync(expected), expected);
    assert.deepEqual(li.meta, { schemaVersion: SCHEMA_VERSION, model: EMBEDDING_MODEL, dims: EMBEDDING_DIMENSIONS });
    assert.equal(EMBEDDING_MODEL, "text-embedding-3-small");
    assert.equal(EMBEDDING_DIMENSIONS, 1536);
    assert.deepEqual(embeddingTables(li.db), ["chunks", "files", "vec_chunks"]);
    const cols = li.db.prepare("PRAGMA table_info(chunks)").all();
    const hashCol = cols.find(c => c.name === "chunk_hash");
    assert.ok(hashCol && hashCol.notnull === 1 && hashCol.type === "TEXT");
    assert.deepEqual(fs.readdirSync(path.join(vault, ".obsidian")), []);
  });

  it("holds pack vectors and the imported pack names, and indexes chunk hashes", () => {
    const li = open();
    const tables = li.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('pack_vectors','imported_packs') ORDER BY name").all().map(r => r.name);
    assert.deepEqual(tables, ["imported_packs", "pack_vectors"]);
    const idx = li.db.prepare("PRAGMA index_list(chunks)").all().map(r => r.name);
    assert.ok(idx.includes("idx_chunks_hash"), idx.join());
    li.db.prepare("INSERT INTO pack_vectors (hash, vector) VALUES ('h', x'00')").run();
    li.close();
    const next = open({ schemaVersion: SCHEMA_VERSION + 1 });
    assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM pack_vectors").get().n, 0);
  });

  it("honours a dbPath override", () => {
    const dbPath = path.join(tmp, "elsewhere", "x.db");
    const li = open({ dbPath });
    assert.ok(fs.existsSync(dbPath));
    assert.equal(li.dbPath, dbPath);
  });

  it("keeps its data when reopened with the same meta", () => {
    const li = open();
    li.db.prepare("INSERT INTO files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES ('a.md', 1, 'h', 0, 'now')").run();
    li.close();
    const again = open();
    assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
  });

  const mismatches = [
    { name: "model", change: { model: "other-model" } },
    { name: "dims", change: { dims: 768 } },
    { name: "schema version", change: { schemaVersion: SCHEMA_VERSION + 1 } },
  ];
  for (const m of mismatches) {
    it(`drops the embedding tables and records the new values when the ${m.name} differs`, () => {
      const li = open();
      li.db.exec("CREATE TABLE other_data (k TEXT); INSERT INTO other_data VALUES ('kept')");
      li.db.prepare("INSERT INTO files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES ('a.md', 1, 'h', 1, 'now')").run();
      li.db.prepare("INSERT INTO chunks (id, file_path, chunk_index, heading, content_preview, chunk_hash) VALUES (1, 'a.md', 0, NULL, 'p', 'ch')").run();
      li.close();

      const next = open(m.change);
      assert.deepEqual(next.meta, { schemaVersion: SCHEMA_VERSION, model: EMBEDDING_MODEL, dims: EMBEDDING_DIMENSIONS, ...m.change });
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 0);
      assert.equal(next.db.prepare("SELECT k FROM other_data").get().k, "kept");
      next.close();
      assert.deepEqual(open(m.change).meta, next.meta);
    });
  }

  it("never opens or modifies an old index inside the vault", () => {
    const old = path.join(vault, ".obsidian", "semantic-index.db");
    const oldStats = path.join(vault, ".obsidian", "semantic-stats.json");
    fs.writeFileSync(old, "not a database");
    fs.writeFileSync(oldStats, "{}");
    const before = [old, oldStats].map(p => [fs.readFileSync(p, "utf-8"), fs.statSync(p).mtimeMs]);
    open().close();
    const after = [old, oldStats].map(p => [fs.readFileSync(p, "utf-8"), fs.statSync(p).mtimeMs]);
    assert.deepEqual(after, before);
    assert.deepEqual(fs.readdirSync(path.join(vault, ".obsidian")).sort(), ["semantic-index.db", "semantic-stats.json"]);
  });
  it("opening an index whose schema is current writes nothing", () => {
    const first = open();
    const before = first.db.pragma("data_version", { simple: true });
    open();
    assert.equal(first.db.pragma("data_version", { simple: true }), before);
  });

  it("processes opening a missing index at the same moment all succeed", async () => {
    const moduleUrl = new URL("../local-index.js", import.meta.url).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(m => { m.openLocalIndex({ vaultPath: process.argv[1], dbPath: process.argv[2] }).close(); })`;
    const dbPath = path.join(tmp, "shared", "index.db");
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, vault, dbPath], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", d => { err += d; });
      child.on("close", code => resolve({ code, err }));
    });
    const results = await Promise.all(Array.from({ length: 4 }, run));
    assert.deepEqual(results.map(r => r.code), [0, 0, 0, 0], results.map(r => r.err).join("\n"));
    assert.deepEqual(embeddingTables(open({ dbPath }).db), ["chunks", "files", "vec_chunks"]);
  });
});

describe("link tables on upgrade", () => {
  it("adds the link tables to a version 3 index and keeps its vectors and keyword rows", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-links-up-"));
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    const dbPath = path.join(tmp, "index.db");
    try {
      const old = openLocalIndex({ vaultPath: vault, dbPath, schemaVersion: 3 });
      old.db.exec("DROP TABLE links; DROP TABLE link_files;");
      old.db.prepare("INSERT INTO files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES ('a.md', 1, 'h', 1, 'now')").run();
      old.db.prepare("INSERT INTO chunks (id, file_path, chunk_index, heading, content_preview, chunk_hash) VALUES (1, 'a.md', 0, NULL, 'p', 'ch')").run();
      old.db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)").run(1n, Buffer.from(new Float32Array(old.meta.dims).buffer));
      old.db.prepare("INSERT INTO keyword_docs (id, path, mtime_ms, size) VALUES (1, 'a.md', 1, 1)").run();
      old.db.prepare("INSERT INTO keyword_fts (rowid, text) VALUES (1, 'marmot')").run();
      old.close();

      const next = openLocalIndex({ vaultPath: vault, dbPath });
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM keyword_docs").get().n, 1);
      assert.equal(next.db.prepare("SELECT rowid FROM keyword_fts WHERE keyword_fts MATCH 'marmot'").all().length, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM links").get().n, 0);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM link_files").get().n, 0);
      assert.equal(next.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get().value, String(SCHEMA_VERSION));
      next.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
