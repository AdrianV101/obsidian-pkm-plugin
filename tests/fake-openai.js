// Shared fakes for tests that exercise the OpenAI embeddings boundary (globalThis.fetch).
import fs from "fs/promises";
import path from "path";
import os from "os";

const { Response } = globalThis;

export const DIMS = 3072;

// Body OpenAI returned for Adrian's account from 2026-07-03 (HTTP 429).
export const QUOTA_BODY = JSON.stringify({
  error: {
    message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
});

/** Deterministic 3072-dim vector derived from the text. */
export function fakeEmbedding(text) {
  const vec = new Array(DIMS).fill(0);
  for (let i = 0; i < Math.min(text.length, DIMS); i++) {
    vec[i] = (text.charCodeAt(i) % 100) / 100;
  }
  return vec;
}

export function embeddingsResponse(inputs, embed = fakeEmbedding) {
  return Response.json({ data: inputs.map((text, index) => ({ index, embedding: embed(text) })) });
}

export function errorResponse(status, body = "", headers = {}) {
  return new Response(body, { status, headers });
}

export const quotaResponse = () => errorResponse(429, QUOTA_BODY);

/**
 * Replace globalThis.fetch with a fake embeddings endpoint.
 * `handler(inputs, callNumber)` returns a Response (or a promise of one), or throws to
 * simulate a network failure. `calls` records the `input` array of every request.
 */
export function installFakeOpenAI(handler = (inputs) => embeddingsResponse(inputs)) {
  const original = globalThis.fetch;
  const calls = [];
  const fake = {
    calls,
    handler,
    restore() { globalThis.fetch = original; },
  };
  globalThis.fetch = async (_url, opts) => {
    const inputs = JSON.parse(opts.body).input;
    calls.push(inputs);
    return fake.handler(inputs, calls.length);
  };
  return fake;
}

/** A sleep that returns immediately and records the requested delays. */
export function recordingSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

/** Create a temp vault from { "rel/path.md": content }. */
export async function makeVault(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-vault-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

/** `count` notes named n00.md ... with distinct bodies. */
export function manyNotes(count, folder = "notes") {
  const files = {};
  for (let i = 0; i < count; i++) {
    const name = String(i).padStart(2, "0");
    files[`${folder}/n${name}.md`] = `---\ntype: note\n---\nNote number ${name} body text.\n`;
  }
  return files;
}
