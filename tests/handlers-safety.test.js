import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHandlers } from "../handlers.js";
import { resolveProject } from "../hooks/resolve-project.js";

const IS_WIN = process.platform === "win32";
const DIR_LINK = IS_WIN ? "junction" : "dir";

const NOTE_TEMPLATE = `---
type: note
created: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - test
---
# <% tp.file.title %>
`;

const note = (title, body = "") => `---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n# ${title}\n\nmarker ${body}\n`;

const fakeSemanticIndex = {
  isAvailable: true,
  searchRaw: async () => [],
  search: async () => "No semantically related notes found.",
};

/**
 * A vault with notes/a.md + notes/b.md, an `out` symlink to a directory outside
 * the vault, an `alias` symlink to notes/, and files in dot-folders.
 */
async function makeVault({ vaultPathSuffix = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "safety-vault-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "safety-outside-"));
  const write = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  };
  await write("05-Templates/note.md", NOTE_TEMPLATE);
  await write("notes/a.md", note("A", "[[b]]"));
  await write("notes/b.md", note("B"));
  await write("folder-a/inside.md", note("Inside"));
  await write(".obsidian/x.md", note("Obsidian"));
  await write(".git/config", "[core]\nmarker\n");
  await write("notes/x.css", "marker {}\n");
  await write(".trash/x.md", note("Trashed"));
  await write("notes/.hidden/x.md", note("Hidden"));
  await fs.writeFile(path.join(outside, "secret.md"), note("Secret"));
  await fs.symlink(outside, path.join(root, "out"), DIR_LINK);
  await fs.symlink(path.join(root, "notes"), path.join(root, "alias"), DIR_LINK);

  const templateRegistry = new Map([["note", { content: NOTE_TEMPLATE, description: "note" }]]);
  const handlers = await createHandlers({
    vaultPath: root + vaultPathSuffix,
    templateRegistry,
    semanticIndex: fakeSemanticIndex,
    activityLog: null,
    sessionId: "safety-test",
  });
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  };
  return { root, outside, handlers, cleanup };
}

async function snapshot(dir) {
  const out = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(dir, full)] = await fs.readFile(full, "utf-8");
  }
  return out;
}

// ─── containment ───────────────────────────────────────────────────────

describe("every path-taking tool refuses targets outside the vault", () => {
  // `p` is the note path; `newNote` is a path for tools that create a file.
  const NOTE_TOOLS = [
    ["vault_read", (p) => ({ path: p })],
    ["vault_peek", (p) => ({ path: p })],
    ["vault_links", (p) => ({ path: p })],
    ["vault_neighborhood", (p) => ({ path: p })],
    ["vault_suggest_links", (p) => ({ path: p })],
    ["vault_write", (_p, newNote) => ({ template: "note", path: newNote })],
    ["vault_append", (p) => ({ path: p, content: "pwned" })],
    ["vault_edit", (p) => ({ path: p, old_string: "marker", new_string: "pwned" })],
    ["vault_update_frontmatter", (p) => ({ path: p, fields: { status: "pwned" } })],
    ["vault_add_links", (p) => ({ path: p, links: [{ target: "notes/b.md" }] })],
    ["vault_trash", (p) => ({ path: p })],
    ["vault_move", (p) => ({ old_path: p, new_path: "notes/moved.md" }), "source"],
    ["vault_move", (_p, newNote) => ({ old_path: "notes/b.md", new_path: newNote }), "destination"],
  ];
  const FOLDER_TOOLS = [
    ["vault_search", (f) => ({ query: "marker", folder: f })],
    ["vault_list", (f) => ({ path: f })],
    ["vault_recent", (f) => ({ folder: f })],
    ["vault_query", (f) => ({ folder: f })],
    ["vault_tags", (f) => ({ folder: f })],
    ["vault_link_health", (f) => ({ folder: f })],
    ["vault_semantic_search", (f) => ({ query: "marker", folder: f })],
    ["vault_suggest_links", (f) => ({ content: "marker", folder: f })],
  ];
  const SHAPES = {
    "a symlinked folder": () => ({ folder: "out", notePath: "out/secret.md", newNote: "out/new.md" }),
    "a '..' traversal": (v) => {
      const up = path.relative(v.root, v.outside).split(path.sep).join("/");
      return { folder: up, notePath: `${up}/secret.md`, newNote: `${up}/new.md` };
    },
  };

  for (const [shape, pathsFor] of Object.entries(SHAPES)) {
    for (const [tool, argsFor, role] of NOTE_TOOLS) {
      it(`${tool}${role ? ` (${role})` : ""} via ${shape}`, async () => {
        const v = await makeVault();
        try {
          const before = await snapshot(v.outside);
          const { notePath, newNote } = pathsFor(v);
          await assert.rejects(() => v.handlers.get(tool)(argsFor(notePath, newNote)), /escapes vault/);
          assert.deepEqual(await snapshot(v.outside), before);
        } finally {
          await v.cleanup();
        }
      });
    }
    for (const [tool, argsFor] of FOLDER_TOOLS) {
      it(`${tool} (folder) via ${shape}`, async () => {
        const v = await makeVault();
        try {
          await assert.rejects(() => v.handlers.get(tool)(argsFor(pathsFor(v).folder)), /escapes vault/);
        } finally {
          await v.cleanup();
        }
      });
    }
  }
});

describe("a symlink that stays inside the vault keeps working", () => {
  const CASES = [
    ["vault_read", { path: "alias/a.md" }, async (root, result) => assert.match(result.content[0].text, /# A/)],
    ["vault_append", { path: "alias/a.md", content: "via alias" }, async (root) => assert.match(await fs.readFile(path.join(root, "notes/a.md"), "utf-8"), /via alias/)],
    ["vault_edit", { path: "alias/a.md", old_string: "marker", new_string: "edited" }, async (root) => assert.match(await fs.readFile(path.join(root, "notes/a.md"), "utf-8"), /edited/)],
    ["vault_update_frontmatter", { path: "alias/a.md", fields: { status: "active" } }, async (root) => assert.match(await fs.readFile(path.join(root, "notes/a.md"), "utf-8"), /status: active/)],
    ["vault_write", { template: "note", path: "alias/new.md" }, async (root) => assert.match(await fs.readFile(path.join(root, "notes/new.md"), "utf-8"), /# new/)],
  ];
  for (const [tool, args, check] of CASES) {
    it(`${tool} through an in-vault symlinked folder`, async () => {
      const v = await makeVault();
      try {
        const result = await v.handlers.get(tool)(args);
        await check(v.root, result);
      } finally {
        await v.cleanup();
      }
    });
  }
});

// ─── write targets ─────────────────────────────────────────────────────

describe("write tools only accept .md notes outside dot-folders", () => {
  // [existing file, a not-yet-existing path of the same kind]
  const BAD_PATHS = [
    [".obsidian/x.md", ".obsidian/new.md"],
    [".git/config", ".git/hooks/post-checkout"],
    ["notes/x.css", "notes/new.css"],
    [".trash/x.md", ".trash/new.md"],
    ["notes/.hidden/x.md", "notes/.hidden/new.md"],
  ];
  const WRITE_TOOLS = [
    ["vault_write", (_existing, fresh) => ({ template: "note", path: fresh })],
    ["vault_append", (existing) => ({ path: existing, content: "pwned" })],
    ["vault_edit", (existing) => ({ path: existing, old_string: "marker", new_string: "pwned" })],
    ["vault_update_frontmatter", (existing) => ({ path: existing, fields: { status: "pwned" } })],
    ["vault_add_links", (existing) => ({ path: existing, links: [{ target: "notes/b.md" }] })],
    ["vault_move (source)", (existing) => ({ old_path: existing, new_path: "notes/moved.md" })],
    ["vault_move (destination)", (_existing, fresh) => ({ old_path: "notes/b.md", new_path: fresh })],
  ];
  for (const [label, argsFor] of WRITE_TOOLS) {
    for (const [existing, fresh] of BAD_PATHS) {
      it(`${label} refuses ${label.includes("destination") || label === "vault_write" ? fresh : existing}`, async () => {
        const v = await makeVault();
        try {
          const before = await snapshot(v.root);
          const tool = label.split(" ")[0];
          await assert.rejects(
            () => v.handlers.get(tool)(argsFor(existing, fresh)),
            /Write tools only accept \.md notes outside dot-folders/
          );
          assert.deepEqual(await snapshot(v.root), before);
        } finally {
          await v.cleanup();
        }
      });
    }
  }
});

describe("vault_trash and folders", () => {
  it("vault_trash refuses a folder and leaves it in place", async () => {
    const v = await makeVault();
    try {
      await assert.rejects(
        () => v.handlers.get("vault_trash")({ path: "folder-a" }),
        /Cannot trash a folder: folder-a\..*trash the notes inside it one by one/
      );
      assert.ok(await fs.readFile(path.join(v.root, "folder-a", "inside.md"), "utf-8"));
    } finally {
      await v.cleanup();
    }
  });

  const BAD_TRASH = [".git/config", ".obsidian/app.json", "notes/x.css", ".trash/old.md"];
  for (const rel of BAD_TRASH) {
    it(`vault_trash refuses non-note and dot-folder target ${rel}`, async () => {
      const v = await makeVault();
      try {
        await fs.mkdir(path.dirname(path.join(v.root, rel)), { recursive: true });
        await fs.writeFile(path.join(v.root, rel), "keep\n");
        const before = await snapshot(v.root);
        await assert.rejects(() => v.handlers.get("vault_trash")({ path: rel }), /Write tools only accept \.md notes outside dot-folders/);
        assert.deepEqual(await snapshot(v.root), before);
      } finally {
        await v.cleanup();
      }
    });
  }

  it("vault_trash gives dot-folder directories the write-rule message and normal folders the folder message", async () => {
    const v = await makeVault();
    try {
      await assert.rejects(() => v.handlers.get("vault_trash")({ path: ".obsidian" }), /Write tools only accept \.md notes outside dot-folders/);
      await assert.rejects(() => v.handlers.get("vault_trash")({ path: "folder-a" }), /Cannot trash a folder: folder-a/);
    } finally {
      await v.cleanup();
    }
  });

  it("vault_move still moves a folder", async () => {
    const v = await makeVault();
    try {
      await v.handlers.get("vault_move")({ old_path: "folder-a", new_path: "folder-b" });
      assert.ok(await fs.readFile(path.join(v.root, "folder-b", "inside.md"), "utf-8"));
    } finally {
      await v.cleanup();
    }
  });

  const BAD_FOLDER_MOVES = [
    ["into a dot-folder", { old_path: "folder-a", new_path: ".trash/folder-a" }],
    ["out of a dot-folder", { old_path: ".obsidian", new_path: "obsidian-copy" }],
    ["the vault root", { old_path: "", new_path: "root-copy" }],
  ];
  for (const [label, args] of BAD_FOLDER_MOVES) {
    it(`vault_move refuses moving a folder ${label}`, async () => {
      const v = await makeVault();
      try {
        const before = await snapshot(v.root);
        await assert.rejects(() => v.handlers.get("vault_move")(args), /only moves folders outside dot-folders, and never the vault root/);
        assert.deepEqual(await snapshot(v.root), before);
      } finally {
        await v.cleanup();
      }
    });
  }
});

// ─── vault root normalisation ─────────────────────────────────────────

describe("vault root normalisation", () => {
  it("createHandlers works with a vaultPath that ends in a separator", async () => {
    const v = await makeVault({ vaultPathSuffix: path.sep });
    try {
      const read = await v.handlers.get("vault_read")({ path: "notes/a.md" });
      assert.match(read.content[0].text, /# A/);
      await v.handlers.get("vault_append")({ path: "notes/a.md", content: "trailing ok" });
      assert.match(await fs.readFile(path.join(v.root, "notes", "a.md"), "utf-8"), /trailing ok/);
      await assert.rejects(() => v.handlers.get("vault_append")({ path: "../x.md", content: "x" }), /escapes vault/);
    } finally {
      await v.cleanup();
    }
  });

  it("createHandlers works on a vault reached through a symlinked path (e.g. /var -> /private/var)", async () => {
    const v = await makeVault();
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "safety-link-"));
    const linkedRoot = path.join(linkParent, "vault");
    await fs.symlink(v.root, linkedRoot, DIR_LINK);
    try {
      const templateRegistry = new Map([["note", { content: NOTE_TEMPLATE, description: "note" }]]);
      const h = await createHandlers({ vaultPath: linkedRoot, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "linked" });
      assert.match((await h.get("vault_read")({ path: "notes/a.md" })).content[0].text, /# A/);
      await h.get("vault_append")({ path: "notes/a.md", content: "linked ok" });
      await h.get("vault_write")({ template: "note", path: "notes/linked-new.md" });
      assert.match(await fs.readFile(path.join(v.root, "notes", "a.md"), "utf-8"), /linked ok/);
      assert.ok(await fs.readFile(path.join(v.root, "notes", "linked-new.md"), "utf-8"));
    } finally {
      await fs.rm(linkParent, { recursive: true, force: true });
      await v.cleanup();
    }
  });

  it("resolveProject accepts a VAULT_PATH that ends in a separator", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "safety-project-"));
    try {
      const vaultPath = path.join(tmpDir, "vault");
      await fs.mkdir(path.join(vaultPath, "01-Projects", "Annotated"), { recursive: true });
      const cwd = path.join(tmpDir, "repo-with-other-name");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "CLAUDE.md"), "# PKM: 01-Projects/Annotated\n");
      const result = await resolveProject(cwd, vaultPath + path.sep);
      assert.equal(result.projectPath, "01-Projects/Annotated");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
