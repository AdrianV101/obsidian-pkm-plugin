import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatterText,
  extractFrontmatter,
  renderFrontmatter,
  updateFrontmatter,
} from "../frontmatter.js";

describe("parseFrontmatterText", () => {
  for (const [name, yamlText, expected] of [
    ["dates stay strings", "created: 2026-01-01\n", { created: "2026-01-01" }],
    ["timestamps stay strings", "at: 2026-01-01T10:00:00Z\n", { at: "2026-01-01T10:00:00Z" }],
    ["decimal numbers are numbers", "version: 1.10\n", { version: 1.1 }],
    ["leading-zero integers are decimal numbers", "zip: 01234\n", { zip: 1234 }],
    ["true/false are booleans", "resolved: false\n", { resolved: false }],
    ["null, ~ and empty values are null", "a: null\nb: ~\nc:\n", { a: null, b: null, c: null }],
    ["YAML 1.1 yes/no/on/off stay strings", "a: yes\nb: off\n", { a: "yes", b: "off" }],
    ["binary-looking values stay strings", "mask: 0b101\n", { mask: "0b101" }],
    ["inline and block lists are arrays", "a: [x, y]\nb:\n  - z\n", { a: ["x", "y"], b: ["z"] }],
  ]) {
    it(`uses the YAML 1.2 core schema: ${name}`, () => {
      assert.deepEqual(parseFrontmatterText(yamlText), expected);
    });
  }

  for (const [name, yamlText] of [
    ["empty text", ""],
    ["comment only", "# nothing here\n"],
  ]) {
    it(`returns null for an empty document: ${name}`, () => {
      assert.equal(parseFrontmatterText(yamlText), null);
    });
  }

  for (const [name, yamlText] of [
    ["invalid YAML", ": invalid: yaml: [broken\n"],
    ["duplicate keys", "a: 1\na: 2\n"],
    ["a scalar document", "just text\n"],
    ["a list document", "- a\n- b\n"],
    ["an alias bomb", "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: [*d, *d, *d, *d, *d, *d, *d, *d, *d]\n"],
  ]) {
    it(`throws "Failed to parse frontmatter" for ${name}`, () => {
      assert.throws(() => parseFrontmatterText(yamlText), /^Error: Failed to parse frontmatter: /);
    });
  }
});

describe("extractFrontmatter", () => {
  it("parses CRLF frontmatter without carrying \\r into values", () => {
    assert.deepEqual(extractFrontmatter("---\r\ntype: x\r\ntags:\r\n  - a\r\n---\r\nBody\r\n"), { type: "x", tags: ["a"] });
  });

  for (const [name, content] of [
    ["a scalar", "---\njust text\n---\n"],
    ["a list", "---\n- a\n---\n"],
  ]) {
    it(`returns null when the frontmatter is not key-value pairs: ${name}`, () => {
      assert.equal(extractFrontmatter(content), null);
    });
  }
});

describe("renderFrontmatter", () => {
  it("quotes the live repro value so the note's frontmatter stays valid", () => {
    assert.equal(
      renderFrontmatter({ topic: "Review fixes: release hygiene + correctness" }),
      "topic: \"Review fixes: release hygiene + correctness\"\n"
    );
  });

  for (const [name, value] of [
    ["colon-space", "a: b"],
    ["leading #", "#notag"],
    ["newline", "line one\nline two"],
    ["number-like", "1.10"],
    ["leading zero", "01234"],
    ["boolean-like", "true"],
    ["null-like", "null"],
    ["list-marker", "- x"],
    ["backticks", "`x`"],
    ["empty string", ""],
    ["double quotes", "say \"hi\""],
    ["long line", "word ".repeat(40).trim()],
    ["number", 3],
    ["boolean", false],
    ["null", null],
    ["array", ["a", "b: c"]],
  ]) {
    it(`round-trips through parseFrontmatterText: ${name}`, () => {
      assert.deepEqual(parseFrontmatterText(renderFrontmatter({ v: value })), { v: value });
    });
  }

  it("keeps key insertion order and renders arrays as block lists", () => {
    assert.equal(
      renderFrontmatter({ type: "task", tags: ["a", "b"], created: "2026-10-13" }),
      "type: task\ntags:\n  - a\n  - b\ncreated: 2026-10-13\n"
    );
  });

  it("renders an empty object as an empty string", () => {
    assert.equal(renderFrontmatter({}), "");
  });
});

describe("updateFrontmatter (byte-preserving)", () => {
  const original = [
    "---",
    "type: task # the note type",
    "version: 1.10",
    "zip: 01234",
    "title: 'Single quoted'",
    "aliases: [one, \"two\"]",
    "# a standalone comment",
    "status: pending",
    "tags:",
    "  - task",
    "  - home",
    "priority: high   # was normal",
    "---",
    "# Body",
    "",
  ].join("\n");

  it("rewrites only the changed key's line; everything else is preserved byte for byte", () => {
    const { content } = updateFrontmatter(original, { status: "done" });
    assert.equal(content, original.replace("status: pending\n", "status: done\n"));
  });

  it("replaces a multi-line value in place without touching its neighbours", () => {
    const { content } = updateFrontmatter(original, { tags: ["task", "garden"] });
    assert.equal(content, original.replace("tags:\n  - task\n  - home\n", "tags:\n  - task\n  - garden\n"));
  });

  it("deletes only the removed keys' lines, including block lists and inline comments", () => {
    const { content } = updateFrontmatter(original, { priority: null, aliases: null });
    assert.equal(content, original.replace("priority: high   # was normal\n", "").replace("aliases: [one, \"two\"]\n", ""));
  });

  it("appends new keys before the closing fence in the given order, quoting where needed", () => {
    const { content, frontmatter } = updateFrontmatter(original, { topic: "Review fixes: release hygiene + correctness", due: "2026-11-01" });
    assert.equal(
      content,
      original.replace("priority: high   # was normal\n---", "priority: high   # was normal\ntopic: \"Review fixes: release hygiene + correctness\"\ndue: 2026-11-01\n---")
    );
    assert.equal(frontmatter.topic, "Review fixes: release hygiene + correctness");
  });

  for (const [name, line] of [
    ["key with nothing after the colon", "deciders:"],
    ["key with a trailing space", "deciders: "],
    ["key with only a comment", "deciders: # who decided"],
  ]) {
    it(`replaces an empty-valued key on its own line: ${name}`, () => {
      const content = `---\ntype: adr\n${line}\ncreated: 2026-01-01\n---\nBody\n`;
      assert.equal(
        updateFrontmatter(content, { deciders: "The Team" }).content,
        "---\ntype: adr\ndeciders: The Team\ncreated: 2026-01-01\n---\nBody\n"
      );
    });
  }

  it("keeps CRLF line endings on untouched, replaced, and inserted lines", () => {
    const content = "---\r\ntype: task\r\nstatus: pending\r\ntags:\r\n  - task\r\n---\r\nBody\r\n";
    assert.equal(
      updateFrontmatter(content, { status: "done", tags: ["a", "b"], completed: "2026-02-11" }).content,
      "---\r\ntype: task\r\nstatus: done\r\ntags:\r\n  - a\r\n  - b\r\ncompleted: 2026-02-11\r\n---\r\nBody\r\n"
    );
  });

  for (const [name, content, expected] of [
    ["---\\n---\\n", "---\n---\n", "---\nstatus: done\n---\n"],
    ["---\\n--- at end of file", "---\n---", "---\nstatus: done\n---"],
  ]) {
    it(`adds fields to empty frontmatter: ${name}`, () => {
      const result = updateFrontmatter(content, { status: "done" });
      assert.equal(result.content, expected);
      assert.deepEqual(result.frontmatter, { status: "done" });
    });
  }

  for (const [name, content] of [
    ["a scalar", "---\njust text\n---\nBody"],
    ["a list", "---\n- a\n---\nBody"],
    ["a flow mapping", "---\n{status: open}\n---\nBody"],
  ]) {
    it(`refuses frontmatter that is not a block mapping instead of overwriting it: ${name}`, () => {
      assert.throws(() => updateFrontmatter(content, { status: "done" }), /^Error: Failed to parse frontmatter: expected key-value pairs$/);
    });
  }
});
