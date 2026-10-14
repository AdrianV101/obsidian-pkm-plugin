import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  SemanticIndex,
  chunkNote,
  splitByHeadings,
  splitByParagraphs,
  getPreview,
  contentHash,
  callEmbeddingAPI,
  classifyEmbeddingError,
  EmbeddingError,
} from "../embeddings.js";
import {
  QUOTA_BODY,
  embeddingsResponse,
  errorResponse,
  installFakeOpenAI,
  recordingSleep,
  quotaResponse,
  makeVault,
  manyNotes,
} from "./fake-openai.js";

const { Response, Headers } = globalThis;

// ---------------------------------------------------------------------------
// chunkNote(content, filePath)
// ---------------------------------------------------------------------------
describe("chunkNote", () => {
  it("short note (under chunk limit) returns single chunk with title prefix", () => {
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n\nHello world.";
    const chunks = chunkNote(content, "notes/greeting.md");
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.startsWith("# greeting\n\n"));
    assert.ok(chunks[0].text.includes("Hello world."));
    assert.equal(chunks[0].heading, null);
    assert.ok(chunks[0].preview.length > 0);
  });

  it("note with multiple ## headings splits by heading", () => {
    // Build a body with headings that exceeds the chunk size limit.
    const longBody = "## Intro\n\n" + "A ".repeat(3000) + "\n\n## Details\n\n" + "B ".repeat(3000);
    const content = "---\ntype: note\n---\n\n" + longBody;
    const chunks = chunkNote(content, "project/analysis.md");
    assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
    // Each chunk should be prefixed with the title
    for (const chunk of chunks) {
      assert.ok(chunk.text.startsWith("# analysis\n\n"));
    }
    // First chunk heading should be null (content before first ##) or "Intro"
    const headings = chunks.map(c => c.heading);
    assert.ok(headings.includes("Intro"));
    assert.ok(headings.includes("Details"));
  });

  it("very long section falls back to paragraph splitting", () => {
    // Create a single ## section that exceeds MAX_CHARS_PER_CHUNK
    const longParagraph1 = "Word ".repeat(1000);
    const longParagraph2 = "Text ".repeat(1000);
    const longBody = "## Big Section\n\n" + longParagraph1 + "\n\n" + longParagraph2;
    const content = "---\ntype: note\n---\n\n" + longBody;
    const chunks = chunkNote(content, "notes/big.md");
    assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
    // Paragraph-split chunks get numbered headings like "Big Section (1)"
    const numbered = chunks.filter(c => c.heading && /\(\d+\)/.test(c.heading));
    assert.ok(numbered.length >= 2, "expected numbered heading chunks from paragraph splitting");
  });

  it("empty body returns empty array", () => {
    const content = "---\ntype: note\n---\n\n";
    const chunks = chunkNote(content, "notes/empty.md");
    assert.equal(chunks.length, 0);
  });

  it("body with only whitespace returns empty array", () => {
    const content = "---\ntype: note\n---\n\n   \n  \n   ";
    const chunks = chunkNote(content, "notes/whitespace.md");
    assert.equal(chunks.length, 0);
  });

  it("content without frontmatter uses full content as body", () => {
    const content = "Just some plain text.";
    const chunks = chunkNote(content, "notes/plain.md");
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.includes("Just some plain text."));
  });

  it("ignores --- mid-line in frontmatter value (does not include frontmatter in chunks)", () => {
    // Frontmatter with --- mid-line should be properly stripped from chunk body
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\ndescription: This --- is mid-line\n---\n\nBody content here.";
    const chunks = chunkNote(content, "notes/test.md");
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.includes("Body content here."));
    assert.ok(!chunks[0].text.includes("description:"), "frontmatter should be stripped");
    assert.ok(!chunks[0].text.includes("This --- is mid-line"), "frontmatter value with --- should be stripped");
  });
});

// ---------------------------------------------------------------------------
// splitByHeadings(body)
// ---------------------------------------------------------------------------
describe("splitByHeadings", () => {
  it("text with no ## headings returns array with single element", () => {
    const sections = splitByHeadings("Just plain text\nwith multiple lines.");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
    assert.ok(sections[0].text.includes("Just plain text"));
  });

  it("multiple ## headings split correctly", () => {
    const body = "## First\n\nContent one.\n\n## Second\n\nContent two.";
    const sections = splitByHeadings(body);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading, "First");
    assert.ok(sections[0].text.includes("Content one."));
    assert.equal(sections[1].heading, "Second");
    assert.ok(sections[1].text.includes("Content two."));
  });

  it("content before first heading is preserved as first element", () => {
    const body = "Preamble text.\n\n## First Heading\n\nHeading content.";
    const sections = splitByHeadings(body);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading, null);
    assert.ok(sections[0].text.includes("Preamble text."));
    assert.equal(sections[1].heading, "First Heading");
  });

  it("### headings are NOT split points (only ## level)", () => {
    const body = "## Main\n\nSome text.\n\n### Sub\n\nSub text.";
    const sections = splitByHeadings(body);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, "Main");
    assert.ok(sections[0].text.includes("### Sub"));
    assert.ok(sections[0].text.includes("Sub text."));
  });

  it("empty string returns single empty-text section", () => {
    const sections = splitByHeadings("");
    assert.equal(sections.length, 1);
    assert.equal(sections[0].heading, null);
    assert.equal(sections[0].text, "");
  });
});

// ---------------------------------------------------------------------------
// splitByParagraphs(text, maxChars)
// ---------------------------------------------------------------------------
describe("splitByParagraphs", () => {
  it("text under maxChars returns single chunk", () => {
    const text = "Short paragraph.";
    const chunks = splitByParagraphs(text, 1000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Short paragraph.");
  });

  it("text over maxChars splits at double-newline paragraph boundaries", () => {
    const para1 = "A".repeat(500);
    const para2 = "B".repeat(500);
    const text = para1 + "\n\n" + para2;
    const chunks = splitByParagraphs(text, 600);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], para1);
    assert.equal(chunks[1], para2);
  });

  it("single long paragraph with no breaks is hard-split at maxChars", () => {
    const text = "X".repeat(2000);
    const chunks = splitByParagraphs(text, 500);
    assert.equal(chunks.length, 4);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 500);
    }
    assert.equal(chunks.join(""), text);
  });

  it("multiple paragraphs are combined up to maxChars", () => {
    const text = "A".repeat(100) + "\n\n" + "B".repeat(100) + "\n\n" + "C".repeat(100);
    const chunks = splitByParagraphs(text, 250);
    // First chunk: A + B = 200 + 2 (separator) = 202, fits under 250
    // Adding C would be 202 + 100 + 2 = 304 > 250, so C becomes second chunk
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].includes("A"));
    assert.ok(chunks[0].includes("B"));
    assert.equal(chunks[1], "C".repeat(100));
  });
});

// ---------------------------------------------------------------------------
// getPreview(text)
// ---------------------------------------------------------------------------
describe("getPreview", () => {
  it("short text (under 100 words) returned unchanged (after stripping heading markers)", () => {
    const text = "This is a short preview.";
    const preview = getPreview(text);
    assert.equal(preview, "This is a short preview.");
  });

  it("long text truncated with '...' appended", () => {
    const words = [];
    for (let i = 0; i < 200; i++) words.push(`word${i}`);
    const text = words.join(" ");
    const preview = getPreview(text);
    assert.ok(preview.endsWith("..."));
    // Should contain first 100 words
    assert.ok(preview.includes("word0"));
    assert.ok(preview.includes("word99"));
    assert.ok(!preview.includes("word100 "));
  });

  it("empty string returns empty string", () => {
    const preview = getPreview("");
    assert.equal(preview, "");
  });

  it("strips markdown heading markers from preview", () => {
    const text = "## Section Title\n\nSome content here.";
    const preview = getPreview(text);
    assert.ok(!preview.startsWith("##"));
    assert.ok(preview.includes("Section Title"));
    assert.ok(preview.includes("Some content here."));
  });
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
  const DIMS = 3072;
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

    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath,
    });
    await idx.initialize();

    const statsPath = path.join(tmpDir, ".obsidian", "semantic-stats.json");
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
    const idx = new SemanticIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-stats-noop.db"),
    });
    // db is null (not initialized)
    idx._writeStats(); // should not throw
  });

  it("isAvailable is false without API key", async () => {
    const idx = new SemanticIndex({
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

    const idx = new SemanticIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-reindex.db"),
    });
    await idx.initialize();
    // Wait briefly for startup sync to finish or abort it
    await idx.shutdown();

    // Re-open with a clean DB to isolate reindexFile behavior
    const idx2 = new SemanticIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-reindex2.db"),
    });
    await idx2.initialize();
    await idx2.shutdown();

    // Re-open without startup sync side effects
    const dbPath = path.join(tmpDir, "test-reindex-isolated.db");
    const idx3 = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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

    const idx = new SemanticIndex({
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

    const idx = new SemanticIndex({
      vaultPath: tmpDir,
      openaiApiKey: "test-key",
      dbPath: path.join(tmpDir, "test-noop.db"),
    });
    // Don't initialize - db is null
    await idx.reindexFile("notes/note-a.md");
    // Should not throw
  });

  it("removeFile() is a no-op when db is null", () => {
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
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
    const idx = new SemanticIndex({
      vaultPath,
      openaiApiKey: "test-key",
      dbPath: path.join(vaultPath, ".obsidian", "test-index.db"),
      sleep: async () => {},
    });
    opened.push(idx);
    await idx.initialize();
    return idx;
  }

  async function readStats(vaultPath) {
    return JSON.parse(await fs.readFile(path.join(vaultPath, ".obsidian", "semantic-stats.json"), "utf-8"));
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

  it("search output gains a stale footer only when notes are stale", async () => {
    const vault = await vaultWith(manyNotes(2));
    fake = installFakeOpenAI();
    const idx = await openIndex(vault);
    await idx.whenSynced();
    const footer = "*1 note has changed since last indexed; results may be stale.*";

    assert.ok(!(await idx.search({ query: "note" })).includes("changed since last indexed"));

    await fs.writeFile(path.join(vault, "notes", "n00.md"), "Changed body.");
    fake.handler = () => errorResponse(500, "server error");
    await assert.rejects(() => idx.reindexFile("notes/n00.md"));
    fake.handler = (inputs) => embeddingsResponse(inputs);

    assert.ok((await idx.search({ query: "note" })).endsWith(footer));
  });
});
