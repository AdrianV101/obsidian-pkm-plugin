import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { createHandlers } from "../handlers.js";
import { getAllMarkdownFiles } from "../vault-fs.js";
import { isMainModule } from "../index.js";

// These pin the "/"-separator boundary. On POSIX they are guards; the windows-latest
// CI job is where a stray path.join/path.relative on a vault-relative path would fail.

const note = (title, body = "") => `---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n# ${title}\n\n${body}\n`;

let root;
let handlers;
let semanticFolders;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "winpaths-vault-"));
  const files = {
    "a/b/deep.md": note("Deep", "needle"),
    "a/b/orphan.md": note("Orphan"),
    "a/b/trash-me.md": note("Trash me"),
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  semanticFolders = [];
  handlers = await createHandlers({
    vaultPath: root,
    templateRegistry: new Map(),
    semanticIndex: {
      isAvailable: true,
      searchRaw: async () => [],
      search: async ({ folder }) => {
        semanticFolders.push(folder);
        return "No semantically related notes found.";
      },
    },
    activityLog: null,
    sessionId: "winpaths-test",
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("vault-relative paths use '/' on every platform", () => {
  it("getAllMarkdownFiles returns '/'-separated paths for nested notes", async () => {
    const files = await getAllMarkdownFiles(root);
    assert.ok(files.includes("a/b/deep.md"), JSON.stringify(files));
    assert.ok(files.every((f) => !f.includes("\\")));
  });

  const OUTPUTS = [
    ["vault_search with a folder", { query: "needle", folder: "a" }, "vault_search"],
    ["vault_list recursive", { path: "a", recursive: true }, "vault_list"],
    ["vault_recent with a folder", { folder: "a" }, "vault_recent"],
    ["vault_query with a folder", { type: "note", folder: "a" }, "vault_query"],
    ["vault_link_health with a folder", { folder: "a/b", checks: ["orphans"] }, "vault_link_health"],
  ];
  for (const [label, args, tool] of OUTPUTS) {
    it(`${label} reports nested notes with '/'`, async () => {
      const text = (await handlers.get(tool)(args)).content[0].text;
      assert.match(text, /\[a\/b\/(deep|orphan|trash-me)\.md\]/);
      assert.doesNotMatch(text, /a\\b/);
    });
  }

  it("vault_trash reports the .trash destination with '/'", async () => {
    const text = (await handlers.get("vault_trash")({ path: "a/b/trash-me.md" })).content[0].text;
    assert.match(text, /\[\.trash\/a\/b\/trash-me\.md\]/);
  });

  it("vault_semantic_search passes a '/'-separated folder to the index", async () => {
    await handlers.get("vault_semantic_search")({ query: "x", folder: "a/b" });
    assert.deepEqual(semanticFolders, ["a/b"]);
  });
});

describe("isMainModule", () => {
  const CASES = [
    ["a POSIX path with a space", "/opt/my tools/index.js", pathToFileURL("/opt/my tools/index.js", { windows: false }).href, false, true],
    ["a Windows path", "C:\\Users\\me\\AppData\\index.js", "file:///C:/Users/me/AppData/index.js", true, true],
    ["a different script", "/opt/other.js", pathToFileURL("/opt/index.js", { windows: false }).href, false, false],
    ["no argv[1]", undefined, pathToFileURL("/opt/index.js", { windows: false }).href, false, false],
  ];
  for (const [label, argv1, metaUrl, windows, expected] of CASES) {
    it(`is ${expected} for ${label}`, () => {
      assert.equal(isMainModule(metaUrl, argv1, { windows }), expected);
    });
  }
});
