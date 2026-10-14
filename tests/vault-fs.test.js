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
  mutateFile,
  writeNew,
  withNoteLock,
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

// ─── mutateFile / writeNew ────────────────────────────────────────────

async function tempNames(dir) {
  return (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
}

describe("mutateFile", () => {
  let dir;

  before(async () => {
    dir = await tmp("mutate-");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function note(name, content) {
    const p = path.join(dir, name);
    await fs.writeFile(p, content);
    return p;
  }

  it("writes the transform's result and returns the content before and after", async () => {
    const p = await note("basic.md", "one\n");
    const result = await mutateFile(p, (c) => c + "two\n");
    assert.deepEqual(result, { before: "one\n", after: "one\ntwo\n" });
    assert.equal(await fs.readFile(p, "utf-8"), "one\ntwo\n");
  });

  it("serialises concurrent updates to one file so every change lands", async () => {
    const p = await note("concurrent.md", "");
    await Promise.all(Array.from({ length: 10 }, (_, i) => mutateFile(p, (c) => c + `line ${i}\n`)));
    const lines = (await fs.readFile(p, "utf-8")).trim().split("\n").sort();
    assert.deepEqual(lines, Array.from({ length: 10 }, (_, i) => `line ${i}`).sort());
  });

  it("re-reads and re-applies the transform when the file changes between read and write", async () => {
    const p = await note("external.md", "start\n");
    let calls = 0;
    await mutateFile(p, async (c) => {
      calls++;
      if (calls === 1) await fs.appendFile(p, "external\n");
      return c + "ours\n";
    });
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(p, "utf-8"), "start\nexternal\nours\n");
  });

  it("gives up after maxAttempts when the file keeps changing, without writing its own result", async () => {
    const p = await note("busy.md", "start\n");
    let calls = 0;
    await assert.rejects(
      () => mutateFile(p, async (c) => {
        calls++;
        await fs.appendFile(p, `external ${calls}\n`);
        return c + "ours\n";
      }, { maxAttempts: 3 }),
      (err) => {
        assert.equal(err.code, "ECONFLICT");
        assert.match(err.message, /Gave up updating busy\.md after 3 attempts/);
        return true;
      }
    );
    assert.equal(calls, 3);
    assert.equal(await fs.readFile(p, "utf-8"), "start\nexternal 1\nexternal 2\nexternal 3\n");
  });

  const outcomes = [
    ["a successful update", async (p) => mutateFile(p, (c) => c + "x")],
    ["a transform that throws", async (p) => assert.rejects(() => mutateFile(p, () => { throw new Error("boom"); }), /boom/)],
    ["giving up", async (p) => assert.rejects(() => mutateFile(p, async (c) => { await fs.appendFile(p, "e"); return c; }, { maxAttempts: 2 }))],
  ];
  for (const [label, run] of outcomes) {
    it(`leaves no temp file behind after ${label}`, async () => {
      const sub = await fs.mkdtemp(path.join(dir, "clean-"));
      const p = path.join(sub, "n.md");
      await fs.writeFile(p, "n");
      await run(p);
      assert.deepEqual(await tempNames(sub), []);
    });
  }

  it("throws ENOENT as-is for a missing file", async () => {
    await assert.rejects(() => mutateFile(path.join(dir, "missing.md"), (c) => c), { code: "ENOENT" });
  });

  it("does not touch the file when the transform returns identical content", async () => {
    const p = await note("noop.md", "same");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(p, past, past);
    const { mtimeMs } = await fs.stat(p);
    await mutateFile(p, (c) => c);
    assert.equal((await fs.stat(p)).mtimeMs, mtimeMs);
  });

  it("replaces the file by rename: a reader that opened it before the update still reads the complete previous version",
    { skip: IS_WIN && "Windows cannot rename over a file another handle holds open" }, async () => {
      const p = await note("reader.md", "old version\n");
      const handle = await fs.open(p, "r");
      try {
        await mutateFile(p, () => "new version\n");
        assert.equal(await handle.readFile("utf-8"), "old version\n");
        assert.equal(await fs.readFile(p, "utf-8"), "new version\n");
      } finally {
        await handle.close();
      }
    });

  it("keeps the note's permission bits", { skip: IS_WIN && "POSIX permission bits" }, async () => {
    const p = await note("mode.md", "m");
    await fs.chmod(p, 0o600);
    await mutateFile(p, (c) => c + "!");
    assert.equal((await fs.stat(p)).mode & 0o777, 0o600);
  });

  it("updates a symlinked note's target and keeps the symlink", { skip: IS_WIN && "file symlinks need privileges on Windows" }, async () => {
    const target = await note("real.md", "real\n");
    const link = path.join(dir, "link.md");
    await fs.symlink(target, link);
    await mutateFile(link, (c) => c + "appended\n");
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(target, "utf-8"), "real\nappended\n");
  });
});

describe("writeNew", () => {
  let dir;

  before(async () => {
    dir = await tmp("writenew-");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates the file with the given content and leaves no temp file", async () => {
    const p = path.join(dir, "created.md");
    await writeNew(p, "hello\n");
    assert.equal(await fs.readFile(p, "utf-8"), "hello\n");
    assert.deepEqual(await tempNames(dir), []);
  });

  it("fails with EEXIST on an existing file, leaving it untouched and no temp file", async () => {
    const p = path.join(dir, "existing.md");
    await fs.writeFile(p, "original");
    await assert.rejects(() => writeNew(p, "replacement"), (err) => {
      assert.equal(err.code, "EEXIST");
      assert.match(err.message, /^File already exists: /);
      return true;
    });
    assert.equal(await fs.readFile(p, "utf-8"), "original");
    assert.deepEqual(await tempNames(dir), []);
  });

  it("lets exactly one of two concurrent creations of the same path succeed", async () => {
    const p = path.join(dir, "race.md");
    const results = await Promise.allSettled([writeNew(p, "first"), writeNew(p, "second")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    const winner = results[0].status === "fulfilled" ? "first" : "second";
    assert.equal(await fs.readFile(p, "utf-8"), winner);
  });

  it("falls back to an exclusive copy when the filesystem refuses hard links, keeping fail-if-exists", async () => {
    const noLinks = { link: async () => { throw Object.assign(new Error("not supported"), { code: "EPERM" }); } };
    const p = path.join(dir, "nolink.md");
    await writeNew(p, "copied", noLinks);
    assert.equal(await fs.readFile(p, "utf-8"), "copied");
    await assert.rejects(() => writeNew(p, "again", noLinks), { code: "EEXIST" });
    assert.equal(await fs.readFile(p, "utf-8"), "copied");
    assert.deepEqual(await tempNames(dir), []);
  });
});

// ─── mutateFile: staging order, cross-process lock, metadata ─────────────

describe("mutateFile staging and locking", () => {
  let dir;

  before(async () => {
    dir = await tmp("mutate-lock-");
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function sub(content = "start\n", name = "n.md") {
    const d = await fs.mkdtemp(path.join(dir, "case-"));
    const p = path.join(d, name);
    await fs.writeFile(p, content);
    return { d, p };
  }

  // The lock file's name is derived from the note's name; learn it by observing one update.
  async function lockPathFor(d, p) {
    let lockName;
    await mutateFile(p, async (c) => {
      lockName = (await fs.readdir(d)).find((n) => n.endsWith(".lock"));
      return c;
    });
    return path.join(d, lockName);
  }

  it("re-checks the file after staging the new version, so a write landing during staging is not overwritten", async () => {
    const { d, p } = await sub();
    let staged = 0;
    let calls = 0;
    await mutateFile(p, (c) => { calls++; return c + "ours\n"; }, {
      afterStage: async () => { if (++staged === 1) await fs.appendFile(p, "external\n"); },
    });
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(p, "utf-8"), "start\nexternal\nours\n");
    assert.deepEqual(await tempNames(d), []);
  });

  it("removes the staged temp and the lock when the check keeps failing", async () => {
    const { d, p } = await sub();
    await assert.rejects(
      () => mutateFile(p, (c) => c + "x", { maxAttempts: 2, afterStage: () => fs.appendFile(p, "e") }),
      { code: "ECONFLICT" }
    );
    assert.deepEqual(await tempNames(d), []);
  });

  it("removes the staged temp and the lock when the rename fails", async () => {
    const { d, p } = await sub();
    await assert.rejects(
      () => mutateFile(p, (c) => c + "x", { rename: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }),
      { code: "EACCES" }
    );
    assert.equal(await fs.readFile(p, "utf-8"), "start\n");
    assert.deepEqual(await tempNames(d), []);
  });

  it("holds a lock file for the critical section and releases it afterwards", async () => {
    const { d, p } = await sub();
    let during;
    await mutateFile(p, async (c) => {
      during = (await fs.readdir(d)).filter((n) => n.endsWith(".lock"));
      return c + "x";
    });
    assert.equal(during.length, 1);
    assert.match(during[0], /^\.[0-9a-f]{16}\.lock$/);
    assert.deepEqual(await tempNames(d), []);
  });

  it("waits for a lock held by another process using the injected sleep, then proceeds once it is released", async () => {
    const { d, p } = await sub();
    const held = await lockPathFor(d, p);
    await fs.writeFile(held, `${process.pid} ${Date.now()}`);
    let sleeps = 0;
    await mutateFile(p, (c) => c + "x", {
      sleep: async () => { if (++sleeps === 3) await fs.rm(held); },
    });
    assert.equal(sleeps, 3);
    assert.equal(await fs.readFile(p, "utf-8"), "start\nx");
    assert.deepEqual(await tempNames(d), []);
  });

  it("gives up with ECONFLICT when a fresh lock is never released, leaving the other holder's lock alone", async () => {
    const { d, p } = await sub();
    const held = await lockPathFor(d, p);
    await fs.writeFile(held, `${process.pid} ${Date.now()}`);
    let slept = 0;
    await assert.rejects(
      () => mutateFile(p, (c) => c + "x", { lockTimeoutMs: 100, sleep: async (ms) => { slept += ms; } }),
      (err) => {
        assert.equal(err.code, "ECONFLICT");
        assert.match(err.message, /n\.md/);
        assert.ok(!err.message.includes(d));
        return true;
      }
    );
    assert.ok(slept >= 100);
    assert.equal(await fs.readFile(p, "utf-8"), "start\n");
    assert.equal((await fs.readdir(d)).includes(path.basename(held)), true);
  });

  it("removes a stale lock (older than staleLockMs) and proceeds", async () => {
    const { d, p } = await sub();
    const held = await lockPathFor(d, p);
    await fs.writeFile(held, "99999999 0");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(held, old, old);
    await mutateFile(p, (c) => c + "x", { staleLockMs: 10_000, sleep: async () => {} });
    assert.equal(await fs.readFile(p, "utf-8"), "start\nx");
    assert.deepEqual(await tempNames(d), []);
  });

  it("withNoteLock runs its function under the same lock, so an update queued behind a rename cannot recreate the old path", async () => {
    const { d, p } = await sub();
    const moved = path.join(d, "moved.md");
    let release;
    const gate = new Promise((r) => { release = r; });
    let started;
    const hasStarted = new Promise((r) => { started = r; });
    const holder = withNoteLock(p, async () => {
      started();
      await gate;
      await fs.rename(p, moved);
    });
    await hasStarted;
    const update = mutateFile(p, (c) => c + "late\n");
    release();
    await holder;
    await assert.rejects(() => update, { code: "ENOENT" });
    await assert.rejects(() => fs.access(p), { code: "ENOENT" });
    assert.equal(await fs.readFile(moved, "utf-8"), "start\n");
    assert.deepEqual(await tempNames(d), []);
  });

  it("refuses to modify a note without write permission, leaving it unchanged", { skip: IS_WIN && "POSIX permission bits" }, async () => {
    const { d, p } = await sub("locked\n");
    await fs.chmod(p, 0o444);
    await assert.rejects(() => mutateFile(p, (c) => c + "x"), (err) => {
      assert.equal(err.code, "EACCES");
      assert.match(err.message, /read-only/);
      return true;
    });
    assert.equal(await fs.readFile(p, "utf-8"), "locked\n");
    assert.deepEqual(await tempNames(d), []);
  });

  it("keeps the note's creation time", { skip: process.platform !== "darwin" && "birthtime is only settable on macOS" }, async () => {
    const { p } = await sub("old\n");
    const old = new Date("2021-06-01T12:00:00Z");
    await fs.utimes(p, old, old);
    const before = await fs.stat(p);
    await mutateFile(p, (c) => c + "new\n");
    const after = await fs.stat(p);
    assert.equal(after.birthtime.toISOString(), before.birthtime.toISOString());
    assert.ok(Date.now() - after.mtimeMs < 60_000);
  });

  it("handles a 240-byte note name (temp and lock names stay short)", async () => {
    const { d, p } = await sub("x\n", "a".repeat(240) + ".md");
    await mutateFile(p, (c) => c + "y\n");
    assert.equal(await fs.readFile(p, "utf-8"), "x\ny\n");
    assert.deepEqual(await tempNames(d), []);
    const q = path.join(d, "b".repeat(240) + ".md");
    await writeNew(q, "new\n");
    assert.equal(await fs.readFile(q, "utf-8"), "new\n");
  });

  it("writeNew leaves no temp file when writing the temp fails midway", async () => {
    const d = await fs.mkdtemp(path.join(dir, "wn-"));
    const p = path.join(d, "x.md");
    const failing = {
      write: async (tmpPath) => {
        await fs.writeFile(tmpPath, "partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    await assert.rejects(() => writeNew(p, "content", failing), { code: "ENOSPC" });
    assert.deepEqual(await tempNames(d), []);
    await assert.rejects(() => fs.access(p), { code: "ENOENT" });
  });
});
