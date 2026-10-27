import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { makeRepo, makeProject } from "./git-fixture.js";

const CLI = path.join(import.meta.dirname, "..", "cli.js");
const KEY_VARS = ["VAULT_PKM_OPENAI_KEY", "OBSIDIAN_PKM_OPENAI_KEY", "OPENAI_API_KEY"];

// Fresh per test. doctor reads ~/.claude/settings.json, so every run gets a fake
// home: the developer's real settings must never leak into these assertions.
let fakeHome;

function runDoctor(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, "doctor"], {
      cwd,
      env: { ...(env || process.env), HOME: fakeHome, USERPROFILE: fakeHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end();
  });
}

describe("doctor command", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-doctor-"));
    fakeHome = path.join(tmpDir, "home");
    await fs.mkdir(fakeHome);
  });

  async function writeSettings(settings) {
    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, ".claude", "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings)
    );
  }

  function envWithout(...names) {
    const env = { ...process.env };
    for (const name of names) delete env[name];
    return env;
  }

  async function makeVault(name = "vault") {
    const vaultPath = path.join(tmpDir, name);
    await fs.mkdir(vaultPath, { recursive: true });
    return vaultPath;
  }

  describe("settings.json fallback", () => {
    it("reads a variable missing from the environment from ~/.claude/settings.json and names that source", async () => {
      const vaultPath = await makeVault();

      await writeSettings({ env: { VAULT_PATH: vaultPath } });
      const fromSettingsPath = await runDoctor(envWithout("VAULT_PATH"));
      assert.ok(
        fromSettingsPath.stdout.includes(`✓ VAULT_PATH: ${vaultPath} (from ~/.claude/settings.json)`),
        fromSettingsPath.stdout
      );
      assert.ok(fromSettingsPath.stdout.includes("✓ Vault is a directory"), "vault checks use the settings.json path");

      await writeSettings({ env: { VAULT_PKM_OPENAI_KEY: "sk-from-settings" } });
      const fromSettingsKey = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: vaultPath });
      assert.ok(
        fromSettingsKey.stdout.includes("✓ VAULT_PKM_OPENAI_KEY set (from ~/.claude/settings.json"),
        fromSettingsKey.stdout
      );
      assert.ok(!fromSettingsKey.stdout.includes("sk-from-settings"), "key value is never printed");
    });

    it("prefers the process environment over settings.json and says so", async () => {
      const vaultPath = await makeVault();
      const otherVault = await makeVault("other");
      await writeSettings({ env: { VAULT_PATH: otherVault, VAULT_PKM_OPENAI_KEY: "sk-from-settings" } });

      const { stdout } = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: vaultPath, VAULT_PKM_OPENAI_KEY: "sk-from-env" });
      assert.ok(stdout.includes(`✓ VAULT_PATH: ${vaultPath} (from environment)`), stdout);
      assert.ok(stdout.includes("✓ VAULT_PKM_OPENAI_KEY set (from environment"), stdout);
      assert.ok(!stdout.includes("sk-from-env") && !stdout.includes("sk-from-settings"), "key values are never printed");
    });

    it("warns when the environment and settings.json both set VAULT_PATH or the key to different values, naming both sources and never the values", async () => {
      const vaultPath = await makeVault();
      const otherVault = await makeVault("other");
      await writeSettings({ env: { VAULT_PATH: otherVault, VAULT_PKM_OPENAI_KEY: "sk-from-settings" } });

      const differing = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: vaultPath, VAULT_PKM_OPENAI_KEY: "sk-from-env" });
      assert.ok(
        differing.stdout.includes("⚠ VAULT_PATH differs between the environment and ~/.claude/settings.json; using the environment value"),
        differing.stdout
      );
      assert.ok(
        differing.stdout.includes("⚠ VAULT_PKM_OPENAI_KEY differs between the environment and ~/.claude/settings.json; using the environment value"),
        differing.stdout
      );
      assert.ok(!differing.stdout.includes("sk-from-env") && !differing.stdout.includes("sk-from-settings"), "key values are never printed");

      await writeSettings({ env: { VAULT_PATH: vaultPath, VAULT_PKM_OPENAI_KEY: "sk-same" } });
      const agreeing = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: vaultPath, VAULT_PKM_OPENAI_KEY: "sk-same" });
      assert.ok(!agreeing.stdout.includes("differs"), "no warning when both sources agree");

      await writeSettings({ env: { VAULT_PATH: otherVault } });
      const onlyEnv = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: otherVault });
      assert.ok(!onlyEnv.stdout.includes("differs"), "no warning when only one source is set");
    });

    it("applies the server's key-name precedence across sources: settings VAULT_PKM_OPENAI_KEY beats environment OPENAI_API_KEY", async () => {
      const vaultPath = await makeVault();
      await writeSettings({ env: { VAULT_PKM_OPENAI_KEY: "sk-from-settings" } });

      const { stdout } = await runDoctor({ ...envWithout(...KEY_VARS), VAULT_PATH: vaultPath, OPENAI_API_KEY: "sk-shell" });
      assert.ok(stdout.includes("✓ VAULT_PKM_OPENAI_KEY set (from ~/.claude/settings.json"), stdout);
    });

    it("treats a settings.json without an env block as providing nothing and says where it looked", async () => {
      await writeSettings({ permissions: { allow: [] } });

      const { stdout } = await runDoctor(envWithout("VAULT_PATH"));
      assert.ok(stdout.includes("⚠ VAULT_PATH not set in the environment or ~/.claude/settings.json"), stdout);
      assert.ok(!stdout.includes("Could not read"), stdout);
    });

    it("never echoes file content when settings.json fails to parse", async () => {
      // An unquoted value makes V8's parse error embed a snippet of the source text.
      await writeSettings('{"env": {"VAULT_PKM_OPENAI_KEY": sk-leak-canary-123456}}');

      const { stdout, stderr } = await runDoctor(envWithout("VAULT_PATH"));
      assert.ok(stdout.includes("⚠ Could not read ~/.claude/settings.json"), stdout);
      for (const out of [stdout, stderr]) {
        assert.ok(!out.includes("sk-leak"), "no file content in output");
        assert.ok(!out.includes("123456"), "no file content in output");
      }
    });

    it("warns about an unparseable settings.json and still finishes the checklist", async () => {
      await writeSettings("{ not json");

      const { stdout } = await runDoctor(envWithout("VAULT_PATH"));
      assert.ok(stdout.includes("⚠ Could not read ~/.claude/settings.json"), stdout);
      assert.ok(stdout.includes("⚠ VAULT_PATH not set"), stdout);
      assert.ok(stdout.includes("passed"), "summary line still printed");
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes vault checks with a valid vault and templates", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    const templatesDir = path.join(vaultPath, "05-Templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(
      path.join(templatesDir, "note.md"),
      "---\ntype: note\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\ntags: []\n---\n"
    );
    await fs.writeFile(
      path.join(templatesDir, "adr.md"),
      "---\ntype: adr\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\ntags: []\n---\n"
    );

    const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: vaultPath });
    assert.ok(stdout.includes("obsidian-pkm doctor"), "should print header");
    assert.ok(stdout.includes("\u2713 VAULT_PATH:"), "should show VAULT_PATH as passed");
    assert.ok(stdout.includes("\u2713 Vault is a directory"), "should confirm vault is a directory");
    assert.ok(stdout.includes("2 templates in 05-Templates/"), "should count templates");
    assert.ok(stdout.includes("\u2713 Node.js"), "should check Node.js version");
  });

  it("fails when vault directory does not exist", async () => {
    const badPath = path.join(tmpDir, "nonexistent");
    const { stdout, code } = await runDoctor({ ...process.env, VAULT_PATH: badPath });
    assert.ok(stdout.includes("\u2717 Vault directory does not exist"), "should report missing vault");
    assert.ok(code !== 0 || stdout.includes("failed"), "should indicate failure");
  });

  it("warns when VAULT_PATH is not set", async () => {
    const env = { ...process.env };
    delete env.VAULT_PATH;
    const { stdout } = await runDoctor(env);
    assert.ok(stdout.includes("\u26A0 VAULT_PATH not set"), "should warn about missing VAULT_PATH");
  });

  it("warns when no templates exist", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });
    // No 05-Templates/ directory

    const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: vaultPath });
    assert.ok(
      stdout.includes("\u26A0") && stdout.includes("template"),
      "should warn about missing templates"
    );
  });

  it("warns about missing vault templates even though bundled ones exist", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(path.join(vaultPath, "05-Templates"), { recursive: true });

    const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: vaultPath });
    assert.match(stdout, /\u26A0 No templates found in 05-Templates\//);
    assert.ok(!/\d+ templates? in 05-Templates/.test(stdout));
  });

  it("warns when VAULT_PKM_OPENAI_KEY is not set", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });

    const env = { ...process.env, VAULT_PATH: vaultPath };
    delete env.VAULT_PKM_OPENAI_KEY;
    delete env.OBSIDIAN_PKM_OPENAI_KEY;
    delete env.OPENAI_API_KEY;
    const { stdout } = await runDoctor(env);
    assert.ok(
      stdout.includes("\u26A0 VAULT_PKM_OPENAI_KEY not set"),
      "should warn about missing API key"
    );
  });

  it("accepts the deprecated OBSIDIAN_PKM_OPENAI_KEY as a fallback and prints a deprecation warning", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });

    const env = { ...process.env, VAULT_PATH: vaultPath, OBSIDIAN_PKM_OPENAI_KEY: "sk-test-key" };
    delete env.VAULT_PKM_OPENAI_KEY;
    const { stdout } = await runDoctor(env);
    assert.ok(
      stdout.includes("\u2713 VAULT_PKM_OPENAI_KEY set"),
      "should treat the old env var as enabling semantic search"
    );
    assert.ok(
      stdout.includes("OBSIDIAN_PKM_OPENAI_KEY is deprecated"),
      "should print a deprecation warning when only the old name is set"
    );
  });

  it("prints a summary line with counts", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });

    const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: vaultPath });
    // Summary should contain "passed" and at least one count
    assert.ok(stdout.includes("passed"), "summary should mention passed checks");
  });

  it("uses checkmark, warning, and cross characters in output", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });

    const env = { ...process.env, VAULT_PATH: vaultPath };
    delete env.VAULT_PKM_OPENAI_KEY;
    delete env.OBSIDIAN_PKM_OPENAI_KEY;
    delete env.OPENAI_API_KEY;
    const { stdout } = await runDoctor(env);

    // Should contain at least one checkmark (Node.js version)
    assert.ok(stdout.includes("\u2713"), "output should contain checkmark character");
    // Should contain at least one warning (API key or templates)
    assert.ok(stdout.includes("\u26A0"), "output should contain warning character");
  });
});

describe("doctor semantic health", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-doctor-health-"));
    fakeHome = path.join(tmpDir, "home");
    await fs.mkdir(fakeHome);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "disabled index",
      key: "sk-test",
      stats: { indexed_files: 735, vault_files: 2469, status: "disabled", reason: "OpenAI quota exhausted. Add credits; it re-enables automatically.", since: "2026-07-03T09:12:00.000Z", last_success_at: null, stale_files: 1734 },
      line: "⚠ Semantic index disabled since 2026-07-03 (OpenAI quota exhausted. Add credits; it re-enables automatically.), 1734 notes stale",
    },
    {
      name: "healthy index",
      key: "sk-test",
      stats: { indexed_files: 50, vault_files: 50, status: "ok", reason: null, since: null, last_success_at: "2026-10-13T08:00:00.000Z", stale_files: 0 },
      line: "✓ Semantic index ok (50/50 notes indexed, last success 2026-10-13T08:00:00.000Z)",
    },
    {
      name: "no stats file yet",
      key: "sk-test",
      stats: null,
      line: "⚠ Semantic index has not reported yet (no .obsidian/semantic-stats.json); start the MCP server once",
    },
    { name: "no API key", key: null, stats: { indexed_files: 1, vault_files: 1, status: "ok", stale_files: 0 }, line: null },
  ];
  for (const c of cases) {
    it(`reports semantic health from semantic-stats.json: ${c.name}`, async () => {
      const vaultPath = path.join(tmpDir, "vault");
      await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
      if (c.stats) await fs.writeFile(path.join(vaultPath, ".obsidian", "semantic-stats.json"), JSON.stringify(c.stats));
      const env = { ...process.env, VAULT_PATH: vaultPath, };
      delete env.VAULT_PKM_OPENAI_KEY;
      delete env.OBSIDIAN_PKM_OPENAI_KEY;
      delete env.OPENAI_API_KEY;
      if (c.key) env.VAULT_PKM_OPENAI_KEY = c.key;

      const { stdout } = await runDoctor(env);

      if (c.line) assert.ok(stdout.includes(c.line), stdout);
      else assert.ok(!stdout.includes("Semantic index"), stdout);
    });
  }
});

describe("doctor project line", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-doctor-project-"));
    fakeHome = path.join(tmpDir, "home");
    await fs.mkdir(fakeHome);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Doctor prints process.cwd(), which can differ from fs.realpath of the same folder
  // (macOS /var symlink, Windows 8.3 short TEMP names), so ask a child in that folder.
  const childCwd = (dir) => execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir, encoding: "utf8" });

  const cases = [
    {
      name: "a git repo listed under repos",
      setup: async (vaultPath, dir) => {
        await makeProject(vaultPath, "Widget", "repos: [github.com/acme/widget]");
        await makeRepo(dir, { origin: "git@github.com:acme/widget.git" });
      },
      line: (cwd) => new RegExp(`^[ \\t]*✓ Project for ${escapeRe(cwd)}: 01-Projects/Widget \\(via repos: github\\.com/acme/widget\\)\\r?$`, "m"),
    },
    {
      name: "an unlinked folder",
      setup: async (vaultPath, dir) => {
        await makeProject(vaultPath, "Widget", "repos: [github.com/acme/widget]");
        await fs.mkdir(dir, { recursive: true });
      },
      line: (cwd) => new RegExp(`^[ \\t]*⚠ Project for ${escapeRe(cwd)}: not linked \\([^)]+\\)\\r?$`, "m"),
    },
  ];
  for (const c of cases) {
    it(`reports how the working folder resolves: ${c.name}`, async () => {
      const vaultPath = path.join(tmpDir, "vault");
      await fs.mkdir(vaultPath, { recursive: true });
      const dir = path.join(tmpDir, "work");
      await c.setup(vaultPath, dir);

      const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: vaultPath }, dir);

      assert.match(stdout, c.line(childCwd(dir)));
    });
  }

  it("prints no project line when the vault is missing", async () => {
    const dir = path.join(tmpDir, "work");
    await fs.mkdir(dir);
    const { stdout } = await runDoctor({ ...process.env, VAULT_PATH: path.join(tmpDir, "nonexistent") }, dir);
    assert.ok(stdout.includes("Vault directory does not exist"), stdout);
    assert.ok(!stdout.includes("Project for"), stdout);
  });
});
