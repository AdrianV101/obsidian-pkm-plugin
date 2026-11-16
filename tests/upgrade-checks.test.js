import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { checkUpgrade, readPackageSpec, cliCommand } from "../upgrade-checks.js";
import { addDismissal, dismissalFile } from "../upgrade-dismissals.js";
import { git, makeRepo } from "./git-fixture.js";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SPEC = "obsidian-pkm@^9";
const HUB = "---\ntype: devlog\n---\n# Development Log\n\n```base\nviews: []\n```\n";
const OLD_TEMPLATE = "---\ntype: devlog\n---\n# Development Log\n\nThis log tracks development progress, decisions made, and lessons learned.\n\n## Sessions\n";
const OLD_DEVLOG = "---\ntype: devlog\n---\n# Development Log\n\n### 2026-10-27 09:14 First\n- a\n";
const SECTION = "# App\n\n## PKM Integration\n\n- Vault project: 01-Projects/App\n";
const POSIX_ONLY = { skip: process.platform === "win32" ? "runs commands through sh" : false };

let tmp, vault, home;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pkm-upgrade-")));
  vault = path.join(tmp, "vault");
  home = path.join(tmp, "home");
  await fs.mkdir(path.join(vault, "01-Projects", "Cur"), { recursive: true });
  await fs.mkdir(home);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(abs, content) {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const vaultFile = (rel) => path.join(vault, ...rel.split("/"));
const devlogOf = (name) => vaultFile(`01-Projects/${name}/development/devlog.md`);

async function plainDir(name) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A main repo with a linked worktree, and a cwd inside the worktree. */
async function worktreeFixture(label) {
  const base = await plainDir(label);
  const main = await makeRepo(path.join(base, "app"));
  const worktree = path.join(base, "wt");
  git(main, "worktree", "add", "-b", `feature-${label}`, worktree);
  const cwd = path.join(worktree, "sub");
  await fs.mkdir(cwd);
  return { main, worktree, cwd };
}

function check(options = {}) {
  return checkUpgrade({ vaultPath: vault, projectPath: "01-Projects/Cur", cwd: null, packageSpec: SPEC, home, ...options });
}

const stepOf = (report, id) => report.steps.find((s) => s.id === id);

describe("checkUpgrade: devlog-template", () => {
  it("is left only while 05-Templates/devlog.md exists without a ```base line", async () => {
    const rows = [
      [null, "done"],
      [HUB, "done"],
      [HUB.replace(/\n/g, "\r\n"), "done"],
      [OLD_TEMPLATE, "left"],
    ];
    for (const [content, state] of rows) {
      await fs.rm(vaultFile("05-Templates"), { recursive: true, force: true });
      if (content !== null) await write(vaultFile("05-Templates/devlog.md"), content);
      const step = stepOf(await check(), "devlog-template");
      assert.equal(step.state, state, JSON.stringify(content));
      assert.equal(step.required, true);
      assert.equal(step.target, null);
      if (state === "left") {
        assert.match(step.summary, /05-Templates\/devlog\.md/);
        assert.ok(step.fix.includes(path.join(REPO_ROOT, "templates", "devlog.md")), step.fix);
        // The short form leaves out the path, so a long install path can't crowd out another step.
        assert.equal(step.shortFix, "Delete it (the bundled hub template then applies).");
      } else {
        assert.equal(step.summary, "");
        assert.equal(step.fix, "");
        assert.ok(!step.shortFix, step.shortFix);
      }
    }
  });
});

describe("checkUpgrade: devlog-migration", () => {
  it("is left while the project's devlog.md holds any entry parseDevlog recognises", async () => {
    const hubWithEntries = `${HUB}\n## 2026-11-01 A\n- a\n\n## 2026-11-02 B\n- b\n`;
    const rows = [
      ["### 2026-10-27 09:14 A\n- a\n", "left", "1 old-style entry"],
      ["## 2026-10-27\n- a\n", "left", "1 old-style entry"],
      ["## 2026-10-27 Title\n- a\n", "left", "1 old-style entry"],
      [hubWithEntries, "left", "2 old-style entries"],
      [null, "done", null],
      [HUB, "done", null],
      [OLD_TEMPLATE, "done", null],
    ];
    for (const [content, state, count] of rows) {
      await fs.rm(devlogOf("Cur"), { force: true });
      if (content !== null) await write(devlogOf("Cur"), content);
      const step = stepOf(await check(), "devlog-migration");
      assert.equal(step.state, state, JSON.stringify(content));
      assert.equal(step.required, true);
      assert.equal(step.target, "01-Projects/Cur");
      if (state === "left") {
        assert.ok(step.summary.includes("01-Projects/Cur/development/devlog.md"), step.summary);
        assert.ok(step.summary.includes(count), step.summary);
        assert.match(step.fix, /every device/);
        assert.ok(step.fix.includes(cliCommand({ vaultPath: vault, packageSpec: SPEC }, "migrate-devlog", "01-Projects/Cur")), step.fix);
        assert.match(step.fix, /--apply/);
      }
    }
    assert.equal(stepOf(await check({ projectPath: null }), "devlog-migration"), undefined);
  });

  it("lists the other projects whose devlog.md has no ```base line in its first 4,096 bytes", async () => {
    await write(devlogOf("Cur"), OLD_DEVLOG);
    await write(devlogOf("A"), OLD_DEVLOG);
    await write(devlogOf("B"), HUB);
    await write(devlogOf("C"), `---\ntype: devlog\n---\n${"x".repeat(4200)}\n\`\`\`base\nviews: []\n\`\`\`\n`);
    await fs.mkdir(vaultFile("01-Projects/D"), { recursive: true });
    await write(devlogOf("E"), OLD_DEVLOG);
    await addDismissal({ step: "devlog-migration", vault, target: "01-Projects/E" }, { home });
    await write(devlogOf(".hidden"), OLD_DEVLOG);
    await write(vaultFile("01-Projects/notes.md"), "# notes\n");
    await fs.mkdir(devlogOf("F"), { recursive: true });

    const report = await check();
    assert.deepEqual(report.otherProjects, ["01-Projects/A", "01-Projects/C"]);
    assert.deepEqual(report.errors, []);
    assert.ok(report.othersFix.includes(cliCommand({ vaultPath: vault, packageSpec: SPEC }, "migrate-devlog")), report.othersFix);
    assert.ok(report.othersFix.includes(cliCommand({ vaultPath: vault, packageSpec: SPEC }, "upgrade", "dismiss", "devlog-migration")), report.othersFix);
    assert.equal((await check({ projectPath: "01-Projects/A" })).otherProjects.includes("01-Projects/A"), false);
  });
});

describe("checkUpgrade: claude-md-section", () => {
  it("is left while a CLAUDE.md the session reads has a ## PKM Integration heading, keyed to the main checkout", async () => {
    const rows = [
      ["sub/CLAUDE.md", SECTION, "left"],
      ["wt/.claude/CLAUDE.md", SECTION, "left"],
      ["main/CLAUDE.md", SECTION, "left"],
      ["sub/CLAUDE.md", SECTION.replace(/\n/g, "\r\n"), "left"],
      ["sub/CLAUDE.local.md", SECTION, "done"],
      ["sub/CLAUDE.md", "# App\n\n```md\n## PKM Integration\n```\n", "done"],
      ["sub/CLAUDE.md", "# App\n\n### PKM Integration\n", "done"],
      [null, null, "done"],
    ];
    for (const [i, [where, content, state]] of rows.entries()) {
      const { main, worktree, cwd } = await worktreeFixture(`row${i}`);
      let file = null;
      if (where !== null) {
        const [base, ...rest] = where.split("/");
        file = path.join({ sub: cwd, wt: worktree, main }[base], ...rest);
        await write(file, content);
      }
      const step = stepOf(await check({ cwd }), "claude-md-section");
      assert.equal(step.state, state, `${where}: ${JSON.stringify(content)}`);
      assert.equal(step.required, false);
      assert.equal(step.target, main);
      if (state === "left") assert.ok(step.summary.includes(file), step.summary);
    }

    const plain = await plainDir("plain");
    await write(path.join(plain, "CLAUDE.md"), SECTION);
    const outside = stepOf(await check({ cwd: plain }), "claude-md-section");
    assert.equal(outside.state, "left");
    assert.equal(outside.target, plain);

    assert.equal(stepOf(await check({ cwd: null }), "claude-md-section"), undefined);
  });
});

describe("checkUpgrade: dismissals and failures", () => {
  it("reports a left step dismissed for this vault and target as dismissed, and nothing else", async () => {
    await write(vaultFile("05-Templates/devlog.md"), OLD_TEMPLATE);
    await write(devlogOf("Cur"), OLD_DEVLOG);
    const plain = await plainDir("plain");
    await write(path.join(plain, "CLAUDE.md"), SECTION);

    await addDismissal({ step: "devlog-template", vault: path.join(tmp, "other-vault"), target: null }, { home });
    assert.deepEqual((await check({ cwd: plain })).steps.map((s) => s.state), ["left", "left", "left"]);

    await addDismissal({ step: "devlog-template", vault, target: null }, { home });
    await addDismissal({ step: "devlog-migration", vault, target: "01-Projects/Cur" }, { home });
    await addDismissal({ step: "claude-md-section", vault, target: plain }, { home });
    const report = await check({ cwd: plain });
    assert.deepEqual(report.steps.map((s) => s.state), ["dismissed", "dismissed", "dismissed"]);
    assert.equal(report.dismissalError, null);

    await fs.rm(vaultFile("05-Templates/devlog.md"));
    assert.equal(stepOf(await check({ cwd: plain }), "devlog-template").state, "done");

    const { main, worktree } = await worktreeFixture("dismissed");
    await write(path.join(worktree, "CLAUDE.md"), SECTION);
    await addDismissal({ step: "claude-md-section", vault, target: main }, { home });
    assert.equal(stepOf(await check({ cwd: path.join(worktree, "sub") }), "claude-md-section").state, "dismissed");

    await fs.writeFile(dismissalFile(home), "not json");
    const corrupt = await check({ cwd: plain });
    assert.deepEqual(corrupt.steps.map((s) => s.state), ["done", "left", "left"]);
    assert.equal(typeof corrupt.dismissalError, "string");
    assert.notEqual(corrupt.dismissalError, "");
  });

  it("leaves out a check that fails and names it in errors, still reporting the others", async () => {
    await write(vaultFile("05-Templates/devlog.md"), OLD_TEMPLATE);
    await fs.mkdir(devlogOf("Cur"), { recursive: true });
    const plain = await plainDir("plain");
    await write(path.join(plain, "CLAUDE.md"), SECTION);

    const report = await check({ cwd: plain });
    assert.deepEqual(report.steps.map((s) => s.id), ["devlog-template", "claude-md-section"]);
    assert.equal(report.errors.length, 1);
    assert.ok(report.errors[0].startsWith("devlog-migration: "), report.errors[0]);
  });
});

describe("upgrade commands", () => {
  it("deliver the vault path and every argument unchanged through a shell", POSIX_ONLY, async () => {
    vault = path.join(tmp, "my vault 'q' $HOME é");
    const project = "01-Projects/It's $x";
    await write(vaultFile("05-Templates/devlog.md"), OLD_TEMPLATE);
    await write(vaultFile(`${project}/development/devlog.md`), OLD_DEVLOG);
    const repo = await plainDir("re po");
    await write(path.join(repo, "CLAUDE.md"), SECTION);

    const bin = await plainDir("bin");
    const npx = path.join(bin, "npx");
    await fs.writeFile(npx, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), vault: process.env.VAULT_PATH }));\n`);
    await fs.chmod(npx, 0o755);
    const run = (command) => JSON.parse(execFileSync("/bin/sh", ["-c", command], { env: { PATH: bin }, encoding: "utf8" }));

    const report = await check({ projectPath: project, cwd: repo });
    const where = { vaultPath: vault, packageSpec: SPEC };
    const expected = [
      [stepOf(report, "devlog-template").dismiss, ["upgrade", "dismiss", "devlog-template"]],
      [stepOf(report, "devlog-migration").dismiss, ["upgrade", "dismiss", "devlog-migration", project]],
      [stepOf(report, "claude-md-section").dismiss, ["upgrade", "dismiss", "claude-md-section", repo]],
      [cliCommand(where, "migrate-devlog", project), ["migrate-devlog", project]],
    ];
    for (const [command, args] of expected) {
      assert.ok(command.startsWith("VAULT_PATH="), command);
      assert.deepEqual(run(command), { argv: ["-y", SPEC, ...args], vault: path.resolve(vault) }, command);
    }
  });

  it("readPackageSpec reads the obsidian-pkm spec the plugin starts its server with", async () => {
    const rows = [
      [{ mcpServers: { "vault-pkm": { command: "npx", args: ["-y", "obsidian-pkm@^4"] } } }, "obsidian-pkm@^4"],
      [{ mcpServers: { "vault-pkm": { command: "npx", args: ["obsidian-pkm"] } } }, "obsidian-pkm"],
      [null, null],
      ["{ not json", null],
      [{ mcpServers: { other: { args: ["obsidian-pkm@^4"] } } }, null],
      [{ mcpServers: { "vault-pkm": { args: ["-y", "other-pkg@^1"] } } }, null],
    ];
    for (const [i, [manifest, expected]] of rows.entries()) {
      const root = await plainDir(`plugin${i}`);
      if (manifest !== null) {
        await write(path.join(root, ".claude-plugin", "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
      }
      assert.equal(await readPackageSpec(root), expected, JSON.stringify(manifest));
    }
  });
});

describe("checkUpgrade speed", () => {
  it("checks a 3 MB devlog and 13 other projects well within the session-start budget", async () => {
    const entries = Array.from({ length: 30000 }, (_, i) => `### 2026-10-27 09:14 Entry ${i}\n- ${"work ".repeat(16)}\n`);
    await write(devlogOf("Cur"), `---\ntype: devlog\n---\n# Development Log\n\n${entries.join("\n")}`);
    for (let i = 0; i < 13; i++) await write(devlogOf(`P${String(i).padStart(2, "0")}`), OLD_DEVLOG);

    const start = performance.now();
    const report = await check();
    const elapsed = performance.now() - start;

    assert.equal(stepOf(report, "devlog-migration").state, "left");
    assert.equal(report.otherProjects.length, 13);
    // The budget is 100 ms on a developer machine; the rest is headroom for slow CI runners.
    assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
  });
});
