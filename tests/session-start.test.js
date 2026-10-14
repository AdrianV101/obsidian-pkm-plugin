import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

const SCRIPT = path.join(import.meta.dirname, "..", "hooks", "session-start.js");
// The hook reads ~/.claude/settings.json. A test's fake HOME is passed as USERPROFILE too (Windows
// takes the home directory from there); without one the hook gets a home that does not exist, so
// it never reads the real settings.
const NO_HOME = path.join(os.tmpdir(), `pkm-ss-no-home-${process.pid}`);

function runScript(args, env, stdinData) {
  const home = env.HOME && env.HOME !== process.env.HOME ? env.HOME : NO_HOME;
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { env: { ...env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"] });
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

  it("an unexpected failure exits 0 with the error on stderr, so it never surfaces as a hook error", async () => {
    // Valid JSON that is not an object: reading its fields throws outside every handled path.
    const { code, stderr } = await runScript([SCRIPT], { ...process.env, VAULT_PATH: vaultPath }, "null");
    assert.equal(code, 0, stderr);
    assert.match(stderr, /PKM SessionStart hook error: /);
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

describe("session-start.js context budget and semantic health", () => {
  let tmpDir, vaultPath, cwdDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-ss-health-"));
    vaultPath = path.join(tmpDir, "vault");
    const projectDir = path.join(vaultPath, "01-Projects", "MyApp");
    await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "development"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "_index.md"), "---\ntype: project\n---\n# MyApp\n\n## Overview\nINDEXBODY\n");
    await fs.writeFile(path.join(projectDir, "development", "devlog.md"), "## Sessions\n### 2026-10-08 10:00\nDEVLOGBODY\n");
    await fs.writeFile(path.join(projectDir, "tasks", "t.md"), "---\ntype: task\nstatus: active\npriority: high\n---\n# Ship it\n");
    cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(path.join(cwdDir, "CLAUDE.md"), "# PKM: 01-Projects/MyApp\n\n## PKM Integration\n\nConfigured.\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(input) {
    const { stdout } = await runScript([SCRIPT], { ...process.env, VAULT_PATH: vaultPath, HOME: tmpDir }, JSON.stringify(input));
    return JSON.parse(stdout);
  }

  it("passes the hook input's source through: \"compact\" loads only the project path and task titles", async () => {
    const result = await run({ cwd: cwdDir, source: "compact" });
    const context = result.hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith("## PKM Project Context: MyApp (compact)\nProject: 01-Projects/MyApp"), context);
    assert.ok(context.includes("- Ship it"));
    assert.ok(!context.includes("INDEXBODY") && !context.includes("DEVLOGBODY"));
    assert.ok(result.systemMessage.startsWith("Obsidian PKM: Loaded MyApp (compact, 1 task)"), result.systemMessage);
  });

  const statsCases = [
    {
      name: "ok",
      stats: { indexed_files: 50, vault_files: 50, status: "ok", reason: null, since: null, last_success_at: "2026-10-13T08:00:00.000Z", stale_files: 0 },
      summary: "| semantic: ok",
    },
    {
      name: "syncing with stale notes",
      stats: { indexed_files: 40, vault_files: 50, status: "syncing", reason: null, since: null, last_success_at: "2026-10-13T08:00:00.000Z", stale_files: 10 },
      summary: "| semantic: syncing, 10 notes stale",
    },
    {
      name: "disabled",
      stats: { indexed_files: 735, vault_files: 2469, status: "disabled", reason: "OpenAI quota exhausted. Add credits; it re-enables automatically.", since: "2026-07-03T09:12:00.000Z", last_success_at: "2026-07-02T22:00:00.000Z", stale_files: 1734 },
      summary: "| semantic: disabled since 2026-07-03 (OpenAI quota exhausted. Add credits; it re-enables automatically.), 1734 notes stale",
    },
  ];
  for (const c of statsCases) {
    it(`summary line shows semantic health: ${c.name}`, async () => {
      await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
      await fs.writeFile(path.join(vaultPath, ".obsidian", "semantic-stats.json"), JSON.stringify(c.stats));
      const result = await run({ cwd: cwdDir });
      assert.ok(result.systemMessage.endsWith(c.summary), result.systemMessage);
    });
  }
});
