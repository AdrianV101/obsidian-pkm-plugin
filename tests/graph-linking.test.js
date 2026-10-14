import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { findFilesLinkingTo, buildIncomingIndex, createLinkResolver } from "../graph.js";
import { getAllMarkdownFiles } from "../utils.js";

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-linking-test-"));

  const dir = path.join(tmpDir, "notes");
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path.join(dir, "target.md"), "---\ntype: test\ncreated: 2026-01-01\ntags: [test]\n---\n# Target\n");
  await fs.writeFile(path.join(dir, "linker1.md"), "---\ntype: test\ncreated: 2026-01-01\ntags: [test]\n---\n# Linker1\nSee [[target]] for details.\n");
  await fs.writeFile(path.join(dir, "linker2.md"), "---\ntype: test\ncreated: 2026-01-01\ntags: [test]\n---\n# Linker2\nSee [[target|Display Text]] and [[other]].\n");
  await fs.writeFile(path.join(dir, "unrelated.md"), "---\ntype: test\ncreated: 2026-01-01\ntags: [test]\n---\n# Unrelated\nNo links here.\n");
  await fs.writeFile(path.join(dir, "other.md"), "---\ntype: test\ncreated: 2026-01-01\ntags: [test]\n---\n# Other\nLinks to [[linker1]].\n");
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

async function graphInputs(root) {
  const allFiles = (await getAllMarkdownFiles(root)).map(f => f.split(path.sep).join("/"));
  return { allFiles, resolver: createLinkResolver(allFiles) };
}

/** Temp vault from { "rel/path.md": content }. */
async function makeVault(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-linking-case-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe("findFilesLinkingTo", () => {
  it("finds files with [[basename]] links to target", async () => {
    const { allFiles, resolver } = await graphInputs(tmpDir);
    const result = await findFilesLinkingTo("notes/target.md", tmpDir, allFiles, resolver);
    const paths = result.map(r => r.file).sort();
    assert.deepEqual(paths, ["notes/linker1.md", "notes/linker2.md"]);
  });

  it("returns file content along with path", async () => {
    const { allFiles, resolver } = await graphInputs(tmpDir);
    const result = await findFilesLinkingTo("notes/target.md", tmpDir, allFiles, resolver);
    const linker1 = result.find(r => r.file === "notes/linker1.md");
    assert.ok(linker1);
    assert.ok(linker1.content.includes("[[target]]"));
  });

  it("returns empty array when no files link to target", async () => {
    const { allFiles, resolver } = await graphInputs(tmpDir);
    const result = await findFilesLinkingTo("notes/unrelated.md", tmpDir, allFiles, resolver);
    assert.deepEqual(result, []);
  });

  it("does not include the target file itself", async () => {
    const { allFiles, resolver } = await graphInputs(tmpDir);
    const result = await findFilesLinkingTo("notes/target.md", tmpDir, allFiles, resolver);
    const paths = result.map(r => r.file);
    assert.ok(!paths.includes("notes/target.md"));
  });

  it("gracefully skips deleted files (ENOENT) without crashing", async () => {
    const { allFiles, resolver } = await graphInputs(tmpDir);
    const filesWithGhost = [...allFiles, "notes/ghost-file.md"];
    const result = await findFilesLinkingTo("notes/target.md", tmpDir, filesWithGhost, resolver);
    const paths = result.map(r => r.file).sort();
    assert.deepEqual(paths, ["notes/linker1.md", "notes/linker2.md"]);
  });

  it("judges links with the shared resolver: path-qualified in any case counts; code-only and wrong-folder links do not", async () => {
    const dir = await makeVault({
      "notes/target.md": "# Target\n",
      "caps.md": "See [[NOTES/Target]].\n",
      "code-only.md": "```\n[[target]]\n```\nand `[[notes/target]]`\n",
      "wrong-folder.md": "See [[archive/target]].\n",
    });
    const { allFiles, resolver } = await graphInputs(dir);
    const result = await findFilesLinkingTo("notes/target.md", dir, allFiles, resolver);
    assert.deepEqual(result.map(r => r.file), ["caps.md"]);
    await fs.rm(dir, { recursive: true });
  });

  it("counts an ambiguous link as linking to each of its candidates", async () => {
    const dir = await makeVault({ "a/dup.md": "# A\n", "b/dup.md": "# B\n", "src.md": "See [[dup]].\n" });
    const { allFiles, resolver } = await graphInputs(dir);
    for (const target of ["a/dup.md", "b/dup.md"]) {
      const result = await findFilesLinkingTo(target, dir, allFiles, resolver);
      assert.deepEqual(result.map(r => r.file), ["src.md"], target);
    }
    await fs.rm(dir, { recursive: true });
  });
});

describe("buildIncomingIndex", () => {
  it("maps each note to the notes linking to it, skipping self-links and links in code", async () => {
    const dir = await makeVault({
      "t.md": "# T\n",
      "u.md": "# U\n",
      "a.md": "[[t]] and [[a]]\n",
      "b.md": "[[T|alias]]\n```\n[[u]]\n```\n",
    });
    const { allFiles, resolver } = await graphInputs(dir);
    const index = await buildIncomingIndex(dir, allFiles, resolver);
    assert.deepEqual([...index.get("t.md")].sort(), ["a.md", "b.md"]);
    assert.equal(index.get("a.md"), undefined);
    assert.equal(index.get("u.md"), undefined);
    await fs.rm(dir, { recursive: true });
  });
});
