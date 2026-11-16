import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runUpgrade } from "../upgrade.js";
import { addDismissal, dismissalFile, readDismissals } from "../upgrade-dismissals.js";

const CLI = path.join(import.meta.dirname, "..", "cli.js");
const USAGE = "Usage: obsidian-pkm upgrade dismiss <step> [<target>] | obsidian-pkm upgrade reset";

describe("obsidian-pkm upgrade", () => {
  let home, vault;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-upgrade-cli-"));
    vault = path.join(home, "vault");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  /** Run with captured output; `env` replaces the environment the command sees. */
  async function upgrade(args, env = { VAULT_PATH: vault }) {
    let stdout = "";
    let stderr = "";
    const code = await runUpgrade(args, {
      env,
      home,
      now: new Date("2026-11-16T10:00:00Z"),
      stdout: { write: (t) => { stdout += t; } },
      stderr: { write: (t) => { stderr += t; } },
    });
    return { code, stdout, stderr };
  }

  const exists = (p) => fs.access(p).then(() => true, () => false);

  it("dismiss records the step for VAULT_PATH and the target, and says how to undo it", async () => {
    const rows = [
      [["dismiss", "devlog-migration", "01-Projects/A"], { step: "devlog-migration", target: "01-Projects/A" }],
      [["dismiss", "claude-md-section", "/repo"], { step: "claude-md-section", target: path.resolve("/repo") }],
      [["dismiss", "devlog-template"], { step: "devlog-template", target: null }],
    ];
    for (const [args, key] of rows) {
      const { code, stdout, stderr } = await upgrade(args);
      assert.equal(code, 0, stderr);
      assert.ok(stdout.includes(key.step), stdout);
      if (key.target) assert.ok(stdout.includes(args[2]), stdout);
      assert.ok(stdout.includes("obsidian-pkm upgrade reset"), stdout);
      const { dismissals } = await readDismissals({ home });
      assert.ok(dismissals.some((d) => d.step === key.step && d.vault === path.resolve(vault) && d.target === key.target), JSON.stringify(dismissals));
    }
  });

  it("reset clears every dismissal on the device without needing VAULT_PATH", async () => {
    await addDismissal({ step: "devlog-template", vault, target: null }, { home });
    await addDismissal({ step: "devlog-migration", vault, target: "01-Projects/A" }, { home });
    const { code, stdout } = await upgrade(["reset"], {});
    assert.equal(code, 0);
    assert.match(stdout, /Cleared 2 /);
    assert.deepEqual((await readDismissals({ home })).dismissals, []);
  });

  it("rejects bad arguments with exit 2, the reason and the usage line, writing nothing", async () => {
    const rows = [
      [[], undefined],
      [["list"], undefined],
      [["dismiss"], undefined],
      [["dismiss", "nope", "x"], undefined],
      [["dismiss", "devlog-migration"], undefined],
      [["dismiss", "devlog-template", "x"], undefined],
      [["dismiss", "devlog-migration", "a", "b"], undefined],
      [["reset", "x"], undefined],
      [["dismiss", "devlog-template"], {}],
      [["dismiss", "devlog-template"], { VAULT_PATH: "${VAULT_PATH}" }],
    ];
    for (const [args, env] of rows) {
      const { code, stdout, stderr } = await upgrade(args, env);
      const label = `${JSON.stringify(args)} ${JSON.stringify(env)}`;
      assert.equal(code, 2, label);
      assert.equal(stdout, "", label);
      const lines = stderr.trimEnd().split("\n");
      assert.ok(lines.length >= 2 && lines[0] !== USAGE, `${label}: ${stderr}`);
      assert.equal(lines.at(-1), USAGE, label);
    }
    assert.equal(await exists(dismissalFile(home)), false);
  });

  it("replaces an unreadable dismissal file with a warning, and fails with exit 1 when it can't write", async () => {
    await fs.mkdir(path.dirname(dismissalFile(home)), { recursive: true });
    await fs.writeFile(dismissalFile(home), "not json");
    const replaced = await upgrade(["dismiss", "devlog-template"]);
    assert.equal(replaced.code, 0);
    assert.ok(replaced.stderr.includes(dismissalFile(home)), replaced.stderr);
    assert.equal((await readDismissals({ home })).error, null);

    await fs.rm(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(home, ".claude"), "a file where the folder should be");
    const failed = await upgrade(["dismiss", "devlog-template"]);
    assert.equal(failed.code, 1);
    assert.notEqual(failed.stderr, "");
  });

  it("runs through cli.js, and the CLI's usage line names it", async () => {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, VAULT_PATH: vault },
    });
    const dismissed = run("upgrade", "dismiss", "devlog-template");
    assert.equal(dismissed.status, 0, dismissed.stderr);
    const { dismissals } = await readDismissals({ home });
    assert.deepEqual(dismissals.map((d) => d.step), ["devlog-template"]);
    const unknown = run("nope");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /upgrade dismiss <step> \[<target>\] \| upgrade reset/);
  });
});
