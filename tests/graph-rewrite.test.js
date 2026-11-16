import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteWikilinks, createLinkResolver } from "../graph.js";

/** Rewrite as vault_move does: resolver over the pre-move file list. */
function rewrite(content, { files, movedFrom, newTarget }) {
  return rewriteWikilinks(content, { resolver: createLinkResolver(files), movedFrom, newTarget });
}

const MOVE = { files: ["notes/target.md", "notes/other.md"], movedFrom: "notes/target.md", newTarget: "renamed" };

describe("rewriteWikilinks", () => {
  it("rewrites [[old]] to [[new]]", () => {
    assert.equal(rewrite("See [[target]] for details.", MOVE), "See [[renamed]] for details.");
  });

  it("preserves fragment, alias, table-escaped alias and embed syntax", () => {
    const cases = [
      ["[[target|Target Display]]", "[[renamed|Target Display]]"],
      ["[[target#section-a]]", "[[renamed#section-a]]"],
      ["[[target#section-a|Section A]]", "[[renamed#section-a|Section A]]"],
      ["[[target#^block-1]]", "[[renamed#^block-1]]"],
      ["[[target^block-1]]", "[[renamed^block-1]]"],
      ["| [[target\\|Alias]] |", "| [[renamed\\|Alias]] |"],
      ["![[target]]", "![[renamed]]"],
      ["![[target#Heading|300]]", "![[renamed#Heading|300]]"],
      ["[[target.md]]", "[[renamed]]"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(rewrite(input, MOVE), expected, input);
    }
  });

  it("rewrites multiple occurrences in one file", () => {
    const content = "First [[target]], then [[target|alias]], and [[target#h]].";
    assert.equal(rewrite(content, MOVE), "First [[renamed]], then [[renamed|alias]], and [[renamed#h]].");
  });

  it("does not rewrite links to other targets", () => {
    assert.equal(rewrite("See [[target]] and [[other]].", MOVE), "See [[renamed]] and [[other]].");
  });

  it("rewrites full-path links: [[folder/target]] to the new path", () => {
    const content = "See [[moveable/target]] for details.";
    const result = rewrite(content, { files: ["moveable/target.md"], movedFrom: "moveable/target.md", newTarget: "archive/target" });
    assert.equal(result, "See [[archive/target]] for details.");
  });

  it("returns content unchanged when no matching links", () => {
    const content = "No links to [[something-else]].";
    assert.equal(rewrite(content, MOVE), content);
  });

  it("matches case-insensitively", () => {
    const content = "See [[My-Note]] for details and [[my-note#heading]] too.";
    const result = rewrite(content, { files: ["my-note.md"], movedFrom: "my-note.md", newTarget: "renamed-note" });
    assert.strictEqual(result, "See [[renamed-note]] for details and [[renamed-note#heading]] too.");
  });

  it("rewrites only links that resolve unambiguously to the moved note", () => {
    const content = "[[note]] [[a/note]] [[b/note]] [[A/Note#h|x]]";
    const result = rewrite(content, { files: ["a/note.md", "b/note.md"], movedFrom: "a/note.md", newTarget: "archive/note" });
    assert.equal(result, "[[note]] [[archive/note]] [[b/note]] [[archive/note#h|x]]");
  });

  it("never rewrites links inside fenced code or inline code", () => {
    const content = "[[target]]\n```\n[[target]]\n```\n`[[target]]` and ~~~ not a fence ~~~ [[target]]";
    assert.equal(
      rewrite(content, MOVE),
      "[[renamed]]\n```\n[[target]]\n```\n`[[target]]` and ~~~ not a fence ~~~ [[renamed]]"
    );
  });
});
