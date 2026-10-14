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
  FileIndex,
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

// ─── FileIndex ─────────────────────────────────────────────────────────

async function makeIndexVault() {
  const root = await tmp("index-vault-");
  const files = {
    "notes/alpha.md": "alpha",
    "notes/index.md": "notes index",
    "other/index.md": "other index",
    "projects/my-app/research/findings.md": "findings",
    "top.md": "top",
    ".obsidian/hidden.md": "hidden",
    "notes/style.css": "css",
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

async function addNote(root, rel, content = "x") {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

describe("FileIndex", () => {
  let root;

  before(async () => {
    root = await makeIndexVault();
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("build indexes every .md note outside dot-folders as '/'-separated paths, grouped by lowercase basename", async () => {
    const index = await FileIndex.build(root);
    assert.deepEqual(index.list().sort(), [
      "notes/alpha.md",
      "notes/index.md",
      "other/index.md",
      "projects/my-app/research/findings.md",
      "top.md",
    ]);
    assert.deepEqual(index.basenameMap.get("index").sort(), ["notes/index.md", "other/index.md"]);
    assert.equal(index.has("notes/alpha.md"), true);
  });

  it("has() only consults the cache, exists() falls back to disk and caches the hit", async () => {
    const index = await FileIndex.build(root);
    await addNote(root, "late/created-after-build.md");
    assert.equal(index.has("late/created-after-build.md"), false);
    assert.equal(await index.exists("late/created-after-build.md"), true);
    assert.equal(index.has("late/created-after-build.md"), true);
    assert.ok(index.basenameMap.get("created-after-build").includes("late/created-after-build.md"));
  });

  const notNotes = [
    ["a non-.md file", "notes/style.css"],
    ["a note inside a dot-folder", ".obsidian/hidden.md"],
    ["a directory", "notes"],
    ["a missing path", "notes/missing.md"],
  ];
  for (const [label, rel] of notNotes) {
    it(`exists() is false for ${label}`, async () => {
      const index = await FileIndex.build(root);
      assert.equal(await index.exists(rel), false);
      assert.equal(index.has(rel), false);
    });
  }

  it("exists() never admits a note whose real location is outside the root", async () => {
    const outside = await tmp("index-outside-");
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    await fs.symlink(outside, path.join(root, "out-link"), DIR_LINK);
    try {
      const index = await FileIndex.build(root);
      assert.equal(await index.exists("out-link/secret.md"), false);
      assert.equal(index.list().some((f) => f.includes("secret")), false);
    } finally {
      await fs.rm(path.join(root, "out-link"), { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  const resolvable = [
    ["an exact path", "notes/alpha.md", "notes/alpha.md"],
    ["an exact path without .md", "notes/alpha", "notes/alpha.md"],
    ["a bare basename", "alpha", "notes/alpha.md"],
    ["a bare basename in another letter case", "ALPHA", "notes/alpha.md"],
    ["a bare basename with .md", "findings.md", "projects/my-app/research/findings.md"],
    ["a path suffix", "research/findings", "projects/my-app/research/findings.md"],
    ["a path suffix in another letter case", "My-App/Research/Findings.md", "projects/my-app/research/findings.md"],
    ["a path with Windows separators", "notes\\alpha.md", "notes/alpha.md"],
  ];
  for (const [label, input, expected] of resolvable) {
    it(`resolveFuzzy resolves ${label}`, async () => {
      const index = await FileIndex.build(root);
      assert.equal(await index.resolveFuzzy(input), expected);
    });
  }

  for (const input of ["app/research/findings", "wrong-folder/findings", "elsewhere/alpha.md"]) {
    it(`resolveFuzzy matches an input containing '/' only by whole-segment path suffix (${input})`, async () => {
      const index = await FileIndex.build(root);
      await assert.rejects(() => index.resolveFuzzy(input), {
        message: `File not found: "${input}". No matching file in vault.`,
      });
    });
  }

  it("resolveFuzzy reports ambiguity with every candidate and asks for the full path", async () => {
    const index = await FileIndex.build(root);
    await assert.rejects(() => index.resolveFuzzy("index"), (err) => {
      assert.equal(err.message, '"index" matches 2 files:\n  - notes/index.md\n  - other/index.md\nUse a more specific path (pass the full path).');
      assert.doesNotMatch(err.message, /folder/);
      return true;
    });
  });

  it("a fuzzy miss rescans the vault once and finds a note created after build", async () => {
    const index = await FileIndex.build(root);
    await addNote(root, "late/rescanned-note.md");
    assert.equal(await index.resolveFuzzy("rescanned-note"), "late/rescanned-note.md");
  });

  it("rescans triggered by misses are throttled to one per 2000 ms", async () => {
    let now = 10_000;
    const index = await FileIndex.build(root, { now: () => now });
    await addNote(root, "late/throttle-one.md");
    assert.equal(await index.resolveFuzzy("throttle-one"), "late/throttle-one.md");

    await addNote(root, "late/throttle-two.md");
    now += 1999;
    await assert.rejects(() => index.resolveFuzzy("throttle-two"), /File not found/);

    now += 1;
    assert.equal(await index.resolveFuzzy("throttle-two"), "late/throttle-two.md");
  });

  it("add, remove and rename keep has(), list() and basenameMap in step", async () => {
    const index = await FileIndex.build(root);
    index.add("x/new-note.md");
    assert.equal(index.has("x/new-note.md"), true);
    assert.ok(index.list().includes("x/new-note.md"));
    assert.deepEqual(index.basenameMap.get("new-note"), ["x/new-note.md"]);

    index.rename("x/new-note.md", "y/renamed-note.md");
    assert.equal(index.has("x/new-note.md"), false);
    assert.equal(index.basenameMap.has("new-note"), false);
    assert.deepEqual(index.basenameMap.get("renamed-note"), ["y/renamed-note.md"]);

    index.remove("y/renamed-note.md");
    assert.equal(index.has("y/renamed-note.md"), false);
    assert.equal(index.list().includes("y/renamed-note.md"), false);
    assert.equal(index.basenameMap.has("renamed-note"), false);
  });

  it("listFresh() returns the notes on disk and replaces the cache", async () => {
    const index = await FileIndex.build(root);
    await addNote(root, "late/fresh-listed.md");
    await fs.rm(path.join(root, "top.md"));
    try {
      const listed = await index.listFresh();
      assert.ok(listed.includes("late/fresh-listed.md"));
      assert.equal(listed.includes("top.md"), false);
      assert.equal(index.has("late/fresh-listed.md"), true);
      assert.equal(index.has("top.md"), false);
    } finally {
      await fs.writeFile(path.join(root, "top.md"), "top");
    }
  });

  const unicode = [
    ["NFD on disk, NFC requested", "Café", "Café"],
    ["NFC on disk, NFD requested", "Crème", "Crème"],
  ];
  for (const [label, onDisk, requested] of unicode) {
    it(`finds a note whose name differs only in Unicode normalisation (${label})`, async () => {
      const vault = await tmp("index-unicode-");
      try {
        await addNote(vault, `menu/${onDisk}.md`, "dessert");
        const index = await FileIndex.build(vault);
        const listed = index.list()[0];
        assert.equal(await index.exists(`menu/${requested}.md`), true);
        assert.equal(await index.resolveFuzzy(`menu/${requested}.md`), listed);
        assert.equal(await index.resolveFuzzy(requested), listed);
        assert.equal(await fs.readFile(path.join(vault, listed), "utf-8"), "dessert");
        assert.equal(index.list().length, 1);
      } finally {
        await fs.rm(vault, { recursive: true, force: true });
      }
    });
  }

  it("on a case-insensitive filesystem an exact path in another case resolves to the on-disk spelling without a duplicate entry", async (t) => {
    const probe = await tmp("index-case-");
    await fs.writeFile(path.join(probe, "Probe.md"), "p");
    const caseInsensitive = await fs.stat(path.join(probe, "probe.md")).then(() => true, () => false);
    await fs.rm(probe, { recursive: true, force: true });
    if (!caseInsensitive) {
      t.skip("filesystem is case-sensitive");
      return;
    }
    const index = await FileIndex.build(root);
    assert.equal(await index.resolveFuzzy("NOTES/ALPHA.md"), "notes/alpha.md");
    assert.equal(index.list().filter((f) => f.toLowerCase() === "notes/alpha.md").length, 1);
  });
});
