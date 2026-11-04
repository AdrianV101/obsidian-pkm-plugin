import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { KeywordIndex, toMatchExpression } from "../keyword-index.js";
import { openLocalIndex, SCHEMA_VERSION } from "../local-index.js";
import { HousekeeperLease } from "../lease.js";

describe("keyword index", () => {
  let tmp, vault, opened, leases;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-keyword-"));
    vault = path.join(tmp, "vault");
    fs.mkdirSync(vault, { recursive: true });
    opened = [];
    leases = [];
  });

  afterEach(async () => {
    for (const k of opened) await k.shutdown();
    for (const l of leases) await l.release();
    for (const li of opened.map(k => k.localIndex)) { try { li.close(); } catch { /* closed */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel, text) => {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };

  const holder = { isHolder: true, onAcquired() {}, onLost() {} };
  const reader = { isHolder: false, onAcquired() {}, onLost() {} };

  function make({ lease = holder, dbPath = path.join(tmp, "index.db"), ...rest } = {}) {
    const localIndex = openLocalIndex({ vaultPath: vault, dbPath });
    const k = new KeywordIndex({ localIndex, vaultPath: vault, lease, debounceMs: 0, ...rest });
    k.localIndex = localIndex;
    opened.push(k);
    return k;
  }

  const paths = (k, q, o) => k.keywordSearch(q, o).map(r => r.path);

  it("F1: builds rows for every note on start without an API key and without any request", async () => {
    write("a.md", "alpha apple");
    write("sub/b.md", "beta banana");
    write(".obsidian/hidden.md", "apple secret");
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = () => { requests++; throw new Error("no requests expected"); };
    try {
      const k = make();
      k.start();
      await k.whenSynced();
      assert.deepEqual(paths(k, "apple").sort(), ["a.md"]);
      assert.deepEqual(paths(k, "banana"), ["sub/b.md"]);
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("F1: a server started without a key opens the local index and fills the keyword rows", async () => {
    write("a.md", "alpha zebra");
    const roots = {
      HOME: tmp, USERPROFILE: tmp, XDG_CACHE_HOME: path.join(tmp, "cache"),
      XDG_STATE_HOME: path.join(tmp, "state"), LOCALAPPDATA: path.join(tmp, "lad"),
    };
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "cli.js")], {
      env: { PATH: process.env.PATH, ...roots, VAULT_PATH: vault },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    try {
      const dbFile = path.join(roots.XDG_CACHE_HOME, "vault-pkm");
      let rows = 0;
      for (let i = 0; i < 100 && rows === 0; i++) {
        await new Promise(r => setTimeout(r, 50));
        const found = fs.existsSync(dbFile) ? fs.readdirSync(dbFile).map(d => path.join(dbFile, d, "index.db")).find(f => fs.existsSync(f)) : null;
        if (!found) continue;
        const db = new Database(found, { readonly: true });
        try { rows = db.prepare("SELECT COUNT(*) AS n FROM keyword_docs").get().n; } catch { /* not ready */ } finally { db.close(); }
      }
      assert.equal(rows, 1, stderr);
      assert.ok(!/semantic search enabled|disabled since/.test(stderr), stderr);
    } finally {
      child.kill("SIGTERM");
      await new Promise(r => child.once("close", r));
    }
  });

  it("F2: creating, editing, moving and trashing a note updates its rows", async () => {
    const k = make();
    await k.sync();
    write("n.md", "first quokka");
    await k.refresh("n.md");
    assert.deepEqual(paths(k, "quokka"), ["n.md"]);

    write("n.md", "now wombat instead and a longer body");
    await k.refresh("n.md");
    assert.deepEqual(paths(k, "quokka"), []);
    assert.deepEqual(paths(k, "wombat"), ["n.md"]);

    fs.mkdirSync(path.join(vault, "moved"));
    fs.renameSync(path.join(vault, "n.md"), path.join(vault, "moved", "m.md"));
    await k.refresh("n.md");
    await k.refresh("moved/m.md");
    assert.deepEqual(paths(k, "wombat"), ["moved/m.md"]);

    fs.mkdirSync(path.join(vault, ".trash"));
    fs.renameSync(path.join(vault, "moved", "m.md"), path.join(vault, ".trash", "m.md"));
    await k.refresh("moved/m.md");
    assert.deepEqual(paths(k, "wombat"), []);
    assert.equal(k.db.prepare("SELECT COUNT(*) AS n FROM keyword_docs").get().n, 0);
  });

  it("F2: moving or deleting a folder reconciles the notes under it", async () => {
    write("dir/a.md", "kiwi");
    write("dir/deep/b.md", "kiwi");
    const k = make();
    await k.sync();
    fs.renameSync(path.join(vault, "dir"), path.join(vault, "dir2"));
    await k.refresh("dir");
    await k.refresh("dir2");
    assert.deepEqual(paths(k, "kiwi").sort(), ["dir2/a.md", "dir2/deep/b.md"]);
    fs.rmSync(path.join(vault, "dir2"), { recursive: true });
    await k.refresh("dir2");
    assert.deepEqual(paths(k, "kiwi"), []);
  });

  it("F2: watcher events drive the same updates", async () => {
    const watcher = new EventEmitter();
    watcher.close = () => {};
    let emit;
    const k = make({ watch: (_dir, _opts, cb) => { emit = cb; return watcher; } });
    k.start();
    await k.whenSynced();
    write("w.md", "okapi");
    emit("rename", "w.md");
    emit("change", ".obsidian/x.md");
    await k.whenIdle();
    assert.deepEqual(paths(k, "okapi"), ["w.md"]);
  });

  it("a note edited while no watcher ran is caught by the next sync", async () => {
    write("a.md", "heron");
    const k = make();
    await k.sync();
    write("a.md", "egret plus more words");
    write("b.md", "heron");
    fs.rmSync(path.join(vault, "a.md"));
    write("a.md", "egret plus more words");
    const r = await k.sync();
    assert.equal(r.indexed, 2);
    assert.deepEqual(paths(k, "egret"), ["a.md"]);
    assert.deepEqual(paths(k, "heron"), ["b.md"]);
  });

  it("a non-holder never writes rows but can search the holder's rows", async () => {
    write("a.md", "lynx");
    const dbPath = path.join(tmp, "shared.db");
    const h = make({ dbPath });
    await h.sync();
    const r = make({ dbPath, lease: reader });
    write("b.md", "lynx");
    assert.equal(await r.sync(), null);
    await r.refresh("b.md");
    r.start();
    assert.deepEqual(paths(r, "lynx"), ["a.md"]);
    assert.equal(r.watcher, null);
  });

  it("starts housekeeping when the lease is acquired later and stops when it is lost", async () => {
    write("a.md", "ibex");
    const handlers = {};
    const lease = { isHolder: false, onAcquired: f => { handlers.acquired = f; }, onLost: f => { handlers.lost = f; } };
    let watching = 0;
    const k = make({ lease, watch: () => { watching++; const w = new EventEmitter(); w.close = () => { watching--; }; return w; } });
    k.start();
    assert.equal(watching, 0);
    lease.isHolder = true;
    handlers.acquired();
    await k.whenSynced();
    assert.equal(watching, 1);
    assert.deepEqual(paths(k, "ibex"), ["a.md"]);
    lease.isHolder = false;
    handlers.lost();
    assert.equal(watching, 0);
  });

  describe("F3: keywordSearch", () => {
    beforeEach(() => {
      write("one.md", "the cat sat on the mat with a hat");
      write("two.md", "a dog and a cat");
      write("proj/three.md", "unrelated: cat food");
      write("emoji.md", "party time here");
    });

    const queries = [
      'say "hello', "-minus cat", "field:cat", "cat*", "cat AND dog", "NEAR(cat dog)", "(cat", "cat)", "cat OR", "NOT cat",
      "'quoted' cat", "cat \u{1F600}", "^cat", "cat ~ dog", "\"\"", "{cat}", "col:\"x\" cat", "a.b/c\\d",
    ];
    for (const q of queries) {
      it(`does not throw on ${JSON.stringify(q)} and still matches the plain words`, async () => {
        const k = make();
        await k.sync();
        const got = paths(k, q);
        if (/cat/.test(q)) assert.ok(got.includes("two.md"), `${q} -> ${got}`);
      });
    }

    it("returns [] for empty, whitespace and punctuation-only queries", async () => {
      const k = make();
      await k.sync();
      for (const q of ["", "   ", "!!! --- ***", "\u{1F600}", null, undefined]) assert.deepEqual(k.keywordSearch(q), []);
    });

    it("ranks notes matching more words first, limits and scopes by folder", async () => {
      const k = make();
      await k.sync();
      const all = k.keywordSearch("cat dog");
      assert.equal(all[0].path, "two.md");
      assert.deepEqual(all.map(r => r.rank), all.map((_, i) => i + 1));
      assert.equal(k.keywordSearch("cat", { limit: 1 }).length, 1);
      assert.deepEqual(paths(k, "cat", { folder: "proj" }), ["proj/three.md"]);
      assert.deepEqual(paths(k, "cat", { folder: "proj/" }), ["proj/three.md"]);
      assert.deepEqual(paths(k, "cat", { folder: "pro" }), []);
    });

    it("matches words in the file name and ignores accents and case", async () => {
      write("Café Notes.md", "nothing");
      const k = make();
      await k.sync();
      assert.deepEqual(paths(k, "CAFE"), ["Café Notes.md"]);
    });
  });

  it("toMatchExpression quotes every word", () => {
    assert.equal(toMatchExpression("cat AND dog"), '"cat" OR "AND" OR "dog"');
    assert.equal(toMatchExpression("--"), null);
  });

  it("F4: indexes 2,500 notes of 15,000 characters in under 5 seconds", async () => {
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    for (let i = 0; i < 2500; i++) {
      let body = "";
      for (let j = 0; body.length < 15000; j++) body += words[(i + j) % words.length] + j + " ";
      write(`bulk/${i % 25}/n${i}.md`, body.slice(0, 15000));
    }
    const k = make();
    const t0 = Date.now();
    const r = await k.sync();
    const ms = Date.now() - t0;
    assert.equal(r.indexed, 2500);
    assert.ok(ms < 5000, `${ms} ms`);
    assert.ok(k.keywordSearch("alpha0").length > 0);
  });
});

describe("local index schema upgrade", () => {
  it("keeps stored vectors when upgrading from the previous schema version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-keyword-up-"));
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    const dbPath = path.join(tmp, "index.db");
    try {
      const old = openLocalIndex({ vaultPath: vault, dbPath, schemaVersion: SCHEMA_VERSION - 1 });
      old.db.exec("DROP TABLE keyword_docs; DROP TABLE keyword_fts;");
      old.db.prepare("INSERT INTO files (path, mtime_ms, content_hash, chunk_count, updated_at) VALUES ('a.md', 1, 'h', 1, 'now')").run();
      old.db.prepare("INSERT INTO chunks (id, file_path, chunk_index, heading, content_preview, chunk_hash) VALUES (1, 'a.md', 0, NULL, 'p', 'ch')").run();
      old.db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)").run(1n, Buffer.from(new Float32Array(old.meta.dims).buffer));
      old.db.prepare("INSERT INTO pack_vectors (hash, vector) VALUES ('x', x'00')").run();
      old.db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(SCHEMA_VERSION - 1));
      old.close();

      const next = openLocalIndex({ vaultPath: vault, dbPath });
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM pack_vectors").get().n, 1);
      assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM keyword_docs").get().n, 0);
      assert.equal(next.db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get().value, String(SCHEMA_VERSION));
      next.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("keyword index with the real lease", () => {
  it("the holder indexes through the lease callbacks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-keyword-lease-"));
    const vault = path.join(tmp, "vault");
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, "a.md"), "marmot");
    const lease = new HousekeeperLease({ stateDir: path.join(tmp, "state"), heartbeatMs: 60000 });
    fs.mkdirSync(path.join(tmp, "state"));
    const li = openLocalIndex({ vaultPath: vault, dbPath: path.join(tmp, "i.db") });
    const k = new KeywordIndex({ localIndex: li, vaultPath: vault, lease, debounceMs: 0 });
    try {
      await lease.tryAcquire();
      await k.whenSynced();
      assert.deepEqual(k.keywordSearch("marmot").map(r => r.path), ["a.md"]);
    } finally {
      await k.shutdown();
      await lease.release();
      li.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

