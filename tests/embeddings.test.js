import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import {
  SemanticIndex,
  contentHash,
  callEmbeddingAPI,
  classifyEmbeddingError,
  EmbeddingError,
} from "../embeddings.js";
import { openLocalIndex } from "../local-index.js";
import { vaultKey } from "../local-paths.js";
import {
  DIMS,
  QUOTA_BODY,
  embeddingsResponse,
  errorResponse,
  installFakeOpenAI,
  recordingSleep,
  quotaResponse,
  makeVault,
  manyNotes,
  holderLease,
} from "./fake-openai.js";
import { HousekeeperLease } from "../lease.js";
import { formatCoverageLine } from "../semantic-health.js";

const { Response, Headers } = globalThis;

// Every index in this file lives under one temp folder, never the real cache or state folders.
const LOCAL_ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), "pkm-embeddings-local-"));
const openedIndexes = [];
const sidecarDir = (vaultPath) => path.join(LOCAL_ROOT, vaultKey(vaultPath));
const statsFile = (vaultPath) => path.join(sidecarDir(vaultPath), "semantic-stats.json");

function newIndex({ vaultPath, dbPath, lease = holderLease(), ...rest }) {
  const localIndex = openLocalIndex({ vaultPath, dbPath: dbPath ?? path.join(sidecarDir(vaultPath), "index.db") });
  openedIndexes.push(localIndex);
  return new SemanticIndex({ vaultPath, localIndex, lease, statsPath: statsFile(vaultPath), ...rest });
}

afterEach(() => {
  for (const li of openedIndexes.splice(0)) li.close();
});

after(() => {
  fsSync.rmSync(LOCAL_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// contentHash(content)
// ---------------------------------------------------------------------------
describe("contentHash", () => {
  it("same input produces same output", () => {
    const hash1 = contentHash("hello world");
    const hash2 = contentHash("hello world");
    assert.equal(hash1, hash2);
  });

  it("different inputs produce different outputs", () => {
    const hash1 = contentHash("hello");
    const hash2 = contentHash("world");
    assert.notEqual(hash1, hash2);
  });

  it("returns a hex string", () => {
    const hash = contentHash("test content");
    assert.match(hash, /^[a-f0-9]+$/);
  });

  it("returns a 64-character SHA-256 hex digest", () => {
    const hash = contentHash("anything");
    assert.equal(hash.length, 64);
  });
});

// ---------------------------------------------------------------------------
// classifyEmbeddingError(status, bodyText, headers, now)
// ---------------------------------------------------------------------------
describe("classifyEmbeddingError", () => {
  const kindCases = [
    { name: "401", status: 401, body: "{\"error\":{\"code\":\"invalid_api_key\"}}", kind: "auth" },
    { name: "403", status: 403, body: "", kind: "auth" },
    { name: "429 insufficient_quota (live body)", status: 429, body: QUOTA_BODY, kind: "quota" },
    { name: "429 rate limit", status: 429, body: "{\"error\":{\"code\":\"rate_limit_exceeded\"}}", kind: "rate_limit" },
    { name: "500", status: 500, body: "", kind: "transient" },
    { name: "503", status: 503, body: "busy", kind: "transient" },
    { name: "network failure (status null)", status: null, body: "fetch failed", kind: "transient" },
    { name: "400 context length", status: 400, body: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens", kind: "too_large" },
    { name: "400 tokens per request", status: 400, body: "Requested 310000 tokens, max 300000 tokens per request", kind: "too_large" },
    { name: "400 other", status: 400, body: "'input' is invalid", kind: "other" },
    { name: "404", status: 404, body: "Not found", kind: "other" },
  ];
  for (const c of kindCases) {
    it(`classifies ${c.name} as ${c.kind}`, () => {
      assert.equal(classifyEmbeddingError(c.status, c.body, new Headers()).kind, c.kind);
    });
  }

  const now = Date.parse("2026-07-03T12:00:00Z");
  const delayCases = [
    { name: "Retry-After seconds", headers: { "retry-after": "2" }, ms: 2000 },
    { name: "Retry-After HTTP-date", headers: { "retry-after": new Date(now + 5000).toUTCString() }, ms: 5000 },
    { name: "Retry-After HTTP-date in the past", headers: { "retry-after": new Date(now - 60000).toUTCString() }, ms: 0 },
    { name: "x-ratelimit-reset-* (longest wins)", headers: { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" }, ms: 360000 },
    { name: "x-ratelimit-reset-tokens in ms", headers: { "x-ratelimit-reset-tokens": "250ms" }, ms: 250 },
    { name: "Retry-After preferred over reset headers", headers: { "retry-after": "3", "x-ratelimit-reset-tokens": "6m0s" }, ms: 3000 },
    { name: "unparseable values", headers: { "retry-after": "soon", "x-ratelimit-reset-tokens": "later" }, ms: null },
    { name: "no headers", headers: {}, ms: null },
  ];
  for (const c of delayCases) {
    it(`rate_limit delay from ${c.name}`, () => {
      const result = classifyEmbeddingError(429, "{}", new Headers(c.headers), now);
      assert.equal(result.kind, "rate_limit");
      assert.equal(result.retryAfterMs, c.ms);
    });
  }
});

// ---------------------------------------------------------------------------
// callEmbeddingAPI(texts, apiKey, { maxAttempts, sleep })
// ---------------------------------------------------------------------------
describe("callEmbeddingAPI", () => {
  let fake;

  afterEach(() => {
    fake?.restore();
    fake = null;
  });

  it("returns embeddings on success", async () => {
    fake = installFakeOpenAI(() => Response.json({
      data: [
        { index: 1, embedding: [0.4, 0.5] },
        { index: 0, embedding: [0.1, 0.2] },
      ],
    }));
    const result = await callEmbeddingAPI(["text1", "text2"], "test-key");
    assert.deepStrictEqual(result, [[0.1, 0.2], [0.4, 0.5]], "should sort by index");
  });

  const retryable = [
    { name: "rate_limit with Retry-After", fail: () => errorResponse(429, "{}", { "retry-after": "2" }), delays: [2000] },
    { name: "rate_limit without reset headers", fail: () => errorResponse(429, "{}"), delays: [1000] },
    { name: "transient 503", fail: () => errorResponse(503, "busy"), delays: [1000] },
    { name: "network failure", fail: () => { throw new TypeError("fetch failed"); }, delays: [1000] },
  ];
  for (const c of retryable) {
    it(`retries ${c.name} after the classified delay, then succeeds`, async () => {
      fake = installFakeOpenAI((inputs, n) => (n === 1 ? c.fail() : embeddingsResponse(inputs)));
      const { delays, sleep } = recordingSleep();
      const result = await callEmbeddingAPI(["a"], "test-key", { sleep });
      assert.equal(fake.calls.length, 2);
      assert.deepEqual(delays, c.delays);
      assert.equal(result.length, 1);
    });
  }

  it("gives up after 3 attempts with exponential backoff and throws the classified error", async () => {
    fake = installFakeOpenAI(() => errorResponse(503, "busy"));
    const { delays, sleep } = recordingSleep();
    await assert.rejects(
      () => callEmbeddingAPI(["a"], "test-key", { sleep }),
      (err) => err instanceof EmbeddingError && err.kind === "transient" && err.status === 503
    );
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  const fatal = [
    { status: 401, body: "{\"error\":{\"code\":\"invalid_api_key\"}}", kind: "auth" },
    { status: 429, body: QUOTA_BODY, kind: "quota" },
    { status: 400, body: "This model's maximum context length is 8192 tokens", kind: "too_large" },
    { status: 404, body: "Not found", kind: "other" },
  ];
  for (const c of fatal) {
    it(`does not retry ${c.kind} (${c.status})`, async () => {
      fake = installFakeOpenAI(() => errorResponse(c.status, c.body));
      const { delays, sleep } = recordingSleep();
      await assert.rejects(
        () => callEmbeddingAPI(["a"], "test-key", { sleep }),
        (err) => err instanceof EmbeddingError && err.kind === c.kind && err.status === c.status
      );
      assert.equal(fake.calls.length, 1);
      assert.deepEqual(delays, []);
    });
  }

  it("does not wait for a rate-limit reset longer than 30 s", async () => {
    fake = installFakeOpenAI(() => errorResponse(429, "{}", { "retry-after": "120" }));
    const { delays, sleep } = recordingSleep();
    await assert.rejects(
      () => callEmbeddingAPI(["a"], "test-key", { sleep }),
      (err) => err.kind === "rate_limit" && err.retryAfterMs === 120000
    );
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(delays, []);
  });

  it("error message carries the status and at most 200 chars of the body", async () => {
    fake = installFakeOpenAI(() => errorResponse(404, "x".repeat(500)));
    await assert.rejects(
      () => callEmbeddingAPI(["a"], "test-key"),
      (err) => err.message === `OpenAI API error (404): ${"x".repeat(200)}`
    );
  });
});

// ---------------------------------------------------------------------------
// SemanticIndex class (integration tests with real SQLite + mocked fetch)
// ---------------------------------------------------------------------------
describe("SemanticIndex class", () => {
  let tmpDir;
  let originalFetch;
  let fetchCallCount;

  /** Generate a deterministic fake embedding vector for a given seed string. */
  function fakeEmbedding(seed) {
    const vec = new Array(DIMS).fill(0);
    for (let i = 0; i < Math.min(seed.length, DIMS); i++) {
      vec[i] = (seed.charCodeAt(i % seed.length) % 100) / 100;
    }
    return vec;
  }

  /**
   * Mock fetch that returns fake OpenAI embedding responses.
   * Each input text gets a deterministic embedding based on the text content.
   */
  function mockFetch(url, opts) {
    fetchCallCount++;
    const body = JSON.parse(opts.body);
    const data = body.input.map((text, index) => ({
      index,
      embedding: fakeEmbedding(text),
    }));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data }),
    });
  }

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-test-"));

    // Create vault structure with some markdown files
    const notesDir = path.join(tmpDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });

    await fs.writeFile(path.join(notesDir, "note-a.md"), `---
type: research
created: 2026-01-01
tags:
  - test
---
# Note A

This note discusses machine learning and neural networks.
`);

    await fs.writeFile(path.join(notesDir, "note-b.md"), `---
type: research
created: 2026-01-01
tags:
  - test
---
# Note B

This note covers database optimization and SQL queries.
`);

    await fs.writeFile(path.join(notesDir, "note-c.md"), `---
type: research
created: 2026-01-01
tags:
  - test
---
# Note C

A note about project management and agile methodology.
`);

    // Save and replace global fetch
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Restore fetch after each test in case a test forgot
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(tmpDir, { recursive: true });
  });

  it("initialize() creates DB with expected tables", async () => {
    globalThis.fetch = mockFetch;
    fetchCallCount = 0;

    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-init.db"),
    });
    await idx.initialize();

    assert.ok(idx.db, "DB should be open");
    assert.ok(idx.isAvailable, "isAvailable should be true");

    // Check that tables exist by querying them
    const chunks = idx.db.prepare("SELECT count(*) as n FROM chunks").get();
    assert.equal(typeof chunks.n, "number");

    const files = idx.db.prepare("SELECT count(*) as n FROM files").get();
    assert.equal(typeof files.n, "number");

    await idx.shutdown();
    assert.equal(idx.db, null, "DB should be null after shutdown");
  });

  it("initialize() writes semantic-stats.json with expected fields", async () => {
    globalThis.fetch = mockFetch;
    fetchCallCount = 0;

    const dbPath = path.join(tmpDir, "test-stats.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();

    const statsPath = statsFile(tmpDir);
    const raw = await fs.readFile(statsPath, "utf-8");
    const stats = JSON.parse(raw);
    assert.equal(typeof stats.indexed_files, "number");
    assert.equal(typeof stats.total_chunks, "number");
    assert.equal(typeof stats.vault_files, "number");
    assert.equal(stats.indexed_files, 0);
    assert.equal(stats.total_chunks, 0);

    await idx.shutdown();
  });

  it("_writeStats() is a no-op when db is null", () => {
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-stats-noop.db"),
    });
    // db is null (not initialized)
    idx._writeStats(); // should not throw
  });

  it("isAvailable is false without API key", async () => {
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "",
      dbPath: path.join(tmpDir, "test-nokey.db"),
    });
    await idx.initialize();
    assert.ok(!idx.isAvailable, "isAvailable should be false without API key");
    await idx.shutdown();
  });

  it("reindexFile() stores chunks and file metadata", async () => {
    globalThis.fetch = mockFetch;
    fetchCallCount = 0;

    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-reindex.db"),
    });
    await idx.initialize();
    // Wait briefly for startup sync to finish or abort it
    await idx.shutdown();

    // Re-open with a clean DB to isolate reindexFile behavior
    const idx2 = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-reindex2.db"),
    });
    await idx2.initialize();
    await idx2.shutdown();

    // Re-open without startup sync side effects
    const dbPath = path.join(tmpDir, "test-reindex-isolated.db");
    const idx3 = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx3.initialize();

    // Give startup sync a moment then abort it
    idx3._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    fetchCallCount = 0;
    await idx3.reindexFile("notes/note-a.md");

    // Verify file record was created
    const fileRow = idx3.db.prepare("SELECT * FROM files WHERE path = ?").get("notes/note-a.md");
    assert.ok(fileRow, "File record should exist");
    assert.equal(fileRow.path, "notes/note-a.md");
    assert.ok(fileRow.content_hash.length === 64, "Should have SHA-256 hash");
    assert.ok(fileRow.chunk_count >= 1, "Should have at least 1 chunk");

    // Verify chunks were created
    const chunkRows = idx3.db.prepare("SELECT * FROM chunks WHERE file_path = ?").all("notes/note-a.md");
    assert.ok(chunkRows.length >= 1, "Should have chunks in DB");
    assert.equal(chunkRows[0].file_path, "notes/note-a.md");
    assert.ok(chunkRows[0].content_preview.length > 0);

    // Verify fetch was called (embedding API)
    assert.ok(fetchCallCount >= 1, "Should have called fetch for embeddings");

    await idx3.shutdown();
  });

  it("reindexFile() is idempotent (skips unchanged files)", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-idempotent.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    fetchCallCount = 0;
    await idx.reindexFile("notes/note-b.md");
    const firstCallCount = fetchCallCount;
    assert.ok(firstCallCount >= 1, "First index should call fetch");

    // Re-index same file without changes
    fetchCallCount = 0;
    await idx.reindexFile("notes/note-b.md");
    assert.equal(fetchCallCount, 0, "Second index should skip (no changes)");

    await idx.shutdown();
  });

  it("removeFile() deletes chunks and file record", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-remove.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");

    // Verify it's indexed
    const before = idx.db.prepare("SELECT count(*) as n FROM chunks WHERE file_path = ?").get("notes/note-a.md");
    assert.ok(before.n >= 1);

    // Remove it
    idx.removeFile("notes/note-a.md");

    // Verify it's gone
    const afterChunks = idx.db.prepare("SELECT count(*) as n FROM chunks WHERE file_path = ?").get("notes/note-a.md");
    assert.equal(afterChunks.n, 0, "Chunks should be removed");

    const afterFiles = idx.db.prepare("SELECT count(*) as n FROM files WHERE path = ?").get("notes/note-a.md");
    assert.equal(afterFiles.n, 0, "File record should be removed");

    await idx.shutdown();
  });

  it("search() returns formatted results", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-search.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    // Index all three notes
    await idx.reindexFile("notes/note-a.md");
    await idx.reindexFile("notes/note-b.md");
    await idx.reindexFile("notes/note-c.md");

    const result = await idx.search({ query: "machine learning" });
    assert.equal(typeof result, "string");
    assert.ok(result.includes("semantically related note"), `Expected formatted header but got: ${result}`);
    assert.ok(result.includes("score:"), "Should include score");

    await idx.shutdown();
  });

  it("search() respects limit param", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-search-limit.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");
    await idx.reindexFile("notes/note-b.md");
    await idx.reindexFile("notes/note-c.md");

    const result = await idx.search({ query: "test query", limit: 1 });
    assert.ok(result.includes("1 semantically related note"), `Expected 1 result but got: ${result}`);

    await idx.shutdown();
  });

  it("search() with folder filter restricts results", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-search-folder.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");

    // Search in a non-existent folder
    const result = await idx.search({ query: "test", folder: "other-folder" });
    assert.ok(result.includes("No semantically related notes found"), `Folder filter should exclude results but got: ${result}`);

    await idx.shutdown();
  });

  it("search() throws when not available", async () => {
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "",
      dbPath: path.join(tmpDir, "test-unavail.db"),
    });
    await idx.initialize();
    await assert.rejects(() => idx.search({ query: "test" }), /not available/);
    await idx.shutdown();
  });

  it("search() results are consistent with searchRaw()", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-search-consistency.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");
    await idx.reindexFile("notes/note-b.md");

    const formatted = await idx.search({ query: "machine learning", limit: 2 });
    const raw = await idx.searchRaw({ query: "machine learning", limit: 2 });

    // Every raw result path should appear in the formatted string
    for (const r of raw) {
      assert.ok(formatted.includes(r.path), `Formatted output should contain ${r.path}`);
      assert.ok(formatted.includes(String(r.score)), `Formatted output should contain score ${r.score}`);
    }

    await idx.shutdown();
  });

  it("searchRaw() returns array of result objects", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-searchraw.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");
    await idx.reindexFile("notes/note-b.md");

    const results = await idx.searchRaw({ query: "database queries" });
    assert.ok(Array.isArray(results), "Should return an array");
    assert.ok(results.length >= 1, "Should have results");
    assert.ok(results[0].path, "Each result should have path");
    assert.equal(typeof results[0].score, "number", "Each result should have numeric score");
    assert.ok(results[0].preview, "Each result should have preview");

    await idx.shutdown();
  });

  it("searchRaw() respects excludeFiles", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-searchraw-exclude.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    await idx.reindexFile("notes/note-a.md");
    await idx.reindexFile("notes/note-b.md");

    const results = await idx.searchRaw({
      query: "test",
      excludeFiles: new Set(["notes/note-a.md"]),
    });
    const paths = results.map(r => r.path);
    assert.ok(!paths.includes("notes/note-a.md"), "Excluded file should not appear");

    await idx.shutdown();
  });

  it("shutdown() is safe to call multiple times", async () => {
    globalThis.fetch = mockFetch;

    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-shutdown.db"),
    });
    await idx.initialize();
    await idx.shutdown();
    // Second shutdown should not throw
    await idx.shutdown();
    assert.equal(idx.db, null);
  });

  it("reindexFile() is a no-op when db is null", async () => {
    globalThis.fetch = mockFetch;

    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-noop.db"),
    });
    // Don't initialize - db is null
    await idx.reindexFile("notes/note-a.md");
    // Should not throw
  });

  it("removeFile() is a no-op when db is null", () => {
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-remove-noop.db"),
    });
    // Don't initialize - db is null
    idx.removeFile("notes/note-a.md");
    // Should not throw
  });

  it("reindexFile() calls removeFile for deleted files (ENOENT)", async () => {
    globalThis.fetch = mockFetch;

    const dbPath = path.join(tmpDir, "test-enoent.db");
    const idx = newIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();
    idx._abortController.abort();
    await new Promise(r => setTimeout(r, 100));

    // Index a file first
    await idx.reindexFile("notes/note-a.md");
    const beforeCount = idx.db.prepare("SELECT count(*) as n FROM chunks WHERE file_path = ?").get("notes/note-a.md").n;
    assert.ok(beforeCount >= 1);

    // Now "delete" it by reindexing a non-existent path
    await idx.reindexFile("notes/deleted-file.md");
    // Should not throw, and deleted-file should have no chunks
    const afterCount = idx.db.prepare("SELECT count(*) as n FROM chunks WHERE file_path = ?").get("notes/deleted-file.md").n;
    assert.equal(afterCount, 0);

    await idx.shutdown();
  });
});

// ---------------------------------------------------------------------------
// SemanticIndex health: disabled state, probe, visible failures
// ---------------------------------------------------------------------------
describe("SemanticIndex health", () => {
  let fake;
  const opened = [];
  const vaults = [];

  async function vaultWith(files) {
    const dir = await makeVault(files);
    vaults.push(dir);
    return dir;
  }

  async function openIndex(vaultPath) {
    const idx = newIndex({
      vaultPath,
      openaiApiKey: "test-key",
      sleep: async () => {},
    });
    opened.push(idx);
    await idx.initialize();
    return idx;
  }

  async function readStats(vaultPath) {
    return JSON.parse(await fs.readFile(statsFile(vaultPath), "utf-8"));
  }

  afterEach(async () => {
    for (const idx of opened.splice(0)) await idx.shutdown();
    fake?.restore();
    fake = null;
    for (const dir of vaults.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  const disablingFailures = [
    { kind: "quota", respond: () => quotaResponse(), reason: /^OpenAI quota exhausted\. Add credits; it re-enables automatically\.$/ },
    { kind: "auth", respond: () => errorResponse(401, "{\"error\":{\"code\":\"invalid_api_key\"}}"), reason: /^OpenAI rejected the API key \(HTTP 401\)/ },
  ];
  for (const c of disablingFailures) {
    it(`${c.kind} failure during sync disables the index, stops embedding, and persists status/reason/since`, async () => {
      const vault = await vaultWith(manyNotes(25));
      fake = installFakeOpenAI(() => c.respond());
      const idx = await openIndex(vault);
      const summary = await idx.whenSynced();

      assert.ok(fake.calls.length >= 1 && fake.calls.length <= 10, `only the first batch may hit the API, got ${fake.calls.length}`);
      assert.deepEqual(summary, { updated: 0, failed: 10, skipped: 15 });
      const health = idx.health();
      assert.equal(health.status, "disabled");
      assert.match(health.reason, c.reason);
      assert.ok(!Number.isNaN(Date.parse(health.since)));
      assert.equal(idx.isAvailable, false);

      const stats = await readStats(vault);
      assert.equal(stats.status, "disabled");
      assert.equal(stats.reason, health.reason);
      assert.equal(stats.since, health.since);
      assert.equal(stats.stale_files, 25);
    });
  }

  it("probe() while disabled re-enables the index and syncs the stale notes", async () => {
    const vault = await vaultWith(manyNotes(25));
    fake = installFakeOpenAI(() => quotaResponse());
    const idx = await openIndex(vault);
    await idx.whenSynced();
    assert.equal(idx.isAvailable, false);

    fake.handler = (inputs) => embeddingsResponse(inputs);
    assert.equal(await idx.probe(), true);
    assert.equal(idx.isAvailable, true);
    await idx.whenSynced();

    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 25);
    const stats = await readStats(vault);
    assert.equal(stats.status, "ok");
    assert.equal(stats.reason, null);
    assert.equal(stats.since, null);
    assert.equal(stats.stale_files, 0);
    assert.ok(!Number.isNaN(Date.parse(stats.last_success_at)));
  });

  it("a failed probe sends one request, keeps the index disabled and keeps the original since", async () => {
    const vault = await vaultWith(manyNotes(3));
    fake = installFakeOpenAI(() => quotaResponse());
    const idx = await openIndex(vault);
    await idx.whenSynced();
    const { since } = idx.health();
    const before = fake.calls.length;

    const results = await Promise.all([idx.probe(), idx.probe()]);

    assert.deepEqual(results, [false, false]);
    assert.equal(fake.calls.length, before + 1, "concurrent probes share one request");
    assert.equal(idx.health().status, "disabled");
    assert.equal(idx.health().since, since);
  });

  it("the disabled state survives a restart: one probe, no other API calls, original since", async () => {
    const vault = await vaultWith(manyNotes(25));
    fake = installFakeOpenAI(() => quotaResponse());
    const first = await openIndex(vault);
    await first.whenSynced();
    const { since } = first.health();
    await first.shutdown();
    const before = fake.calls.length;

    const second = await openIndex(vault);
    const summary = await second.whenSynced();

    assert.equal(fake.calls.length, before + 1, "only the startup probe hits the API");
    assert.deepEqual(summary, { updated: 0, failed: 0, skipped: 25 });
    assert.equal(second.health().status, "disabled");
    assert.equal(second.health().since, since);
    assert.equal(second.health().staleFiles, 25);
  });

  it("a quota error on a search query disables the index and searchRaw reports it", async () => {
    const vault = await vaultWith(manyNotes(2));
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.whenSynced();

    fake.handler = () => quotaResponse();
    const expected = /^Semantic search disabled since \d{4}-\d{2}-\d{2}: OpenAI quota exhausted\. Add credits; it re-enables automatically\.$/;
    await assert.rejects(() => idx.searchRaw({ query: "anything" }), (err) => expected.test(err.message));
    const callsAfterFirst = fake.calls.length;
    await assert.rejects(() => idx.searchRaw({ query: "anything" }), (err) => expected.test(err.message));
    assert.equal(fake.calls.length, callsAfterFirst, "a disabled index makes no query request");
  });

  it("reindexFile rejects with the EmbeddingError and the note counts as stale", async () => {
    const vault = await vaultWith(manyNotes(2));
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.whenSynced();

    await fs.writeFile(path.join(vault, "notes", "n00.md"), "---\ntype: note\n---\nChanged body.\n");
    fake.handler = () => errorResponse(500, "server error");
    await assert.rejects(
      () => idx.reindexFile("notes/n00.md"),
      (err) => err instanceof EmbeddingError && err.kind === "transient"
    );
    assert.equal(idx.health().staleFiles, 1);
    assert.equal(idx.health().status, "ok", "transient failures do not disable the index");
  });

  it("startup sync summary and log report updated and failed notes", async (t) => {
    const vault = await vaultWith({
      "a.md": "Alpha body.",
      "b.md": "Beta body.",
      "c.md": "BROKEN body.",
    });
    fake = installFakeOpenAI((inputs) => (inputs.some(i => i.includes("BROKEN"))
      ? errorResponse(404, "nope")
      : embeddingsResponse(inputs)));
    const logs = t.mock.method(console, "error", () => {});
    const idx = await openIndex(vault);
    const summary = await idx.whenSynced();

    assert.deepEqual(summary, { updated: 2, failed: 1, skipped: 0 });
    const lines = logs.mock.calls.map(call => String(call.arguments[0]));
    assert.ok(lines.includes("Semantic index: sync complete (2 updated, 1 failed)"), lines.join("\n"));
    assert.equal((await readStats(vault)).stale_files, 1);
  });

  it("stats record last_success_at and stale_files; empty notes are indexed with zero chunks", async () => {
    const vault = await vaultWith({
      "full.md": "Some body text.",
      "empty.md": "---\ntype: note\n---\n",
    });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.whenSynced();

    const stats = await readStats(vault);
    assert.equal(stats.status, "ok");
    assert.equal(stats.stale_files, 0);
    assert.ok(!Number.isNaN(Date.parse(stats.last_success_at)));
    assert.equal(idx.db.prepare("SELECT chunk_count FROM files WHERE path = ?").get("empty.md").chunk_count, 0);

    await idx.shutdown();
    const before = fake.calls.length;
    const reopened = await openIndex(vault);
    assert.deepEqual(await reopened.whenSynced(), { updated: 0, failed: 0, skipped: 0 });
    assert.equal(fake.calls.length, before, "an empty note is not re-read as stale on restart");
  });

  it("search output gains the coverage line only while some notes are not embedded", async () => {
    const vault = await vaultWith(manyNotes(2));
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.whenSynced();
    const line = "Semantic index: 1 of 2 notes embedded";

    assert.ok(!(await idx.search({ query: "note" })).includes("Semantic index:"));

    await fs.writeFile(path.join(vault, "notes", "n00.md"), "Changed body.");
    fake.handler = () => errorResponse(500, "server error");
    await assert.rejects(() => idx.reindexFile("notes/n00.md"));
    fake.handler = (inputs) => embeddingsResponse(inputs);

    assert.ok((await idx.search({ query: "note" })).endsWith(line));
  });
});

describe("SemanticIndex health: fix round", () => {
  let fake;
  const opened = [];
  const vaults = [];

  async function vaultWith(files) {
    const dir = await makeVault(files);
    vaults.push(dir);
    return dir;
  }

  async function openIndex(vaultPath) {
    const idx = newIndex({
      vaultPath,
      openaiApiKey: "test-key",
      sleep: async () => {},
    });
    opened.push(idx);
    await idx.initialize();
    return idx;
  }

  afterEach(async () => {
    for (const idx of opened.splice(0)) await idx.shutdown();
    fake?.restore();
    fake = null;
    for (const dir of vaults.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it("shutdown during the first sync batch stops the sync: at most one batch is sent", async () => {
    const vault = await vaultWith(manyNotes(25));
    let release;
    const gate = new Promise(r => { release = r; });
    fake = installFakeOpenAI(async (inputs) => { await gate; return embeddingsResponse(inputs); });
    const idx = await openIndex(vault);
    while (fake.calls.length === 0) await new Promise(r => setTimeout(r, 5));
    const closing = idx.shutdown();
    release();
    await closing;
    assert.ok(fake.calls.length <= 10, `got ${fake.calls.length} requests`);
  });

  // Resolves to "closed" when shutdown() finishes, or "hung" if it is still waiting after a second.
  async function shutdownPromptly(idx) {
    let timer;
    const hung = new Promise((r) => { timer = setTimeout(() => r("hung"), 1000); });
    try {
      return await Promise.race([idx.shutdown().then(() => "closed"), hung]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("shutdown during an in-flight embeddings request aborts it instead of waiting for the response", async () => {
    const vault = await vaultWith(manyNotes(1));
    let inFlight;
    const requested = new Promise((r) => { inFlight = r; });
    // The fake never answers; only an abort of the request's signal ends it.
    fake = installFakeOpenAI((_inputs, _n, signal) => new Promise((_resolve, reject) => {
      inFlight();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const idx = await openIndex(vault);
    await requested;
    assert.equal(await shutdownPromptly(idx), "closed");
    assert.equal(fake.calls.length, 1);
  });

  it("shutdown during a retry backoff ends the wait at once and sends no further request", async () => {
    const vault = await vaultWith(manyNotes(1));
    fake = installFakeOpenAI(() => errorResponse(503, "busy"));
    let waiting;
    const inBackoff = new Promise((r) => { waiting = r; });
    const idx = newIndex({
      vaultPath: vault,
      openaiApiKey: "test-key",
      // A backoff that never elapses on its own; only an abort ends it.
      sleep: (_ms, signal) => new Promise((resolve) => {
        waiting();
        signal?.addEventListener("abort", resolve, { once: true });
      }),
    });
    opened.push(idx);
    await idx.initialize();
    await inBackoff;
    assert.equal(await shutdownPromptly(idx), "closed");
    assert.equal(fake.calls.length, 1);
  });

  it("initialize keeps the persisted stale_files and vault_files until the scan completes", async () => {
    const vault = await vaultWith(manyNotes(3));
    await fs.mkdir(path.dirname(statsFile(vault)), { recursive: true });
    const statsPath = statsFile(vault);
    await fs.writeFile(statsPath, JSON.stringify({
      indexed_files: 0, vault_files: 3, status: "disabled", reason: "OpenAI quota exhausted. Add credits; it re-enables automatically.",
      since: "2026-07-03T09:12:00.000Z", last_success_at: null, stale_files: 3, updated_at: "2026-07-03T09:12:00.000Z",
    }));
    let release;
    const gate = new Promise(r => { release = r; });
    fake = installFakeOpenAI(async () => { await gate; return quotaResponse(); });
    await openIndex(vault);
    const stats = JSON.parse(await fs.readFile(statsPath, "utf-8"));
    assert.equal(stats.stale_files, 3);
    assert.equal(stats.vault_files, 3);
    release();
  });

  it("a rate limit longer than the retry cap stops the sync without disabling the index", async () => {
    const vault = await vaultWith(manyNotes(25));
    fake = installFakeOpenAI(() => errorResponse(429, "{}", { "x-ratelimit-reset-requests": "6h0m0s" }));
    const idx = await openIndex(vault);
    const summary = await idx.whenSynced();
    assert.ok(fake.calls.length <= 10, `got ${fake.calls.length} requests`);
    assert.equal(summary.updated, 0);
    assert.ok(summary.skipped >= 15);
    assert.equal(idx.health().status, "ok");
    assert.equal(idx.health().staleFiles, 25);
  });

  it("a disabled index whose key later becomes invalid keeps its since and updates the reason", async () => {
    const vault = await vaultWith(manyNotes(1));
    fake = installFakeOpenAI(() => quotaResponse());
    const idx = await openIndex(vault);
    await idx.whenSynced();
    const { since } = idx.health();
    fake.handler = () => errorResponse(401, "{}");
    assert.equal(await idx.probe(), false);
    assert.equal(idx.health().since, since);
    assert.match(idx.health().reason, /^OpenAI rejected the API key \(HTTP 401\)/);
    const stats = JSON.parse(await fs.readFile(statsFile(vault), "utf-8"));
    assert.match(stats.reason, /^OpenAI rejected the API key/);
  });
});

// ---------------------------------------------------------------------------
// SemanticIndex freshness and consistency
// ---------------------------------------------------------------------------
describe("SemanticIndex freshness", () => {
  let fake;
  const opened = [];
  const vaults = [];

  /** Stand-in for fs.watch: records the listener so tests can deliver events. */
  function fakeWatch() {
    const watchers = [];
    const watch = (_dir, _opts, listener) => {
      const w = new EventEmitter();
      w.listener = listener;
      w.closed = false;
      w.close = () => { w.closed = true; };
      watchers.push(w);
      return w;
    };
    return { watchers, watch, emit: (filename) => watchers.at(-1).listener("rename", filename) };
  }

  function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  }

  async function vaultWith(files) {
    const dir = await makeVault(files);
    vaults.push(dir);
    return dir;
  }

  async function openIndex(vaultPath, opts = {}) {
    const idx = newIndex({
      vaultPath,
      openaiApiKey: "test-key",
      sleep: async () => {},
      watch: fakeWatch().watch,
      debounceMs: 0,
      ...opts,
    });
    opened.push(idx);
    await idx.initialize();
    await idx.whenIdle();
    return idx;
  }

  const indexedPaths = (idx) => idx.db.prepare("SELECT path FROM files ORDER BY path").all().map(r => r.path);
  const requestsMentioning = (text) => fake.calls.filter(inputs => inputs.some(i => i.includes(text))).length;

  afterEach(async () => {
    for (const idx of opened.splice(0)) await idx.shutdown();
    fake?.restore();
    fake = null;
    for (const dir of vaults.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it("watcher events during the startup sync are queued, deduplicated, and processed after it", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    const gate = deferred();
    fake = installFakeOpenAI(async (inputs) => {
      if (inputs.some(i => i.includes("Alpha"))) await gate.promise;
      return embeddingsResponse(inputs);
    });
    const watcher = fakeWatch();
    const idx = newIndex({
      vaultPath: vault, openaiApiKey: "test-key",
      sleep: async () => {}, watch: watcher.watch, debounceMs: 0,
    });
    opened.push(idx);
    await idx.initialize();
    while (requestsMentioning("Alpha") === 0) await new Promise(r => setTimeout(r, 5));

    await fs.writeFile(path.join(vault, "new.md"), "Newcomer body.");
    for (let i = 0; i < 3; i++) watcher.emit("new.md");
    await new Promise(r => setTimeout(r, 20));
    assert.equal(requestsMentioning("Newcomer"), 0, "nothing is processed while the sync runs");

    gate.resolve();
    await idx.whenSynced();
    await idx.whenIdle();
    assert.equal(requestsMentioning("Newcomer"), 1, "three events, one reindex");
    assert.deepEqual(indexedPaths(idx), ["a.md", "new.md"]);
  });

  it("events under dot-folders, such as the index's own DB files, are ignored", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const idx = await openIndex(vault, { watch: watcher.watch });
    const before = fake.calls.length;

    watcher.emit(path.join(".obsidian", "test-index.db-wal"));
    watcher.emit(path.join(".trash", "old.md"));
    await idx.whenIdle();

    assert.equal(fake.calls.length, before);
    assert.deepEqual(indexedPaths(idx), ["a.md"]);
  });

  it("a folder renamed on disk loses its old paths and gains the new ones", async () => {
    const vault = await vaultWith({ "projects/alpha/x.md": "X body.", "projects/alpha/y.md": "Y body.", "keep.md": "Keep." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const idx = await openIndex(vault, { watch: watcher.watch });

    await fs.rename(path.join(vault, "projects", "alpha"), path.join(vault, "projects", "beta"));
    watcher.emit(path.join("projects", "alpha"));
    watcher.emit(path.join("projects", "beta"));
    await idx.whenIdle();

    assert.deepEqual(indexedPaths(idx), ["keep.md", "projects/beta/x.md", "projects/beta/y.md"]);
  });

  it("a watcher error closes it and restarts it with backoff, at most 5 times", async (t) => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const { delays, sleep } = recordingSleep();
    const logs = t.mock.method(console, "error", () => {});
    const idx = await openIndex(vault, { watch: watcher.watch, sleep });

    for (let i = 0; i < 6; i++) {
      watcher.watchers.at(-1).emit("error", new Error(`boom ${i}`));
      await new Promise(r => setTimeout(r, 0));
      await idx.whenIdle();
    }

    assert.equal(watcher.watchers.length, 6, "initial watcher plus 5 restarts");
    assert.ok(watcher.watchers.every(w => w.closed));
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
    const lines = logs.mock.calls.map(call => String(call.arguments[0]));
    assert.equal(lines.filter(l => l.startsWith("File watcher: restarting")).length, 5);
    assert.ok(lines.some(l => l.startsWith("File watcher: giving up after 5 restarts")));
  });

  it("notifyChanged reindexes the note after the debounce", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);

    await fs.writeFile(path.join(vault, "a.md"), "Alpha rewritten.");
    idx.notifyChanged("a.md");
    await idx.whenIdle();

    const row = idx.db.prepare("SELECT content_hash FROM files WHERE path = ?").get("a.md");
    assert.equal(row.content_hash, contentHash("Alpha rewritten."));
  });

  it("notifyRemoved drops the note's rows without an API call", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body.", "b.md": "Beta body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    const before = fake.calls.length;

    await fs.rm(path.join(vault, "b.md"));
    await idx.notifyRemoved("b.md");

    assert.deepEqual(indexedPaths(idx), ["a.md"]);
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'b.md'").get().n, 0);
    assert.equal(fake.calls.length, before);
  });

  const moves = [
    { name: "a note", files: { "a.md": "Alpha body.", "b.md": "Beta body." }, from: "b.md", to: "archive/b.md", expected: ["a.md", "archive/b.md"] },
    { name: "a folder", files: { "a.md": "Alpha body.", "old/x.md": "X body.", "old/sub/y.md": "Y body." }, from: "old", to: "new", expected: ["a.md", "new/sub/y.md", "new/x.md"] },
  ];
  for (const c of moves) {
    it(`notifyMoved carries ${c.name}'s rows to the new path without API calls`, async () => {
      const vault = await vaultWith(c.files);
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const before = fake.calls.length;

      await fs.mkdir(path.dirname(path.join(vault, c.to)), { recursive: true });
      await fs.rename(path.join(vault, c.from), path.join(vault, c.to));
      idx.notifyMoved(c.from, c.to);
      await idx.whenIdle();

      assert.deepEqual(indexedPaths(idx), c.expected);
      assert.equal(fake.calls.length, before);
    });
  }

  it("reindexes of the same path run one at a time", async () => {
    const vault = await vaultWith({ "x.md": "version zero" });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    const gate = deferred();
    fake.handler = async (inputs) => {
      if (inputs.some(i => i.includes("version one"))) await gate.promise;
      return embeddingsResponse(inputs);
    };

    await fs.writeFile(path.join(vault, "x.md"), "version one");
    const first = idx.reindexFile("x.md");
    while (requestsMentioning("version one") === 0) await new Promise(r => setTimeout(r, 5));
    await fs.writeFile(path.join(vault, "x.md"), "version two");
    const second = idx.reindexFile("x.md");
    await new Promise(r => setTimeout(r, 20));
    assert.equal(requestsMentioning("version two"), 0, "the second reindex waits for the first");

    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(requestsMentioning("version two"), 1);
    const row = idx.db.prepare("SELECT content_hash FROM files WHERE path = ?").get("x.md");
    assert.equal(row.content_hash, contentHash("version two"));
  });

  it("a late embedding result for old content never overwrites newer vectors (two server processes)", async () => {
    const vault = await vaultWith({ "x.md": "version zero" });
    fake = installFakeOpenAI();
    const first = await openIndex(vault);
    const second = await openIndex(vault);
    const gate = deferred();
    fake.handler = async (inputs) => {
      if (inputs.some(i => i.includes("version one"))) await gate.promise;
      return embeddingsResponse(inputs);
    };

    await fs.writeFile(path.join(vault, "x.md"), "version one");
    const slow = first.reindexFile("x.md");
    while (requestsMentioning("version one") === 0) await new Promise(r => setTimeout(r, 5));
    await fs.writeFile(path.join(vault, "x.md"), "version two");
    await second.reindexFile("x.md");
    gate.resolve();
    await slow;

    const row = second.db.prepare("SELECT content_hash FROM files WHERE path = ?").get("x.md");
    assert.equal(row.content_hash, contentHash("version two"));
    const previews = second.db.prepare("SELECT content_preview FROM chunks WHERE file_path = ?").all("x.md");
    assert.deepEqual(previews.map(p => p.content_preview), ["version two"]);
    assert.equal(first.health().staleFiles, 0, "the discarding process sees the note as current");
  });

  it("unchanged content with a new mtime updates mtime_ms only and makes no API call", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    const before = fake.calls.length;

    const touched = new Date("2026-10-01T10:00:00Z");
    await fs.utimes(path.join(vault, "a.md"), touched, touched);
    await idx.reindexFile("a.md");

    assert.equal(fake.calls.length, before);
    assert.equal(idx.db.prepare("SELECT mtime_ms FROM files WHERE path = 'a.md'").get().mtime_ms, touched.getTime());
    await idx.shutdown();
    const reopened = await openIndex(vault);
    assert.deepEqual(await reopened.whenSynced(), { updated: 0, failed: 0, skipped: 0 }, "the touched note is not re-read on restart");
  });

  const folderSearches = [
    { name: "by widening k", opts: {} },
    { name: "by an exhaustive folder scan once k reaches the KNN cap", opts: { maxKnnK: 8 } },
  ];
  for (const c of folderSearches) {
    it(`folder-scoped search finds the folder's notes when 50+ other chunks rank higher (${c.name})`, async () => {
      const files = { "target/t1.md": "TARGET one.", "target/t2.md": "TARGET two." };
      for (let i = 0; i < 60; i++) files[`other/o${i}.md`] = `OTHER note ${i}.`;
      const vault = await vaultWith(files);
      const embed = (text) => {
        const vec = new Array(DIMS).fill(0);
        if (text.includes("TARGET")) vec[1] = 1;
        else if (text.includes("OTHER")) { vec[0] = 1; vec[2] = (text.length % 7) / 100; }
        else vec[0] = 1;
        return vec;
      };
      fake = installFakeOpenAI((inputs) => embeddingsResponse(inputs, embed));
      const idx = await openIndex(vault, c.opts);

      const results = await idx.searchRaw({ query: "query", folder: "target", limit: 2 });

      assert.deepEqual(results.map(r => r.path).sort(), ["target/t1.md", "target/t2.md"]);
    });
  }

  it("sends the small embedding model and stores 1536-dimension vectors with each chunk's hash", async () => {
    const vault = await vaultWith({ "a.md": "# Title\n\nAlpha body." });
    const bodies = [];
    const original = globalThis.fetch;
    fake = installFakeOpenAI();
    const wrapped = globalThis.fetch;
    globalThis.fetch = (url, opts) => { bodies.push(JSON.parse(opts.body)); return wrapped(url, opts); };
    try {
      const idx = await openIndex(vault);
      await idx.whenSynced();
      await idx.whenIdle();

      assert.ok(bodies.length > 0);
      for (const b of bodies) assert.equal(b.model, "text-embedding-3-small");
      const vec = idx.db.prepare("SELECT embedding FROM vec_chunks LIMIT 1").get();
      assert.equal(vec.embedding.byteLength, 1536 * 4);
      const rows = idx.db.prepare("SELECT chunk_hash FROM chunks WHERE file_path = 'a.md'").all();
      assert.ok(rows.length > 0);
      for (const r of rows) assert.match(r.chunk_hash, /^[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("an instance initialised again after shutdown syncs and reports the new sync", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.shutdown();

    // shutdown() closed the local index it was given; a second life needs a fresh one.
    idx.localIndex = openLocalIndex({ vaultPath: vault, dbPath: path.join(sidecarDir(vault), "index.db") });
    openedIndexes.push(idx.localIndex);
    await fs.writeFile(path.join(vault, "b.md"), "Beta body.");
    await idx.initialize();
    const summary = await idx.whenSynced();
    await idx.whenIdle();

    assert.deepEqual(summary, { updated: 1, failed: 0, skipped: 0 });
    assert.deepEqual(indexedPaths(idx), ["a.md", "b.md"]);
  });

  it("shutdown right after initialize leaves neither the database nor a watcher open", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const idx = newIndex({
      vaultPath: vault, openaiApiKey: "test-key",
      sleep: async () => {}, watch: watcher.watch, debounceMs: 0,
    });
    opened.push(idx);

    const init = idx.initialize();
    const stopped = idx.shutdown();
    await Promise.all([init, stopped]);

    assert.equal(idx.db, null);
    assert.ok(watcher.watchers.every(w => w.closed), "every watcher was closed");
    assert.equal(fake.calls.length, 0);
  });

  it("a too_large batch is split in half until it fits", async () => {
    const section = (name) => `## ${name}\n\n` + `${name} words `.repeat(300);
    const vault = await vaultWith({ "long.md": [section("One"), section("Two"), section("Three")].join("\n\n") });
    fake = installFakeOpenAI((inputs) => (inputs.length > 1
      ? errorResponse(400, "This model's maximum context length is 8192 tokens")
      : embeddingsResponse(inputs)));
    const idx = await openIndex(vault);

    assert.deepEqual(fake.calls.map(inputs => inputs.length), [3, 2, 1, 1, 1]);
    assert.equal(idx.db.prepare("SELECT chunk_count FROM files WHERE path = 'long.md'").get().chunk_count, 3);
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get().n, 3);
  });

  it("an oversize chunk is embedded as two halves and stored as one vector", async () => {
    const vault = await vaultWith({ "big.md": "word ".repeat(700) });
    fake = installFakeOpenAI((inputs) => (inputs[0].length > 2000
      ? errorResponse(400, "This model's maximum context length is 8192 tokens")
      : embeddingsResponse(inputs)));
    const idx = await openIndex(vault);

    const [whole, firstHalf, secondHalf] = fake.calls.map(inputs => inputs[0]);
    assert.equal(fake.calls.length, 3);
    assert.equal(firstHalf + secondHalf, whole);
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'big.md'").get().n, 1);
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get().n, 1);
  });

  it("too_large on an input too short to split is reported after a bounded number of requests", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    fake.handler = () => errorResponse(400, "This model's maximum context length is 8192 tokens");

    await fs.writeFile(path.join(vault, "a.md"), "word ".repeat(1200));
    const before = fake.calls.length;
    await assert.rejects(() => idx.reindexFile("a.md"), (err) => err.kind === "too_large");
    assert.ok(fake.calls.length - before <= 10, `requests: ${fake.calls.length - before}`);
  });

  it("shutdown during a folder reconcile sends no request after the current batch", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const idx = await openIndex(vault, { watch: watcher.watch });
    const before = fake.calls.length;
    for (let i = 0; i < 25; i++) {
      await fs.mkdir(path.join(vault, "drop"), { recursive: true });
      await fs.writeFile(path.join(vault, "drop", `n${i}.md`), `Dropped ${i}.`);
    }
    const gate = deferred();
    fake.handler = async (inputs) => {
      await gate.promise;
      return embeddingsResponse(inputs);
    };

    watcher.emit("drop");
    while (fake.calls.length - before < 10) await new Promise(r => setTimeout(r, 5));
    const stopping = idx.shutdown();
    gate.resolve();
    await stopping;

    assert.equal(fake.calls.length - before, 10, "only the batch that was already running is sent");
  });

  it("a note whose mtime moved but whose content did not is neither updated nor stale at startup", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body.", "b.md": "Beta body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.shutdown();
    const touched = new Date("2026-10-01T10:00:00Z");
    await fs.utimes(path.join(vault, "a.md"), touched, touched);
    const before = fake.calls.length;

    const reopened = await openIndex(vault);

    assert.deepEqual(await reopened.whenSynced(), { updated: 0, failed: 0, skipped: 0 });
    assert.equal(fake.calls.length, before);
    assert.equal(reopened.health().staleFiles, 0);
    assert.equal(reopened.db.prepare("SELECT mtime_ms FROM files WHERE path = 'a.md'").get().mtime_ms, touched.getTime());
  });

  it("while disabled, a note with only a new mtime is not counted as stale", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body.", "b.md": "Beta body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.shutdown();
    const statsPath = statsFile(vault);
    const stats = JSON.parse(await fs.readFile(statsPath, "utf-8"));
    await fs.writeFile(statsPath, JSON.stringify({ ...stats, status: "disabled", reason: "quota", since: "2026-10-01T00:00:00Z" }));
    const touched = new Date("2026-10-02T10:00:00Z");
    await fs.utimes(path.join(vault, "b.md"), touched, touched);
    fake.handler = () => quotaResponse();

    const reopened = await openIndex(vault);

    assert.equal(reopened.health().status, "disabled");
    assert.equal(reopened.health().staleFiles, 0);
  });

  it("a watcher restart that fails to start keeps backing off and ends with the give-up line", async (t) => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const base = fakeWatch();
    let starts = 0;
    const watch = (...args) => {
      starts++;
      if (starts > 1) throw new Error("EMFILE: too many open files, watch");
      return base.watch(...args);
    };
    const { delays, sleep } = recordingSleep();
    const logs = t.mock.method(console, "error", () => {});
    await openIndex(vault, { watch, sleep });

    base.watchers[0].emit("error", new Error("boom"));
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));

    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
    const lines = logs.mock.calls.map(call => String(call.arguments[0]));
    assert.ok(lines.some(l => l.startsWith("File watcher: giving up after 5 restarts")));
  });

  it("a watcher restart pending at shutdown does not replace the watcher of a re-initialised instance", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const watcher = fakeWatch();
    const gate = deferred();
    let hold = false;
    const sleep = async () => { if (hold) await gate.promise; };
    const idx = await openIndex(vault, { watch: watcher.watch, sleep });

    hold = true;
    watcher.watchers[0].emit("error", new Error("boom"));
    await idx.shutdown();
    hold = false;
    await idx.initialize();
    await idx.whenIdle();
    gate.resolve();
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

    assert.equal(watcher.watchers.length, 2, "the stale restart started no third watcher");
    assert.equal(idx.watcher, watcher.watchers[1]);
    assert.equal(watcher.watchers[1].closed, false);
  });

  const splitPads = ["", "a"];
  for (const pad of splitPads) {
    it(`an oversize input is never split inside a surrogate pair (pad ${JSON.stringify(pad)})`, async () => {
      const body = pad + "\u{1F600}".repeat(1500);
      const vault = await vaultWith({ "emoji.md": body });
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      fake = installFakeOpenAI((inputs) => (inputs[0].length > 2000
        ? errorResponse(400, "This model's maximum context length is 8192 tokens")
        : embeddingsResponse(inputs)));
      const idx = await openIndex(vault);

      assert.equal(fake.calls.length, 3);
      assert.ok(fake.calls.every(inputs => !lone.test(inputs[0])), "no request carries a lone surrogate");
      assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'emoji.md'").get().n, 1);
    });
  }

  it("folder-scoped search of a folder with fewer notes than the limit scores the folder directly", async () => {
    const files = { "target/t1.md": "TARGET one.", "target/t2.md": "TARGET two." };
    for (let i = 0; i < 60; i++) files[`other/o${i}.md`] = `OTHER note ${i}.`;
    const vault = await vaultWith(files);
    const embed = (text) => {
      const vec = new Array(DIMS).fill(0);
      if (text.includes("TARGET")) vec[1] = 1;
      else vec[0] = 1;
      return vec;
    };
    fake = installFakeOpenAI((inputs) => embeddingsResponse(inputs, embed));
    const idx = await openIndex(vault);
    let knnQueries = 0;
    const knn = idx._knn.bind(idx);
    idx._knn = (...args) => { knnQueries++; return knn(...args); };

    const results = await idx.searchRaw({ query: "query", folder: "target", limit: 5 });

    assert.deepEqual(results.map(r => r.path).sort(), ["target/t1.md", "target/t2.md"]);
    assert.equal(knnQueries, 0, "no KNN widening for a folder smaller than the limit");
  });

  it("a folder reconcile that stops because the index is disabled leaves the remaining notes stale", async () => {
    const vault = await vaultWith({ "a.md": "Alpha body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.shutdown();
    const statsPath = statsFile(vault);
    const stats = JSON.parse(await fs.readFile(statsPath, "utf-8"));
    await fs.writeFile(statsPath, JSON.stringify({ ...stats, status: "disabled", reason: "quota", since: "2026-10-01T00:00:00Z" }));
    const watcher = fakeWatch();
    const disabled = await openIndex(vault, { watch: watcher.watch });
    for (let i = 0; i < 3; i++) {
      await fs.mkdir(path.join(vault, "drop"), { recursive: true });
      await fs.writeFile(path.join(vault, "drop", `n${i}.md`), `Dropped ${i}.`);
    }
    const before = fake.calls.length;

    watcher.emit("drop");
    await disabled.whenIdle();

    assert.equal(fake.calls.length, before);
    assert.equal(disabled.health().staleFiles, 3);
  });

  it("a symlinked note is not indexed as a note of its own", async (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privileges on Windows");
    const vault = await vaultWith({ "real.md": "Real body." });
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await fs.symlink("real.md", path.join(vault, "link.md"));

    await idx.reindexFile("link.md");

    assert.deepEqual(indexedPaths(idx), ["real.md"]);
  });

  describe("re-embedding only changed chunks", () => {
    const section = (name, filler) => `## ${name}\n\n${(`${name} ${filler} words. `).repeat(100)}\n\n`;
    const longNote = (fillers = ["one", "two", "three", "four", "five"]) =>
      "Intro line.\n\n" + fillers.map((f, i) => section(`Part${i}`, f)).join("");
    const sentTexts = (from = 0) => fake.calls.slice(from).flat();
    const rowsFor = (idx, rel) => idx.db.prepare("SELECT id, chunk_hash FROM chunks WHERE file_path = ? ORDER BY chunk_index").all(rel);
    const vecBytes = (idx, id) => Buffer.from(idx.db.prepare("SELECT embedding FROM vec_chunks WHERE rowid = ?").get(BigInt(id)).embedding);

    it("editing one section sends only that chunk and keeps the other vectors", async () => {
      const vault = await vaultWith({ "n.md": longNote() });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const before = rowsFor(idx, "n.md");
      assert.ok(before.length >= 5);
      const callsBefore = fake.calls.length;

      await fs.writeFile(path.join(vault, "n.md"), longNote(["one", "two", "CHANGED", "four", "five"]));
      await idx.reindexFile("n.md");

      const sent = sentTexts(callsBefore);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].includes("CHANGED"));
      const after = rowsFor(idx, "n.md");
      assert.equal(after.length, before.length);
      for (let i = 0; i < after.length; i++) {
        if (after[i].chunk_hash === before[i].chunk_hash) {
          assert.deepEqual(vecBytes(idx, after[i].id), vecBytes(idx, before[i].id));
        }
      }
      assert.equal(after.filter((r, i) => r.chunk_hash === before[i].chunk_hash).length, before.length - 1);
    });

    it("appending to a long note sends one chunk, or two when a new piece starts", async () => {
      const vault = await vaultWith({ "n.md": longNote() });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const callsBefore = fake.calls.length;

      await fs.appendFile(path.join(vault, "n.md"), "Closing words.\n");
      await idx.reindexFile("n.md");
      assert.equal(sentTexts(callsBefore).length, 1);

      const mid = fake.calls.length;
      await fs.appendFile(path.join(vault, "n.md"), section("Extra", "six"));
      await idx.reindexFile("n.md");
      assert.ok(sentTexts(mid).length <= 2);
      assert.ok(sentTexts(mid).length >= 1);
    });

    it("identical text in another note reuses the stored vector", async () => {
      const vault = await vaultWith({ "n.md": longNote() });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const callsBefore = fake.calls.length;

      // Same file name in another folder: every chunk text, title included, is identical.
      await fs.mkdir(path.join(vault, "sub"), { recursive: true });
      await fs.writeFile(path.join(vault, "sub", "n.md"), longNote());
      await idx.reindexFile("sub/n.md");

      assert.equal(sentTexts(callsBefore).length, 0);
      assert.equal(rowsFor(idx, "sub/n.md").length, rowsFor(idx, "n.md").length);
    });

    it("a note stays searchable while its new chunks are being embedded", async () => {
      const vault = await vaultWith({ "n.md": "Alpha original text about gardens." });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const gate = deferred();
      fake.handler = async (inputs) => {
        if (inputs.some(i => i.includes("REPLACED"))) await gate.promise;
        return embeddingsResponse(inputs);
      };

      await fs.writeFile(path.join(vault, "n.md"), "REPLACED text entirely.");
      const pending = idx.reindexFile("n.md");
      while (requestsMentioning("REPLACED") === 0) await new Promise(r => setTimeout(r, 5));
      const during = await idx.searchRaw({ query: "gardens", limit: 5, threshold: 0 });
      assert.deepEqual(during.map(r => r.path), ["n.md"]);

      gate.resolve();
      await pending;
    });

    it("a move keeps the vectors when the title is unchanged and re-sends on a rename", async () => {
      const vault = await vaultWith({ "n.md": longNote() });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const callsBefore = fake.calls.length;

      await fs.mkdir(path.join(vault, "archive"));
      await fs.rename(path.join(vault, "n.md"), path.join(vault, "archive", "n.md"));
      idx.notifyMoved("n.md", "archive/n.md");
      await idx.whenIdle();
      assert.equal(sentTexts(callsBefore).length, 0);
      assert.ok(rowsFor(idx, "archive/n.md").length >= 5);

      await fs.rename(path.join(vault, "archive", "n.md"), path.join(vault, "archive", "renamed.md"));
      idx.notifyMoved("archive/n.md", "archive/renamed.md");
      await idx.whenIdle();
      const sent = sentTexts(callsBefore);
      assert.ok(sent.length >= 5);
      assert.ok(sent.every(t => t.startsWith("renamed")));
      assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE file_path = 'archive/renamed.md'").get().n, sent.length);
    });

    it("startup catch-up with a changed mtime but the same content sends nothing", async () => {
      const vault = await vaultWith({ "n.md": longNote() });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      await idx.shutdown();
      const callsBefore = fake.calls.length;
      const touched = new Date("2026-10-03T10:00:00Z");
      await fs.utimes(path.join(vault, "n.md"), touched, touched);

      const reopened = await openIndex(vault);
      assert.equal(fake.calls.length, callsBefore);
      assert.equal(reopened.db.prepare("SELECT mtime_ms FROM files WHERE path = 'n.md'").get().mtime_ms, touched.getTime());
    });

    it("content changed on disk during the embed is not stored with stale chunks", async () => {
      const vault = await vaultWith({ "n.md": "Original body." });
      fake = installFakeOpenAI();
      const idx = await openIndex(vault);
      const gate = deferred();
      fake.handler = async (inputs) => {
        if (inputs.some(i => i.includes("FIRSTEDIT"))) await gate.promise;
        return embeddingsResponse(inputs);
      };

      await fs.writeFile(path.join(vault, "n.md"), "FIRSTEDIT body.");
      const pending = idx.reindexFile("n.md");
      while (requestsMentioning("FIRSTEDIT") === 0) await new Promise(r => setTimeout(r, 5));
      await fs.writeFile(path.join(vault, "n.md"), "SECONDEDIT body.");
      gate.resolve();
      await pending;

      const previews = idx.db.prepare("SELECT content_preview FROM chunks WHERE file_path = 'n.md'").all();
      assert.ok(!previews.some(r => r.content_preview.includes("FIRSTEDIT")));
      assert.ok(idx._stale.has("n.md"));
    });
  });
});

// ---------------------------------------------------------------------------
// Housekeeper roles: only the lease holder watches, syncs and writes
// ---------------------------------------------------------------------------
describe("SemanticIndex housekeeper roles", () => {
  let fake;
  const opened = [];
  const vaults = [];
  const stateDirs = [];

  function fakeWatch() {
    const watchers = [];
    const watch = (_dir, _opts, listener) => {
      const w = new EventEmitter();
      w.listener = listener;
      w.closed = false;
      w.close = () => { w.closed = true; };
      watchers.push(w);
      return w;
    };
    return { watchers, watch };
  }

  async function lease() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-roles-state-"));
    stateDirs.push(dir);
    return dir;
  }

  const realLease = (stateDir) => new HousekeeperLease({ stateDir, heartbeatMs: 20, staleMs: 10_000 });

  async function open(vaultPath, leaseObj, opts = {}) {
    const watcher = fakeWatch();
    const idx = newIndex({
      vaultPath, lease: leaseObj, openaiApiKey: "test-key", sleep: async () => {},
      watch: watcher.watch, debounceMs: 0, ...opts,
    });
    opened.push(idx);
    await idx.initialize();
    await idx.whenIdle();
    return { idx, watcher };
  }

  afterEach(async () => {
    for (const idx of opened.splice(0)) await idx.shutdown();
    fake?.restore();
    fake = null;
    for (const dir of [...vaults.splice(0), ...stateDirs.splice(0)]) await fs.rm(dir, { recursive: true, force: true });
  });

  async function vaultWith(files) {
    const dir = await makeVault(files);
    vaults.push(dir);
    return dir;
  }

  it("L5: a reader starts no watcher or catch-up, writes nothing and still answers searches from the holder's writes", async () => {
    fake = installFakeOpenAI();
    const vault = await vaultWith({ "a.md": "Alpha note about caching.", "b.md": "Beta note about gardens." });
    const state = await lease();
    const holderLease = realLease(state);
    const readerLease = realLease(state);
    assert.equal(await holderLease.tryAcquire(), true);
    assert.equal(await readerLease.tryAcquire(), false);

    const { idx: holder, watcher: holderWatch } = await open(vault, holderLease);
    assert.equal(holderWatch.watchers.length, 1);
    const callsAfterHolder = fake.calls.length;
    assert.ok(callsAfterHolder > 0);
    const statsBefore = await fs.readFile(statsFile(vault), "utf-8");

    await fs.writeFile(path.join(vault, "c.md"), "Gamma note, unseen by the reader.");
    const { idx: reader, watcher: readerWatch } = await open(vault, readerLease);
    assert.equal(readerWatch.watchers.length, 0);
    assert.equal(reader.watcher, null);
    assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 2);
    assert.equal(await reader.whenSynced(), null);

    reader.notifyChanged("c.md");
    await reader.notifyRemoved("a.md");
    reader.notifyMoved("b.md", "b2.md");
    await reader.whenIdle();
    assert.deepEqual(holder.db.prepare("SELECT path FROM files ORDER BY path").all().map(r => r.path), ["a.md", "b.md"]);
    assert.equal(fake.calls.length, callsAfterHolder);
    assert.equal(await fs.readFile(statsFile(vault), "utf-8"), statsBefore);

    const hits = await reader.searchRaw({ query: "caching", limit: 5 });
    assert.deepEqual(hits.map(h => h.path).sort(), ["a.md", "b.md"]);
    assert.equal(fake.calls.length, callsAfterHolder + 1);
  });

  it("a reader's probe checks the API but starts no sync and writes no stats", async () => {
    fake = installFakeOpenAI();
    const vault = await vaultWith({ "a.md": "Alpha." });
    const state = await lease();
    const first = realLease(state);
    await first.tryAcquire();
    const second = realLease(state);
    await second.tryAcquire();
    const { idx } = await open(vault, second);
    assert.equal(await idx.probe(), true);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0], ["ping"]);
    assert.equal(idx.health().status, "ok");
    assert.equal(fsSync.existsSync(statsFile(vault)), false);
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
  });

  it("starts the watcher and catch-up on acquisition and stops them when the lease is lost", async () => {
    fake = installFakeOpenAI();
    const vault = await vaultWith({ "a.md": "Alpha." });
    const state = await lease();
    const holderLease = realLease(state);
    await holderLease.tryAcquire();
    const mine = realLease(state);
    await mine.tryAcquire();
    const { idx, watcher } = await open(vault, mine);
    assert.equal(watcher.watchers.length, 0);

    await holderLease.release();
    assert.equal(await mine.tryAcquire(), true);
    await idx.whenIdle();
    for (let i = 0; i < 50 && watcher.watchers.length === 0; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(watcher.watchers.length, 1);
    await idx.whenSynced();
    await idx.whenIdle();
    assert.equal(idx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);

    mine._lose();
    for (let i = 0; i < 50 && !watcher.watchers[0].closed; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(watcher.watchers[0].closed, true);
    assert.equal(idx.watcher, null);
    const before = fake.calls.length;
    idx.notifyChanged("a.md");
    await idx.reindexFile("a.md");
    assert.equal(fake.calls.length, before);
  });

  it("shutdown releases the lease so another process can take over", async () => {
    fake = installFakeOpenAI();
    const vault = await vaultWith({ "a.md": "Alpha." });
    const state = await lease();
    const mine = realLease(state);
    await mine.tryAcquire();
    const { idx } = await open(vault, mine);
    const other = realLease(state);
    assert.equal(await other.tryAcquire(), false);
    await idx.shutdown();
    assert.equal(mine.isHolder, false);
    assert.equal(await other.tryAcquire(), true);
    await other.release();
  });
});

describe("SemanticIndex coverage health", () => {
  let fake;
  const opened = [];
  const vaults = [];
  const reader = () => ({ isHolder: false, onAcquired() {}, onLost() {}, async tryAcquire() { return false; }, async release() {} });
  const readStats = (vault) => JSON.parse(fsSync.readFileSync(statsFile(vault), "utf-8"));

  async function open(vault, lease) {
    const idx = newIndex({ vaultPath: vault, openaiApiKey: "test-key", sleep: async () => {}, lease });
    opened.push(idx);
    await idx.initialize();
    return idx;
  }

  afterEach(async () => {
    for (const idx of opened.splice(0)) await idx.shutdown();
    fake?.restore();
    fake = null;
    for (const dir of vaults.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  async function syncedVault(files) {
    const vault = await makeVault(files);
    vaults.push(vault);
    fake = installFakeOpenAI();
    const holder = await open(vault);
    await holder.whenSynced();
    return { vault, holder };
  }

  it("counts notes with a body, leaves out empty notes, and writes the counts to the stats file", async () => {
    const { vault, holder } = await syncedVault({ ...manyNotes(3), "empty.md": "" });
    const h = holder.health();
    assert.equal(h.notesTotal, 3);
    assert.equal(h.notesEmbedded, 3);
    assert.equal(h.chunksWaiting, 0);
    const stats = readStats(vault);
    assert.deepEqual(
      [stats.notes_total, stats.notes_embedded, stats.chunks_waiting, stats.oldest_wait_since, stats.shared_cache],
      [3, 3, 0, null, false],
    );
    assert.equal(stats.status, "ok");
  });

  it("a changed note whose embedding failed is not counted as embedded, and a new one counts in the total", async () => {
    const { vault, holder } = await syncedVault(manyNotes(2));
    await fs.writeFile(path.join(vault, "notes", "n00.md"), "Changed body.");
    await fs.writeFile(path.join(vault, "notes", "fresh.md"), "A brand new note.");
    fake.handler = () => errorResponse(500, "server error");
    await assert.rejects(() => holder.reindexFile("notes/n00.md"));
    await assert.rejects(() => holder.reindexFile("notes/fresh.md"));
    const h = holder.health();
    assert.equal(h.notesTotal, 3);
    assert.equal(h.notesEmbedded, 1);
  });

  it("a reader reports the holder's stats with counts from the local index, never complete by default", async () => {
    const { vault, holder } = await syncedVault(manyNotes(2));
    await fs.writeFile(path.join(vault, "notes", "n00.md"), "Changed body.");
    fake.handler = () => errorResponse(500, "server error");
    await assert.rejects(() => holder.reindexFile("notes/n00.md"));
    holder._writeStats();

    const r = await open(vault, reader());
    const h = r.health();
    assert.equal(h.notesTotal, 2);
    assert.equal(h.notesEmbedded, 1);
    assert.equal(h.staleFiles, 1);
  });

  it("a reader with no stats file reports no totals and no completeness", async () => {
    const { vault, holder } = await syncedVault(manyNotes(2));
    await holder.shutdown();
    fsSync.rmSync(statsFile(vault));
    const r = await open(vault, reader());
    const h = r.health();
    assert.equal(h.notesTotal, null);
    assert.equal(formatCoverageLine(h), null);
    assert.equal(fsSync.existsSync(statsFile(vault)), false, "a reader never writes stats");
  });

  it("a reader takes the disabled state from the holder's stats", async () => {
    const { vault, holder } = await syncedVault(manyNotes(1));
    await holder.shutdown();
    const stats = readStats(vault);
    fsSync.writeFileSync(statsFile(vault), JSON.stringify({ ...stats, status: "disabled", reason: "no credits", since: "2026-10-01T00:00:00.000Z" }));
    const r = await open(vault, reader());
    assert.equal(r.health().status, "disabled");
    assert.equal(r.health().reason, "no credits");
  });

  it("an old-format stats file is carried as not reported yet", async () => {
    const vault = await makeVault(manyNotes(1));
    vaults.push(vault);
    fsSync.mkdirSync(sidecarDir(vault), { recursive: true });
    fsSync.writeFileSync(statsFile(vault), JSON.stringify({ indexed_files: 1, vault_files: 1, status: "ok", stale_files: 0 }));
    fake = installFakeOpenAI(() => new Promise(() => {}));
    const idx = await open(vault);
    assert.equal(idx.health().notesTotal, null);
    assert.equal(readStats(vault).notes_total, null);
  });
});
