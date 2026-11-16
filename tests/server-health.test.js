import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "fs/promises";
import path from "path";
import { makeVault } from "./fake-openai.js";

const CLI = path.join(import.meta.dirname, "..", "cli.js");
const PRELOAD = pathToFileURL(path.join(import.meta.dirname, "fake-fetch-quota.js")).href;

describe("server started with a persisted disabled semantic index", () => {
  let vault;
  let child;
  let stderr = "";
  const responses = new Map();

  function request(id, method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method}; stderr:\n${stderr}`)), 10000);
      const poll = () => {
        if (responses.has(id)) { clearTimeout(timer); resolve(responses.get(id)); } else setTimeout(poll, 20);
      };
      poll();
    });
  }

  before(async () => {
    vault = await makeVault({ "a.md": "Alpha body." });
    await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(vault, ".obsidian", "semantic-stats.json"), JSON.stringify({
      indexed_files: 0, vault_files: 1, status: "disabled",
      reason: "OpenAI quota exhausted. Add credits; it re-enables automatically.",
      since: "2026-07-03T09:12:00.000Z", last_success_at: null, stale_files: 1, updated_at: "2026-07-03T09:12:00.000Z",
    }));
    child = spawn(process.execPath, ["--import", PRELOAD, CLI], {
      env: { PATH: process.env.PATH, HOME: vault, VAULT_PATH: vault, VAULT_PKM_OPENAI_KEY: "sk-test" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (d) => { stderr += d; });
    let buffered = "";
    child.stdout.on("data", (d) => {
      buffered += d;
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim()) {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        }
      }
    });
    await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  });

  after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    await fs.rm(vault, { recursive: true, force: true });
  });

  it("logs the disabled status at startup instead of 'semantic search enabled'", () => {
    assert.ok(
      stderr.includes("semantic search disabled since 2026-07-03 (OpenAI quota exhausted. Add credits; it re-enables automatically.)"),
      stderr
    );
    assert.ok(!stderr.includes("semantic search enabled"), stderr);
  });

  it("still lists the semantic tools so a call can re-probe", async () => {
    const response = await request(2, "tools/list");
    const names = response.result.tools.map((t) => t.name);
    assert.ok(names.includes("vault_semantic_search"));
    assert.ok(names.includes("vault_suggest_links"));
  });
});
