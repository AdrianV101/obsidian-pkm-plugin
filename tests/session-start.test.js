import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

const SCRIPT = path.join(import.meta.dirname, "..", "hooks", "session-start.js");

function runScript(args, env, stdinData) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    if (stdinData !== null && stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

describe("session-start.js", () => {
  let tmpDir, vaultPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-ss-"));
    vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(path.join(vaultPath, "01-Projects", "MyApp", "development"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "01-Projects", "MyApp", "tasks"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, "01-Projects", "MyApp", "_index.md"),
      "---\ntype: project\ncreated: 2026-01-01\ntags: [project]\n---\n# MyApp"
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runHook(input, env = {}) {
    const { stdout } = await runScript(
      [SCRIPT],
      { ...process.env, VAULT_PATH: vaultPath, ...env },
      JSON.stringify(input)
    );
    return JSON.parse(stdout);
  }

  it("loads project context for matching cwd", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.hookSpecificOutput.additionalContext.includes("MyApp"));
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("MyApp"));
    assert.ok(result.systemMessage.includes("chars"));
  });

  it("returns JSON error for invalid JSON input", async () => {
    const { stdout } = await runScript(
      [SCRIPT],
      { ...process.env, VAULT_PATH: vaultPath },
      "not json"
    );
    const result = JSON.parse(stdout);
    assert.ok(result.hookSpecificOutput.additionalContext.includes("could not parse"));
  });

  it("returns JSON warning when VAULT_PATH not set", async () => {
    const { stdout } = await runScript(
      [SCRIPT],
      { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: process.env.NODE_PATH },
      JSON.stringify({ cwd: "/tmp" })
    );
    const result = JSON.parse(stdout);
    assert.ok(result.hookSpecificOutput.additionalContext.includes("VAULT_PATH"));
  });

  it("returns JSON error when cwd is missing", async () => {
    const result = await runHook({});
    assert.ok(result.hookSpecificOutput.additionalContext.includes("cwd"));
  });

  it("returns JSON error with systemMessage when project not found", async () => {
    const result = await runHook({ cwd: "/home/user/Projects/unknown" });
    assert.ok(result.hookSpecificOutput.additionalContext.includes("No vault project found"));
    assert.ok(result.hookSpecificOutput.additionalContext.includes("init-project"));
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("init-project"));
  });

  it("returns systemMessage when CLAUDE.md has no PKM Integration section", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(path.join(cwdDir, "CLAUDE.md"), "# MyApp\n\nSome instructions.\n");

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("init-project"));
    assert.ok(result.hookSpecificOutput.additionalContext.includes("not configured"));
    assert.ok(result.hookSpecificOutput.additionalContext.includes("PKM Project Context"));
  });

  it("returns systemMessage when no CLAUDE.md exists", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("init-project"));
  });

  it("returns context summary systemMessage when configured", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage);
    assert.ok(result.systemMessage.includes("MyApp"));
    assert.ok(result.systemMessage.includes("chars"));
    assert.ok(result.hookSpecificOutput.additionalContext.includes("MyApp"));
  });

  it("includes semantic stats in systemMessage when stats file exists", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "semantic-stats.json"),
      JSON.stringify({ indexed_files: 42, total_chunks: 100, vault_files: 50, last_sync: null })
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage.includes("semantic: 42/50 notes"));
  });

  it("shows simple count when all notes indexed", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "semantic-stats.json"),
      JSON.stringify({ indexed_files: 50, total_chunks: 120, vault_files: 50, last_sync: null })
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage.includes("semantic: 50 notes"));
    assert.ok(!result.systemMessage.includes("50/50"));
  });

  it("omits semantic stats when stats file missing", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(!result.systemMessage.includes("semantic"));
  });

  it("ignores malformed stats file gracefully", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "semantic-stats.json"),
      "not valid json"
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(result.systemMessage);
    assert.ok(!result.systemMessage.includes("semantic"));
  });

  it("warns when settings.json VAULT_PATH differs from env VAULT_PATH", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    // Create a fake HOME with .claude/settings.json pointing to a different vault
    const fakeHome = path.join(tmpDir, "fakehome");
    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { VAULT_PATH: "/some/other/vault" } })
    );

    const { stdout } = await runScript(
      [SCRIPT],
      { ...process.env, VAULT_PATH: vaultPath, HOME: fakeHome },
      JSON.stringify({ cwd: cwdDir })
    );
    const result = JSON.parse(stdout);
    assert.ok(
      result.hookSpecificOutput.additionalContext.includes("VAULT_PATH may be stale"),
      "should contain stale VAULT_PATH warning"
    );
    assert.ok(
      result.hookSpecificOutput.additionalContext.includes("/some/other/vault"),
      "should mention the settings.json vault path"
    );
  });

  it("does not warn when settings.json VAULT_PATH matches env VAULT_PATH", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    // Create a fake HOME with .claude/settings.json matching the actual vault path
    const fakeHome = path.join(tmpDir, "fakehome");
    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { VAULT_PATH: vaultPath } })
    );

    const { stdout } = await runScript(
      [SCRIPT],
      { ...process.env, VAULT_PATH: vaultPath, HOME: fakeHome },
      JSON.stringify({ cwd: cwdDir })
    );
    const result = JSON.parse(stdout);
    assert.ok(
      !result.hookSpecificOutput.additionalContext.includes("VAULT_PATH may be stale"),
      "should not contain stale VAULT_PATH warning when paths match"
    );
  });

  it("does not warn when settings.json is missing", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n"
    );

    // Create a fake HOME with no .claude/settings.json
    const fakeHome = path.join(tmpDir, "fakehome-empty");
    await fs.mkdir(fakeHome, { recursive: true });

    const { stdout } = await runScript(
      [SCRIPT],
      { ...process.env, VAULT_PATH: vaultPath, HOME: fakeHome },
      JSON.stringify({ cwd: cwdDir })
    );
    const result = JSON.parse(stdout);
    assert.ok(
      !result.hookSpecificOutput.additionalContext.includes("VAULT_PATH may be stale"),
      "should not warn when settings.json does not exist"
    );
  });
});
