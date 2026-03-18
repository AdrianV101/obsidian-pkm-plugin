import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { resolveInputPath, copyTemplates } from "../init.js";

describe("resolveInputPath", () => {
  it("expands ~ to home directory", () => {
    assert.equal(resolveInputPath("~/Documents/PKM"), path.join(os.homedir(), "Documents/PKM"));
  });

  it("expands lone ~", () => {
    assert.equal(resolveInputPath("~"), os.homedir());
  });

  it("expands $HOME", () => {
    assert.equal(resolveInputPath("$HOME/vault"), path.join(os.homedir(), "vault"));
  });

  it("expands ${HOME}", () => {
    assert.equal(resolveInputPath("${HOME}/vault"), path.join(os.homedir(), "vault"));
  });

  it("resolves relative paths to absolute", () => {
    const result = resolveInputPath("my/vault");
    assert.ok(path.isAbsolute(result));
    assert.ok(result.endsWith("my/vault"));
  });

  it("strips trailing slashes", () => {
    const result = resolveInputPath("/tmp/vault/");
    assert.equal(result, "/tmp/vault");
  });

  it("normalises double slashes", () => {
    const result = resolveInputPath("/tmp//vault///notes");
    assert.equal(result, "/tmp/vault/notes");
  });

  it("handles absolute paths unchanged (except normalisation)", () => {
    assert.equal(resolveInputPath("/tmp/vault"), "/tmp/vault");
  });
});

describe("copyTemplates", () => {
  let tmpDir, srcDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-test-"));
    srcDir = path.join(tmpDir, "src-templates");
    await fs.mkdir(srcDir);
    await fs.writeFile(path.join(srcDir, "adr.md"), "# ADR");
    await fs.writeFile(path.join(srcDir, "task.md"), "# Task");
    await fs.writeFile(path.join(srcDir, "note.md"), "# Note");
  });

  it("copies all templates in full mode", async () => {
    const dest = path.join(tmpDir, "vault", "05-Templates");
    const result = await copyTemplates(srcDir, dest, "full");
    assert.equal(result.created, 3);
    assert.equal(result.skipped, 0);
    const files = await fs.readdir(dest);
    assert.equal(files.length, 3);
  });

  it("copies only note.md in minimal mode", async () => {
    const dest = path.join(tmpDir, "vault", "05-Templates");
    const result = await copyTemplates(srcDir, dest, "minimal");
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 0);
    const files = await fs.readdir(dest);
    assert.deepEqual(files, ["note.md"]);
  });

  it("returns zeros in skip mode", async () => {
    const dest = path.join(tmpDir, "vault", "05-Templates");
    const result = await copyTemplates(srcDir, dest, "skip");
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 0);
    await assert.rejects(fs.access(dest), { code: "ENOENT" });
  });

  it("skips files that already exist without overwriting", async () => {
    const dest = path.join(tmpDir, "vault", "05-Templates");
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, "adr.md"), "# Existing ADR");
    const result = await copyTemplates(srcDir, dest, "full");
    assert.equal(result.created, 2);
    assert.equal(result.skipped, 1);
    const content = await fs.readFile(path.join(dest, "adr.md"), "utf8");
    assert.equal(content, "# Existing ADR");
  });

  it("creates destination directory if it doesn't exist", async () => {
    const dest = path.join(tmpDir, "deep", "nested", "05-Templates");
    const result = await copyTemplates(srcDir, dest, "full");
    assert.equal(result.created, 3);
  });

  it("throws if source directory does not exist", async () => {
    const dest = path.join(tmpDir, "vault", "05-Templates");
    await assert.rejects(
      copyTemplates("/nonexistent/templates", dest, "full"),
      (err) => err.code === "ENOENT"
    );
  });
});
