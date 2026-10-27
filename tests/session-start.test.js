import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { makeRepo, makeProject } from "./git-fixture.js";

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
      "# PKM: 01-Projects/MyApp\n"
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

  it("returns context summary systemMessage when configured", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
    );

    const result = await runHook({ cwd: cwdDir });
    assert.ok(!result.systemMessage.includes("semantic"));
  });

  it("ignores malformed stats file gracefully", async () => {
    const cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(
      path.join(cwdDir, "CLAUDE.md"),
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
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
      "# PKM: 01-Projects/MyApp\n"
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
    await fs.mkdir(path.join(projectDir, "development", "devlog"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "development", "devlog", "2026-10-08 1000 Work.md"),
      "## 2026-10-08 10:00 Work\n\n### Summary\nDEVLOGBODY\n\n### Next steps\nMore.\n"
    );
    await fs.writeFile(path.join(projectDir, "tasks", "t.md"), "---\ntype: task\nstatus: active\npriority: high\n---\n# Ship it\n");
    cwdDir = path.join(tmpDir, "MyApp");
    await fs.mkdir(cwdDir, { recursive: true });
    await fs.writeFile(path.join(cwdDir, "CLAUDE.md"), "# PKM: 01-Projects/MyApp\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(input) {
    const { stdout } = await runScript([SCRIPT], { ...process.env, VAULT_PATH: vaultPath, HOME: tmpDir }, JSON.stringify(input));
    return JSON.parse(stdout);
  }

  it("passes the hook input's source through: \"compact\" lists session names only", async () => {
    const result = await run({ cwd: cwdDir, source: "compact" });
    const context = result.hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith("## PKM Project Context: 01-Projects/MyApp (compact)\n### Recent sessions\n- 2026-10-08 1000 Work"), context);
    assert.ok(!context.includes("Project: 01-Projects/MyApp"), context);
    assert.ok(!context.includes("INDEXBODY") && !context.includes("DEVLOGBODY"));
    assert.ok(result.systemMessage.startsWith("Obsidian PKM: Loaded MyApp (compact)"), result.systemMessage);
  });

  it("the status line reports the index and the devlog item count, and ignores task notes", async () => {
    const result = await run({ cwd: cwdDir });
    const context = result.hookSpecificOutput.additionalContext;
    assert.ok(result.systemMessage.startsWith("Obsidian PKM: Loaded MyApp (index, 1 devlog item) \u2014 "), result.systemMessage);
    assert.ok(!result.systemMessage.includes("task") && !result.systemMessage.includes("missing"));
    assert.ok(context.includes("#### 2026-10-08 1000 Work") && context.includes("DEVLOGBODY"));
    assert.ok(!context.includes("Ship it") && !context.includes("Active Tasks"));

    const dir = path.join(vaultPath, "01-Projects", "MyApp", "development", "devlog");
    await fs.writeFile(path.join(dir, "2026-10-09 1000 More.md"), "## 2026-10-09 10:00 More\n\nBody.\n");
    assert.ok((await run({ cwd: cwdDir })).systemMessage.startsWith("Obsidian PKM: Loaded MyApp (index, 2 devlog items) \u2014 "));
  });

  it("the status line lists devlog as missing when there are no items", async () => {
    await fs.rm(path.join(vaultPath, "01-Projects", "MyApp", "development"), { recursive: true });
    const result = await run({ cwd: cwdDir });
    assert.ok(result.systemMessage.startsWith("Obsidian PKM: Loaded MyApp (index) [missing: devlog] \u2014 "), result.systemMessage);
    assert.ok(result.hookSpecificOutput.additionalContext.includes("No devlog entries found."));
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

describe("session-start.js project resolution output", () => {
  const HINT = "vault-pkm: this repo isn't linked to a vault project. Run /vault-pkm:init-project to link it.";
  let tmpDir, vaultPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-ss-res-"));
    vaultPath = path.join(tmpDir, "vault");
    await makeProject(vaultPath, "MyApp", "repos: [github.com/acme/myapp]");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(input, env = {}) {
    const res = await runScript([SCRIPT], { ...process.env, VAULT_PATH: vaultPath, ...env }, JSON.stringify(input));
    return { ...res, json: res.stdout.trim() ? JSON.parse(res.stdout) : null };
  }

  const linkedCases = [
    {
      name: "folder name",
      setup: async () => {
        const cwd = path.join(tmpDir, "myapp");
        await fs.mkdir(cwd);
        return cwd;
      },
      via: /\(via folder name: myapp\)/,
    },
    {
      name: "annotation",
      setup: async () => {
        const cwd = path.join(tmpDir, "elsewhere");
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# PKM: 01-Projects/MyApp\n");
        return cwd;
      },
      via: /\(via # PKM in .*CLAUDE\.md\)/,
    },
    {
      name: "repos",
      setup: async () => makeRepo(path.join(tmpDir, "checkout"), { origin: "git@github.com:acme/myapp.git" }),
      via: /\(via repos: github\.com\/acme\/myapp\)/,
    },
  ];
  for (const c of linkedCases) {
    it(`a folder linked by ${c.name} says how in the summary and names the full path in the header`, async () => {
      const cwd = await c.setup();
      const { json } = await run({ cwd });
      assert.ok(json.hookSpecificOutput.additionalContext.startsWith("## PKM Project Context: 01-Projects/MyApp\n"));
      assert.match(json.systemMessage, /^Obsidian PKM: Loaded MyApp /);
      assert.match(json.systemMessage, c.via);
      assert.match(json.systemMessage, / chars \(via /);
    });
  }

  it("an unlinked git repo gets exactly the hint as a systemMessage", async () => {
    const cwd = await makeRepo(path.join(tmpDir, "other"), { origin: "git@github.com:acme/other.git" });
    const { json, code } = await run({ cwd });
    assert.equal(code, 0);
    assert.deepEqual(json, { systemMessage: HINT });
  });

  it("an ambiguous remote gets the hint plus a reason naming both projects, and no context", async () => {
    await makeProject(vaultPath, "Twin", "repos: [github.com/acme/myapp]");
    const cwd = await makeRepo(path.join(tmpDir, "checkout"), { origin: "https://github.com/acme/myapp.git" });
    const { json } = await run({ cwd });
    assert.equal(json.hookSpecificOutput, undefined);
    assert.ok(json.systemMessage.startsWith(`${HINT} (`), json.systemMessage);
    assert.ok(json.systemMessage.includes("01-Projects/MyApp") && json.systemMessage.includes("01-Projects/Twin"), json.systemMessage);
    assert.ok(json.systemMessage.endsWith(")"));
  });

  it("an invalid annotation outside git gets a systemMessage naming it, and no context", async () => {
    const cwd = path.join(tmpDir, "plain");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# PKM: 01-Projects/Missing\n");
    const { json } = await run({ cwd });
    assert.deepEqual(Object.keys(json), ["systemMessage"]);
    assert.match(json.systemMessage, /^vault-pkm: .*Missing.*\.$/);
  });

  it("a non-git folder with no match produces no output and exits 0", async () => {
    const cwd = path.join(tmpDir, "nomatch");
    await fs.mkdir(cwd);
    const { stdout, code, stderr } = await run({ cwd });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "");
  });

  it("a linked project whose CLAUDE.md has no PKM Integration section gets its context and no setup nudge", async () => {
    const cwd = path.join(tmpDir, "myapp");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# MyApp\n\nSome instructions.\n");
    const { json } = await run({ cwd });
    const context = json.hookSpecificOutput.additionalContext;
    assert.ok(context.includes("## PKM Project Context: 01-Projects/MyApp"));
    assert.ok(!/not configured|PKM Integration|init-project/.test(context + json.systemMessage));
  });

  it("a VAULT_PATH that does not exist gets a systemMessage naming VAULT_PATH, and no context", async () => {
    const cwd = path.join(tmpDir, "myapp");
    await fs.mkdir(cwd);
    const { json } = await run({ cwd }, { VAULT_PATH: path.join(tmpDir, "missing-vault") });
    assert.deepEqual(Object.keys(json), ["systemMessage"]);
    assert.match(json.systemMessage, /^vault-pkm: .*VAULT_PATH.*\.$/);
  });

  it("credentials in the origin URL never reach the output", async () => {
    const remote = "https://deploy:s3cr3t-token@github.com/acme/%s.git";
    const cases = [
      await makeRepo(path.join(tmpDir, "unlinked"), { origin: remote.replace("%s", "other") }),
      await makeRepo(path.join(tmpDir, "linked"), { origin: remote.replace("%s", "myapp") }),
    ];
    await makeProject(vaultPath, "Twin", "repos: [github.com/acme/myapp]");
    const ambiguous = await makeRepo(path.join(tmpDir, "ambiguous"), { origin: remote.replace("%s", "myapp") });
    for (const cwd of [...cases, ambiguous]) {
      const { stdout, stderr } = await run({ cwd });
      assert.ok(!/s3cr3t|deploy:/.test(stdout + stderr), `${cwd}: ${stdout}${stderr}`);
    }
  });
});
