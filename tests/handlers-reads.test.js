import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createHandlers } from "../handlers.js";

const fm = (lines, body = "") => `---\n${lines.join("\n")}\n---\n# Note\n\n${body}\n`;

const FILES = {
  "notes/scalar-string.md": fm(["type: scalar", "created: 2026-01-01", "tags: dev"]),
  "notes/scalar-number.md": fm(["type: scalar-number", "created: 2026-01-01", "tags: 2024"]),
  "notes/scalar-bool.md": fm(["type: scalar-bool", "created: 2026-01-01", "tags: true"]),
  "projects/my-app/research/findings.md": fm(["type: research", "created: 2026-01-01", "tags:", "  - research"]),
  "notes/source.md": fm(["type: note", "created: 2026-01-01", "tags:", "  - test"], "Source body text."),
  "notes/other.md": fm(["type: note", "created: 2026-01-01", "tags:", "  - test"]),
  "notes/three-matches.md": "intro\ndup\nx\nx\ndup\nx\nx\nx\ndup\n",
  "notes/twelve-matches.md": Array.from({ length: 12 }, () => "dup").join("\n") + "\n",
  "notes/multiline-matches.md": "a\nb\nfoo\nbar\nc\nd\nfoo\nbar\n",
};

let root;
let handlers;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "reads-vault-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const semanticResults = [
    { path: "notes/source.md", score: 0.99, preview: "itself" },
    { path: "notes/other.md", score: 0.8, preview: "other" },
  ];
  handlers = await createHandlers({
    vaultPath: root,
    templateRegistry: new Map(),
    semanticIndex: {
      isAvailable: true,
      searchRaw: async ({ limit, excludeFiles }) => semanticResults.filter(r => !excludeFiles?.has(r.path)).slice(0, limit),
      search: async () => "",
    },
    activityLog: null,
    sessionId: "reads-test",
  });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("vault_query", () => {
  const SCALAR_TAGS = [
    ["a string", { tags: ["dev"] }, "notes/scalar-string.md"],
    ["a number", { tags: ["2024"] }, "notes/scalar-number.md"],
    ["a boolean", { tags_any: ["true", "nope"] }, "notes/scalar-bool.md"],
  ];
  for (const [label, filter, expected] of SCALAR_TAGS) {
    it(`treats a scalar tags value (${label}) as a one-element list`, async () => {
      const result = await handlers.get("vault_query")(filter);
      assert.match(result.content[0].text, new RegExp(expected.replace(/[.]/g, "\\.")));
    });
  }

  it("lists a note whose tags value is a scalar and shows that tag", async () => {
    const result = await handlers.get("vault_query")({ type: "scalar" });
    assert.match(result.content[0].text, /notes\/scalar-string\.md/);
    assert.match(result.content[0].text, /tags: dev/);
  });

  it("returns vault-relative paths when the folder argument is fuzzy", async () => {
    const result = await handlers.get("vault_query")({ type: "research", folder: "my-app" });
    assert.match(result.content[0].text, /\[projects\/my-app\/research\/findings\.md\]/);
  });
});

describe("vault_edit", () => {
  const MULTI = [
    ["three single-line matches", "notes/three-matches.md", "dup", "Found 3 matches", "(lines 2, 5, 9)"],
    ["more than ten matches", "notes/twelve-matches.md", "dup", "Found 12 matches", "(lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, +2 more)"],
    ["a multi-line old_string", "notes/multiline-matches.md", "foo\nbar", "Found 2 matches", "(lines 3, 7)"],
  ];
  for (const [label, file, oldString, countText, linesText] of MULTI) {
    it(`the multiple-match error lists the line of each match, at most 10 (${label})`, async () => {
      const before = await fs.readFile(path.join(root, file), "utf-8");
      const result = await handlers.get("vault_edit")({ path: file, old_string: oldString, new_string: "x" });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes(countText), result.content[0].text);
      assert.ok(result.content[0].text.includes(linesText), result.content[0].text);
      assert.equal(await fs.readFile(path.join(root, file), "utf-8"), before);
    });
  }
});

describe("vault_suggest_links", () => {
  it("excludes the source note when it is given by a fuzzy name", async () => {
    const result = await handlers.get("vault_suggest_links")({ path: "source" });
    assert.doesNotMatch(result.content[0].text, /notes\/source\.md/);
    assert.match(result.content[0].text, /notes\/other\.md/);
  });
});
