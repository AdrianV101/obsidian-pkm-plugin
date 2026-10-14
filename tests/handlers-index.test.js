import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHandlers } from "../handlers.js";

const NOTE_TEMPLATE = `---
type: note
created: <% tp.date.now("YYYY-MM-DD") %>
tags:
  - test
---
# <% tp.file.title %>
`;

const note = (title, body = "") => `---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n# ${title}\n\n${body}\n`;

async function makeVault() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-handlers-"));
  await fs.mkdir(path.join(root, "05-Templates"), { recursive: true });
  await fs.writeFile(path.join(root, "05-Templates", "note.md"), NOTE_TEMPLATE);
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "hub.md"), note("Hub"));
  await fs.writeFile(path.join(root, "notes", "target.md"), note("Target"));
  const handlers = await createHandlers({
    vaultPath: root,
    templateRegistry: new Map([["note", { content: NOTE_TEMPLATE, description: "note" }]]),
    semanticIndex: null,
    activityLog: null,
    sessionId: "index-test",
  });
  const addLater = async (rel, content) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  };
  return { root, handlers, addLater, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("the file index follows the vault after createHandlers", () => {
  it("a note created on disk after createHandlers is readable by exact path and by fuzzy name", async () => {
    const v = await makeVault();
    try {
      await v.addLater("late/exact-note.md", note("Exact Late"));
      await v.addLater("late/fuzzy-note.md", note("Fuzzy Late"));
      const exact = await v.handlers.get("vault_read")({ path: "late/exact-note.md" });
      assert.match(exact.content[0].text, /# Exact Late/);
      const fuzzy = await v.handlers.get("vault_read")({ path: "fuzzy-note" });
      assert.match(fuzzy.content[0].text, /# Fuzzy Late/);
    } finally {
      await v.cleanup();
    }
  });

  it("vault_write, vault_move and vault_trash keep fuzzy resolution in step", async () => {
    const v = await makeVault();
    try {
      await v.handlers.get("vault_write")({ template: "note", path: "made/written-note.md" });
      assert.match((await v.handlers.get("vault_read")({ path: "written-note" })).content[0].text, /# written-note/);

      await v.handlers.get("vault_move")({ old_path: "made/written-note.md", new_path: "made/moved-note.md" });
      assert.match((await v.handlers.get("vault_read")({ path: "moved-note" })).content[0].text, /# written-note/);
      await assert.rejects(() => v.handlers.get("vault_read")({ path: "written-note" }), /File not found/);

      await v.handlers.get("vault_trash")({ path: "made/moved-note.md" });
      await assert.rejects(() => v.handlers.get("vault_read")({ path: "moved-note" }), /File not found/);
    } finally {
      await v.cleanup();
    }
  });

  const SCANNERS = [
    ["vault_add_links accepts a target created later", async (v) => {
      await v.addLater("late/new-target.md", note("New Target"));
      const result = await v.handlers.get("vault_add_links")({ path: "notes/hub.md", links: [{ target: "late/new-target.md" }] });
      assert.match(result.content[0].text, /Added 1 link/);
    }],
    ["vault_move rewrites a referrer created later", async (v) => {
      await v.addLater("late/referrer.md", note("Referrer", "See [[target]]."));
      await v.handlers.get("vault_move")({ old_path: "notes/target.md", new_path: "notes/renamed-target.md" });
      assert.match(await fs.readFile(path.join(v.root, "late", "referrer.md"), "utf-8"), /\[\[renamed-target\]\]/);
    }],
    ["vault_trash warns about a linker created later", async (v) => {
      await v.addLater("late/linker.md", note("Linker", "See [[target]]."));
      const result = await v.handlers.get("vault_trash")({ path: "notes/target.md" });
      assert.match(result.content[0].text, /late\/linker\.md/);
    }],
    ["vault_links lists an incoming link from a note created later", async (v) => {
      await v.addLater("late/linker.md", note("Linker", "See [[target]]."));
      const result = await v.handlers.get("vault_links")({ path: "notes/target.md", direction: "incoming" });
      assert.match(result.content[0].text, /late\/linker\.md/);
    }],
    ["vault_link_health scans a note created later", async (v) => {
      await v.addLater("late/orphan.md", note("Orphan"));
      const result = await v.handlers.get("vault_link_health")({ checks: ["orphans"] });
      assert.match(result.content[0].text, /late\/orphan\.md/);
    }],
  ];
  for (const [label, run] of SCANNERS) {
    it(`link scans list notes fresh from disk: ${label}`, async () => {
      const v = await makeVault();
      try {
        await run(v);
      } finally {
        await v.cleanup();
      }
    });
  }

  it("folder tools accept a folder created after createHandlers by its exact name", async () => {
    const v = await makeVault();
    try {
      await v.addLater("fresh-folder/inside.md", note("Inside", "needle"));
      const result = await v.handlers.get("vault_search")({ query: "needle", folder: "fresh-folder" });
      assert.match(result.content[0].text, /fresh-folder\/inside\.md/);
    } finally {
      await v.cleanup();
    }
  });
  it("moving a folder re-keys its notes: they stay linkable, trashable and readable by new path and by name", async () => {
    const v = await makeVault();
    try {
      await v.addLater("old-dir/inner-note.md", note("Inner", "See [[target]]."));
      await v.handlers.get("vault_read")({ path: "old-dir/inner-note.md" });
      await v.handlers.get("vault_move")({ old_path: "old-dir", new_path: "new-dir/sub" });

      const byPath = await v.handlers.get("vault_read")({ path: "new-dir/sub/inner-note.md" });
      assert.match(byPath.content[0].text, /# Inner/);
      const byName = await v.handlers.get("vault_read")({ path: "inner-note" });
      assert.match(byName.content[0].text, /# Inner/);
      await assert.rejects(() => v.handlers.get("vault_read")({ path: "old-dir/inner-note.md" }), /File not found/);

      const links = await v.handlers.get("vault_links")({ path: "new-dir/sub/inner-note.md" });
      assert.match(links.content[0].text, /\[\[target\]\]/);
      await v.handlers.get("vault_move")({ old_path: "new-dir/sub/inner-note.md", new_path: "new-dir/sub/inner-2.md" });
      const trashed = await v.handlers.get("vault_trash")({ path: "new-dir/sub/inner-2.md" });
      assert.match(trashed.content[0].text, /Trashed new-dir\/sub\/inner-2\.md/);
    } finally {
      await v.cleanup();
    }
  });

  it("vault_move with backslash paths indexes the file under its normalised path", async () => {
    const v = await makeVault();
    try {
      await v.handlers.get("vault_move")({ old_path: "notes\\target.md", new_path: "notes\\target2.md" });
      assert.ok(await fs.stat(path.join(v.root, "notes", "target2.md")));
      const read = await v.handlers.get("vault_read")({ path: "target2" });
      assert.match(read.content[0].text, /# Target/);
      await assert.rejects(() => v.handlers.get("vault_read")({ path: "target" }), /File not found/);
    } finally {
      await v.cleanup();
    }
  });

  it("vault_trash with a backslash path trashes under a normalised .trash path and drops the index entry", async () => {
    const v = await makeVault();
    try {
      await v.handlers.get("vault_trash")({ path: "notes\\target.md" });
      assert.ok(await fs.stat(path.join(v.root, ".trash", "notes", "target.md")));
      assert.deepEqual((await fs.readdir(path.join(v.root, ".trash"))).sort(), ["notes"]);
      await assert.rejects(() => v.handlers.get("vault_read")({ path: "target" }), /File not found/);
    } finally {
      await v.cleanup();
    }
  });
});
