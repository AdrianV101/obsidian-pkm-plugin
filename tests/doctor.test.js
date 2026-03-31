import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";

const CLI = path.join(import.meta.dirname, "..", "cli.js");

function runDoctor(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, "doctor"], {
      env: env || process.env,
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

  it("warns when OBSIDIAN_PKM_OPENAI_KEY is not set", async () => {
    const vaultPath = path.join(tmpDir, "vault");
    await fs.mkdir(vaultPath, { recursive: true });

    const env = { ...process.env, VAULT_PATH: vaultPath };
    delete env.OBSIDIAN_PKM_OPENAI_KEY;
    delete env.OPENAI_API_KEY;
    const { stdout } = await runDoctor(env);
    assert.ok(
      stdout.includes("\u26A0 OBSIDIAN_PKM_OPENAI_KEY not set"),
      "should warn about missing API key"
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
    delete env.OBSIDIAN_PKM_OPENAI_KEY;
    delete env.OPENAI_API_KEY;
    const { stdout } = await runDoctor(env);

    // Should contain at least one checkmark (Node.js version)
    assert.ok(stdout.includes("\u2713"), "output should contain checkmark character");
    // Should contain at least one warning (API key or templates)
    assert.ok(stdout.includes("\u26A0"), "output should contain warning character");
  });
});
