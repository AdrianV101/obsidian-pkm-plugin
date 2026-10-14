import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  toVaultRel,
  normalizeVaultRoot,
  resolveLexical,
  resolveSafe,
  assertWritableNote,
  assertWritableFolder,
} from "../vault-fs.js";

const IS_WIN = process.platform === "win32";
// Directory junctions need no privileges on Windows and resolve like symlinks.
const DIR_LINK = IS_WIN ? "junction" : "dir";

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ─── containment ──────────────────────────────────────────────────────

describe("toVaultRel", () => {
  const cases = [
    ["a\\b\\c.md", "a/b/c.md"],
    ["./a/b.md", "a/b.md"],
    ["/a/b.md", "a/b.md"],
    ["a//b.md", "a/b.md"],
    ["a/./b.md", "a/b.md"],
    ["a/x/../b.md", "a/b.md"],
    ["a/b/", "a/b"],
    ["", ""],
    [".", ""],
    ["../x.md", "../x.md"],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      assert.equal(toVaultRel(input), expected);
    });
  }
});

describe("normalizeVaultRoot", () => {
  it("returns an absolute path with no trailing separator and no '..' segments", () => {
    const base = path.resolve(os.tmpdir(), "vault-root-test");
    assert.equal(normalizeVaultRoot(base + path.sep), base);
    assert.equal(normalizeVaultRoot(path.join(base, "sub", "..")), base);
    assert.equal(normalizeVaultRoot("relative-vault"), path.resolve("relative-vault"));
  });
});

describe("resolveLexical", () => {
  it("accepts a root given with a trailing separator", () => {
    const root = path.resolve(os.tmpdir(), "vault-lexical");
    assert.equal(resolveLexical("notes/a.md", root + path.sep), path.join(root, "notes", "a.md"));
    assert.throws(() => resolveLexical("../x.md", root + path.sep), /escapes vault/);
  });
});

describe("resolveSafe", () => {
  let root, outside;

  before(async () => {
    root = await tmp("safe-root-");
    outside = await tmp("safe-outside-");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "a.md"), "a");
    await fs.symlink(outside, path.join(root, "out"), DIR_LINK);
    await fs.symlink(path.join(root, "notes"), path.join(root, "alias"), DIR_LINK);
    if (!IS_WIN) {
      await fs.symlink(path.join(outside, "secret.md"), path.join(root, "notes", "file-link.md"));
      await fs.symlink(path.join(outside, "missing.md"), path.join(root, "notes", "dangling.md"));
      await fs.symlink(path.join(root, "notes", "a.md"), path.join(root, "notes", "inside-link.md"));
    }
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const escapes = [
    ["an existing file under a symlinked folder that leaves the vault", "out/secret.md", false],
    ["a new file under a symlinked folder that leaves the vault", "out/sub/new.md", false],
    ["a lexical '..' traversal", "../x.md", false],
    ["a file symlink that leaves the vault", "notes/file-link.md", true],
    ["a dangling symlink", "notes/dangling.md", true],
  ];
  for (const [label, rel, posixOnly] of escapes) {
    it(`rejects ${label}`, { skip: posixOnly && IS_WIN && "file symlinks need privileges on Windows" }, async () => {
      await assert.rejects(() => resolveSafe(rel, root), /escapes vault/);
    });
  }

  const allowed = [
    ["an existing note", "notes/a.md", false],
    ["a new nested path under an existing folder", "notes/new/deeper/x.md", false],
    ["a path through a symlinked folder that stays inside the vault", "alias/a.md", false],
    ["a file symlink that stays inside the vault", "notes/inside-link.md", true],
  ];
  for (const [label, rel, posixOnly] of allowed) {
    it(`returns the lexical absolute path for ${label}`, { skip: posixOnly && IS_WIN && "file symlinks need privileges on Windows" }, async () => {
      assert.equal(await resolveSafe(rel, root), path.join(root, ...rel.split("/")));
    });
  }

  it("does not reject in-vault targets when the root itself is reached through a symlink", async () => {
    const linkParent = await tmp("safe-link-parent-");
    const linkedRoot = path.join(linkParent, "vault-link");
    await fs.symlink(root, linkedRoot, DIR_LINK);
    try {
      assert.equal(await resolveSafe("notes/a.md", linkedRoot), path.join(linkedRoot, "notes", "a.md"));
      assert.equal(await resolveSafe("notes/new.md", linkedRoot + path.sep), path.join(linkedRoot, "notes", "new.md"));
    } finally {
      await fs.rm(linkParent, { recursive: true, force: true });
    }
  });
});

describe("assertWritableNote", () => {
  for (const rel of ["notes/a.md", "a.md", "deep/x/y.md", "notes/a.b.md", "./notes/a.md"]) {
    it(`accepts ${rel}`, () => assert.doesNotThrow(() => assertWritableNote(rel)));
  }
  for (const rel of [".obsidian/x.md", ".git/config", "notes/x.css", "notes/.hidden/x.md", ".trash/x.md", "notes/x", "notes/x.MD", "../x.md", "notes/../.obsidian/x.md"]) {
    it(`rejects ${rel}`, () => {
      assert.throws(() => assertWritableNote(rel), {
        message: `Write tools only accept .md notes outside dot-folders: ${rel}`,
      });
    });
  }
});

describe("assertWritableFolder", () => {
  for (const rel of ["notes", "a/b", "projects/my-app/"]) {
    it(`accepts ${rel}`, () => assert.doesNotThrow(() => assertWritableFolder(rel)));
  }
  for (const rel of ["", ".", "/", ".obsidian", "a/.git", ".trash/old"]) {
    it(`rejects ${JSON.stringify(rel)}`, () => {
      assert.throws(() => assertWritableFolder(rel), /only moves folders outside dot-folders, and never the vault root/);
    });
  }
});
