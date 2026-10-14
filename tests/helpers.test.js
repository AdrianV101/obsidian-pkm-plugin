import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { extractFrontmatter, parseFrontmatterText } from "../frontmatter.js";
import {
  resolvePath,
  matchesFilters,
  formatMetadata,
  countOccurrences,
  extractTemplateDescription,
  substituteTemplateVariables,
  validateFrontmatterStrict,
  extractInlineTags,
  matchesTagPattern,
  findTailSections,
  capReadOutput,
  buildBasenameMap,
  resolveFuzzyFolder,
  computePeek,
  formatPeek,
  updateFrontmatter,
  validateFieldEnum,
  compareFrontmatterValues,
  AUTO_REDIRECT_THRESHOLD,
  FORCE_HARD_CAP,
  CHUNK_SIZE,
  computeProximityBonus,
  blendWithGraph,
  obsidianLink,
} from "../helpers.js";

describe("resolvePath", () => {
  const vault = "/home/user/vault";

  it("resolves a simple relative path", () => {
    assert.equal(resolvePath("notes/hello.md", vault), path.join(vault, "notes/hello.md"));
  });

  it("resolves empty string to vault root", () => {
    assert.equal(resolvePath("", vault), vault);
  });

  it("throws on directory traversal with ../", () => {
    assert.throws(() => resolvePath("../etc/passwd", vault), /escapes vault/);
  });

  it("throws on absolute path outside vault", () => {
    assert.throws(() => resolvePath("/etc/passwd", vault), /escapes vault/);
  });

  it("blocks prefix-based bypass (vault-evil)", () => {
    // /home/user/vault-evil starts with /home/user/vault but is outside
    assert.throws(() => resolvePath("../vault-evil/file.md", "/home/user/vault"), /escapes vault/);
  });

  it("allows nested path within vault", () => {
    const result = resolvePath("a/b/c/d.md", vault);
    assert.equal(result, path.join(vault, "a/b/c/d.md"));
  });

  it("normalizes redundant separators", () => {
    const result = resolvePath("notes//hello.md", vault);
    assert.ok(result.startsWith(vault));
  });
});

describe("matchesFilters", () => {
  const meta = {
    type: "research",
    status: "active",
    tags: ["dev", "MCP", "tools"],
    created: "2025-06-15",
  };

  it("returns false for null metadata", () => {
    assert.equal(matchesFilters(null, { type: "research" }), false);
  });

  it("matches type filter", () => {
    assert.equal(matchesFilters(meta, { type: "research" }), true);
    assert.equal(matchesFilters(meta, { type: "adr" }), false);
  });

  it("matches status filter", () => {
    assert.equal(matchesFilters(meta, { status: "active" }), true);
    assert.equal(matchesFilters(meta, { status: "archived" }), false);
  });

  it("matches tags (all required)", () => {
    assert.equal(matchesFilters(meta, { tags: ["dev", "mcp"] }), true);
    assert.equal(matchesFilters(meta, { tags: ["dev", "nonexistent"] }), false);
  });

  it("tags matching is case-insensitive", () => {
    assert.equal(matchesFilters(meta, { tags: ["DEV", "MCP"] }), true);
  });

  it("matches tags_any (any one required)", () => {
    assert.equal(matchesFilters(meta, { tags_any: ["nonexistent", "dev"] }), true);
    assert.equal(matchesFilters(meta, { tags_any: ["nonexistent", "other"] }), false);
  });

  it("matches created_after", () => {
    assert.equal(matchesFilters(meta, { created_after: "2025-06-01" }), true);
    assert.equal(matchesFilters(meta, { created_after: "2025-07-01" }), false);
  });

  it("matches created_before", () => {
    assert.equal(matchesFilters(meta, { created_before: "2025-12-31" }), true);
    assert.equal(matchesFilters(meta, { created_before: "2025-01-01" }), false);
  });

  it("handles Date objects in created field", () => {
    const metaWithDate = { ...meta, created: new Date("2025-06-15") };
    assert.equal(matchesFilters(metaWithDate, { created_after: "2025-06-01" }), true);
  });

  it("matches with empty filter object", () => {
    assert.equal(matchesFilters(meta, {}), true);
  });

  it("handles null tags in metadata gracefully", () => {
    const noTags = { type: "research" };
    assert.equal(matchesFilters(noTags, { tags: ["dev"] }), false);
  });

  it("matches custom_fields with exact string value", () => {
    const meta = { type: "task", status: "pending", priority: "high", tags: ["task"] };
    assert.ok(matchesFilters(meta, { custom_fields: { priority: "high" } }));
    assert.ok(!matchesFilters(meta, { custom_fields: { priority: "low" } }));
  });

  it("matches custom_fields with null (field missing or null)", () => {
    const meta = { type: "task", status: "pending", tags: ["task"] };
    assert.ok(matchesFilters(meta, { custom_fields: { due: null } }));
    assert.ok(!matchesFilters(meta, { custom_fields: { status: null } }));
  });

  it("matches custom_fields with Date values in metadata", () => {
    const meta = { type: "task", created: new Date("2026-02-10"), tags: ["task"] };
    assert.ok(matchesFilters(meta, { custom_fields: { created: "2026-02-10" } }));
  });

  it("custom_fields composes with other filters", () => {
    const meta = { type: "task", status: "pending", priority: "high", tags: ["task", "home"] };
    assert.ok(matchesFilters(meta, { type: "task", custom_fields: { priority: "high" } }));
    assert.ok(!matchesFilters(meta, { type: "task", custom_fields: { priority: "low" } }));
  });

  it("matches multiple custom_fields (all must match)", () => {
    const meta = { type: "task", priority: "high", project: "Home", tags: ["task"] };
    assert.ok(matchesFilters(meta, { custom_fields: { priority: "high", project: "Home" } }));
    assert.ok(!matchesFilters(meta, { custom_fields: { priority: "high", project: "Work" } }));
  });

  it("ignores dangerous keys in custom_fields", () => {
    const metadata = { type: "note", tags: ["test"], created: "2026-01-01" };
    const filters = {
      custom_fields: { __proto__: "foo", constructor: "bar", project: null }
    };
    const result = matchesFilters(metadata, filters);
    assert.strictEqual(result, true, "should ignore dangerous keys and match on remaining fields");
  });
});

describe("formatMetadata", () => {
  it("formats type, status, and created", () => {
    const { summary } = formatMetadata({ type: "adr", status: "accepted", created: "2025-01-01" });
    assert.ok(summary.includes("type: adr"));
    assert.ok(summary.includes("status: accepted"));
    assert.ok(summary.includes("created: 2025-01-01"));
  });

  it("formats tags", () => {
    const { tagLine } = formatMetadata({ tags: ["dev", "mcp"] });
    assert.equal(tagLine, "tags: dev, mcp");
  });

  it("returns empty tagLine when no tags", () => {
    const { tagLine } = formatMetadata({ type: "note" });
    assert.equal(tagLine, "");
  });

  it("handles Date objects in created field", () => {
    const { summary } = formatMetadata({ created: new Date("2025-06-15T00:00:00Z") });
    assert.ok(summary.includes("2025-06-15"));
  });
});

describe("countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    assert.equal(countOccurrences("abcabc", "abc"), 2);
  });

  it("returns 0 for empty search string", () => {
    assert.equal(countOccurrences("abc", ""), 0);
  });

  it("returns 0 when not found", () => {
    assert.equal(countOccurrences("hello world", "xyz"), 0);
  });

  it("handles single character", () => {
    assert.equal(countOccurrences("aaa", "a"), 3);
  });

  it("non-overlapping: 'aaa' contains 'aa' once (non-overlapping)", () => {
    assert.equal(countOccurrences("aaa", "aa"), 1);
  });
});

describe("extractTemplateDescription", () => {
  it("extracts from first heading", () => {
    const content = "---\ntype: adr\n---\n\n# ADR-001: Use SQLite\n\nSome content";
    const desc = extractTemplateDescription(content, { type: "adr" });
    assert.ok(desc.includes("ADR-001"));
  });

  it("uses frontmatter description if present", () => {
    const content = "---\ndescription: My custom desc\n---\n\n# Title";
    const desc = extractTemplateDescription(content, { description: "My custom desc" });
    assert.equal(desc, "My custom desc");
  });

  it("replaces template variables with {title}", () => {
    const content = "---\ntype: note\n---\n\n# <% tp.file.title %>";
    const desc = extractTemplateDescription(content, { type: "note" });
    assert.ok(desc.includes("{title}"));
  });

  it("falls back to type-based description", () => {
    const content = "---\ntype: research\n---\n\n<!-- just a comment -->";
    const desc = extractTemplateDescription(content, { type: "research" });
    assert.equal(desc, "Template for research");
  });
});

describe("substituteTemplateVariables", () => {
  it("substitutes date variable", () => {
    const content = "---\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\n---";
    const result = substituteTemplateVariables(content, {});
    assert.ok(!result.includes("tp.date.now"));
    assert.match(result, /\d{4}-\d{2}-\d{2}/);
  });

  it("substitutes file title", () => {
    const content = "# <% tp.file.title %>";
    const result = substituteTemplateVariables(content, { title: "My Note" });
    assert.equal(result, "# My Note");
  });

  it("defaults title to Untitled", () => {
    const content = "# <% tp.file.title %>";
    const result = substituteTemplateVariables(content, {});
    assert.equal(result, "# Untitled");
  });

  it("substitutes custom variables", () => {
    const content = "Hello <% name %>, welcome to <% place %>";
    const result = substituteTemplateVariables(content, {
      custom: { name: "Alice", place: "Wonderland" },
    });
    assert.equal(result, "Hello Alice, welcome to Wonderland");
  });

  it("substitutes frontmatter tags", () => {
    const content = "---\ntags:\n  - default\n---\n\n# Title";
    const result = substituteTemplateVariables(content, {
      frontmatter: { tags: ["custom", "tags"] },
    });
    assert.ok(result.includes("- custom"));
    assert.ok(result.includes("- tags"));
  });

  it("substitutes frontmatter scalar fields", () => {
    const content = "---\nstatus: draft\n---\n\n# Title";
    const result = substituteTemplateVariables(content, {
      frontmatter: { status: "active" },
    });
    assert.ok(result.includes("status: active"));
    assert.ok(!result.includes("status: draft"));
  });

  it("rejects frontmatter keys with regex-special characters (M4 injection)", () => {
    const content = "---\nstatus: draft\n---\n\n# Title";
    assert.throws(
      () => substituteTemplateVariables(content, {
        frontmatter: { "key.*": "injected" },
      }),
      /Invalid frontmatter key/
    );
  });

  it("rejects frontmatter keys starting with a digit", () => {
    const content = "---\nstatus: draft\n---\n\n# Title";
    assert.throws(
      () => substituteTemplateVariables(content, {
        frontmatter: { "1invalid": "value" },
      }),
      /Invalid frontmatter key/
    );
  });

  it("allows valid frontmatter keys with hyphens and underscores", () => {
    const content = "---\nmy-field_1: old\n---\n\n# Title";
    const result = substituteTemplateVariables(content, {
      frontmatter: { "my-field_1": "new" },
    });
    assert.ok(result.includes("my-field_1: new"));
  });

  it("skips null frontmatter values (leaves template default)", () => {
    const template = "---\ntype: task\nstatus: pending\npriority: normal\ndue: null\n---\n# Title\n";
    const result = substituteTemplateVariables(template, {
      title: "Test",
      frontmatter: { status: "done", due: null }
    });
    assert.ok(result.includes("status: done"), "should update status");
    assert.ok(result.includes("due: null"), "should leave due as template default");
  });

  it("skips undefined frontmatter values", () => {
    const template = "---\ntype: task\nstatus: pending\n---\n# Title\n";
    const result = substituteTemplateVariables(template, {
      title: "Test",
      frontmatter: { status: undefined }
    });
    assert.ok(result.includes("status: pending"), "should leave status as template default");
  });

  it("rejects __proto__ frontmatter key (prototype pollution)", () => {
    const template = "---\ntype: test\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\ntags: []\n---\n# <% tp.file.title %>";
    assert.throws(
      () => substituteTemplateVariables(template, { title: "Test", frontmatter: JSON.parse('{"__proto__": "evil"}') }),
      /disallowed/i
    );
  });

  it("correctly splits frontmatter from body when --- appears mid-line in frontmatter value", () => {
    // Template with --- mid-line in frontmatter value should properly separate frontmatter from body
    const template = "---\ntype: task\nstatus: pending\ndescription: This --- is mid-line\n---\n# <% tp.file.title %>\n\nBody text.";
    const result = substituteTemplateVariables(template, {
      title: "Test Task",
      frontmatter: { status: "done" }
    });
    assert.ok(result.includes("# Test Task"), "title should be substituted");
    assert.ok(result.includes("status: done"), "frontmatter should be updated");
    assert.ok(result.includes("Body text."), "body should be preserved");
    assert.ok(!result.includes("<% tp.file.title %>"), "template variable should be replaced");
  });

  it("rejects invalid task status in vault_write", () => {
    const template = "---\ntype: task\nstatus: pending\npriority: normal\n---\n# Title\n";
    assert.throws(
      () => substituteTemplateVariables(template, {
        frontmatter: { status: "open" }
      }),
      /invalid status "open".*task.*pending, active, done, cancelled/i
    );
  });

  it("rejects invalid task priority in vault_write", () => {
    const template = "---\ntype: task\nstatus: pending\npriority: normal\n---\n# Title\n";
    assert.throws(
      () => substituteTemplateVariables(template, {
        frontmatter: { priority: "critical" }
      }),
      /invalid priority "critical".*task.*urgent, high, normal, low/i
    );
  });

  it("accepts valid task status values in vault_write", () => {
    for (const status of ["pending", "active", "done", "cancelled"]) {
      const template = "---\ntype: task\nstatus: pending\npriority: normal\n---\n# Title\n";
      const result = substituteTemplateVariables(template, {
        frontmatter: { status }
      });
      assert.ok(result.includes(`status: ${status}`));
    }
  });

  it("skips enum validation for non-task note types", () => {
    const template = "---\ntype: research\nstatus: draft\n---\n# Title\n";
    const result = substituteTemplateVariables(template, {
      frontmatter: { status: "reviewed" }
    });
    assert.ok(result.includes("status: reviewed"));
  });
});

describe("substituteTemplateVariables (YAML-safe rendering)", () => {
  const RESEARCH = "---\ntype: research\ntopic:\nstatus: exploring\ncreated: <% tp.date.now(\"YYYY-MM-DD\") %>\ntags: [research]\n---\n# <% tp.file.title %>\n";
  const TASK = "---\ntype: task\nstatus: pending\npriority: normal\ntags:\n  - task\n---\n# Task\n";

  it("keeps a frontmatter value containing \": \" as that exact string in valid frontmatter (2026-10-13 live repro)", () => {
    const result = substituteTemplateVariables(RESEARCH, {
      title: "Review",
      frontmatter: { topic: "Review fixes: release hygiene + correctness", tags: ["review"] },
    });
    assert.equal(validateFrontmatterStrict(result).valid, true);
    assert.equal(extractFrontmatter(result).topic, "Review fixes: release hygiene + correctness");
  });

  for (const value of ["$$E=mc^2$$", "$'", "$&", "$`"]) {
    it(`inserts ${JSON.stringify(value)} literally from the title and from custom variables`, () => {
      const result = substituteTemplateVariables("# <% tp.file.title %>\n<% formula %>\n", {
        title: value,
        custom: { formula: value },
      });
      assert.equal(result, `# ${value}\n${value}\n`);
    });
  }

  it("strips leading #s from tags", () => {
    const result = substituteTemplateVariables(RESEARCH, { frontmatter: { tags: ["#dev", "##deep", "plain"] } });
    assert.deepEqual(extractFrontmatter(result).tags, ["dev", "deep", "plain"]);
  });

  it("keeps non-string frontmatter fields with their types", () => {
    const result = substituteTemplateVariables(RESEARCH, {
      frontmatter: { resolved: true, count: 3, aliases: ["a", "b"] },
    });
    const fm = extractFrontmatter(result);
    assert.deepEqual([fm.resolved, fm.count, fm.aliases], [true, 3, ["a", "b"]]);
  });

  it("keeps the template's key order and untouched fields, overrides in place, and appends new fields", () => {
    const result = substituteTemplateVariables(RESEARCH, {
      now: new Date(2026, 9, 13, 9, 30),
      frontmatter: { project: "PKM", topic: "Parsers", tags: ["a"] },
    });
    assert.equal(
      result,
      "---\ntype: research\ntopic: Parsers\nstatus: exploring\ncreated: 2026-10-13\ntags:\n  - a\nproject: PKM\n---\n# Untitled\n"
    );
  });

  it("renders date tokens in local time, not UTC", () => {
    const previousTZ = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    try {
      const now = new Date("2026-10-13T12:30:00Z"); // 2026-10-14 02:30 in Kiritimati
      const result = substituteTemplateVariables(
        "<% tp.date.now(\"YYYY-MM-DD\") %>|<% tp.date.now(\"YYYY-MM-DD HH:mm\") %>|<% tp.date.now(\"YYYY\") %>|<% tp.date.now(\"MM\") %>|<% tp.date.now(\"DD\") %>",
        { now }
      );
      assert.equal(result, "2026-10-14|2026-10-14 02:30|2026|10|14");
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  });

  it("substitutes placeholders inside template frontmatter values without breaking YAML", () => {
    const template = "---\ntype: moc\ntopic: \"<% tp.file.title %>\"\ncreated: 2026-01-01\ntags: [moc]\n---\n";
    const title = "He said \"hi\": #1";
    const fm = extractFrontmatter(substituteTemplateVariables(template, { title }));
    assert.equal(fm.topic, title);
  });

  it("rejects a template whose frontmatter is not valid YAML", () => {
    assert.throws(
      () => substituteTemplateVariables("---\ntype: [broken\n---\n# T\n", { frontmatter: {} }),
      /^Error: Failed to parse frontmatter: /
    );
  });

  for (const [name, frontmatter, pattern] of [
    ["an invalid key with a number value", { "bad key": 3 }, /Invalid frontmatter key: "bad key"/],
    ["a task status given as a number", { status: 5 }, /Invalid status "5" for type "task"/],
  ]) {
    it(`validates keys and enums for non-string values: ${name}`, () => {
      assert.throws(() => substituteTemplateVariables(TASK, { frontmatter }), pattern);
    });
  }
});

describe("validateFrontmatterStrict", () => {
  it("valid frontmatter passes", () => {
    const content = "---\ntype: research\ncreated: 2025-01-01\ntags:\n  - dev\n---\n\n# Title";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, true);
    assert.equal(errors.length, 0);
  });

  it("missing type fails", () => {
    const content = "---\ncreated: 2025-01-01\ntags:\n  - dev\n---\n";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("type")));
  });

  it("missing created fails", () => {
    const content = "---\ntype: research\ntags:\n  - dev\n---\n";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("created")));
  });

  it("empty tags fails", () => {
    const content = "---\ntype: research\ncreated: 2025-01-01\ntags: []\n---\n";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("tags")));
  });

  it("null tags in array fails", () => {
    const content = "---\ntype: research\ncreated: 2025-01-01\ntags:\n  -\n---\n";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("tags")));
  });

  it("no frontmatter at all fails", () => {
    const { valid, errors } = validateFrontmatterStrict("# Just a heading");
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("No frontmatter")));
  });

  it("detects unsubstituted template variables", () => {
    const content = "---\ntype: research\ncreated: 2025-01-01\ntags:\n  - dev\n---\n\n# <% tp.file.title %>";
    const { valid, errors } = validateFrontmatterStrict(content);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes("Unsubstituted")));
  });
});

describe("template defaults", () => {
  it("note.md template has a non-empty default tag", async () => {
    const templatePath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "templates", "note.md");
    const content = await fs.readFile(templatePath, "utf-8");
    const frontmatter = parseFrontmatterText(content.split("---")[1]);
    assert.ok(Array.isArray(frontmatter.tags), "tags should be an array");
    assert.ok(frontmatter.tags.length > 0, "tags should not be empty — validateFrontmatterStrict requires at least one tag");
  });
});

describe("extractInlineTags", () => {
  it("extracts simple inline tags", () => {
    const content = "---\ntype: note\n---\n\nSome text #dev and #mcp here";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags.sort(), ["dev", "mcp"]);
  });

  it("ignores tags in frontmatter", () => {
    const content = "---\ntags:\n  - frontmatter-tag\n---\n\n#body-tag";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags, ["body-tag"]);
  });

  it("ignores tags in code blocks", () => {
    const content = "---\ntype: note\n---\n\n```\n#not-a-tag\n```\n\n#real-tag";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags, ["real-tag"]);
  });

  it("ignores tags in inline code", () => {
    const content = "---\ntype: note\n---\n\nUse `#not-a-tag` for something. #real-tag";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags, ["real-tag"]);
  });

  it("handles hierarchical tags", () => {
    const content = "---\ntype: note\n---\n\n#dev/mcp #dev/tools";
    const tags = extractInlineTags(content);
    assert.ok(tags.includes("dev/mcp"));
    assert.ok(tags.includes("dev/tools"));
  });

  it("deduplicates tags", () => {
    const content = "---\ntype: note\n---\n\n#dev #dev #dev";
    const tags = extractInlineTags(content);
    assert.equal(tags.length, 1);
  });

  it("ignores heading markers", () => {
    const content = "---\ntype: note\n---\n\n## Heading\n\n#real-tag";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags, ["real-tag"]);
  });

  it("does not match HTML color codes", () => {
    const content = "---\ntype: note\n---\n\nColor is &#123; and &amp;";
    const tags = extractInlineTags(content);
    assert.equal(tags.length, 0);
  });

  for (const [name, content] of [
    ["~~~ fence", "---\ntype: note\n---\n~~~\n#not-a-tag\n~~~\n#real-tag"],
    ["unclosed ``` fence", "---\ntype: note\n---\n#real-tag\n```\n#not-a-tag\n"],
  ]) {
    it(`ignores tags inside fenced code: ${name}`, () => {
      assert.deepEqual(extractInlineTags(content), ["real-tag"]);
    });
  }

  it("does not extract tags from frontmatter with --- mid-line in value", () => {
    // Frontmatter with --- mid-line should be properly excluded from inline tag extraction
    const content = "---\ntype: note\ntags:\n  - frontmatter-tag\ndescription: This --- has #fake-tag\n---\n\n#real-tag in body";
    const tags = extractInlineTags(content);
    assert.deepEqual(tags, ["real-tag"]);
    assert.ok(!tags.includes("fake-tag"), "tags inside frontmatter values should be ignored");
  });
});

describe("matchesTagPattern", () => {
  it("returns true when no pattern", () => {
    assert.equal(matchesTagPattern("anything", undefined), true);
  });

  it("exact match", () => {
    assert.equal(matchesTagPattern("dev", "dev"), true);
    assert.equal(matchesTagPattern("dev", "mcp"), false);
  });

  it("case-insensitive", () => {
    assert.equal(matchesTagPattern("Dev", "dev"), true);
    assert.equal(matchesTagPattern("dev", "DEV"), true);
  });

  it("prefix pattern (dev*)", () => {
    assert.equal(matchesTagPattern("development", "dev*"), true);
    assert.equal(matchesTagPattern("dev", "dev*"), true);
    assert.equal(matchesTagPattern("other", "dev*"), false);
  });

  it("suffix pattern (*fix)", () => {
    assert.equal(matchesTagPattern("bugfix", "*fix"), true);
    assert.equal(matchesTagPattern("fix", "*fix"), true);
    assert.equal(matchesTagPattern("fixing", "*fix"), false);
  });

  it("substring pattern (*mcp*)", () => {
    assert.equal(matchesTagPattern("my-mcp-tool", "*mcp*"), true);
    assert.equal(matchesTagPattern("mcp", "*mcp*"), true);
    assert.equal(matchesTagPattern("other", "*mcp*"), false);
  });

  it("hierarchical pattern (pkm/*)", () => {
    assert.equal(matchesTagPattern("pkm/tools", "pkm/*"), true);
    assert.equal(matchesTagPattern("pkm/tools/mcp", "pkm/*"), true);
    assert.equal(matchesTagPattern("pkm", "pkm/*"), true);
    assert.equal(matchesTagPattern("pkm-other", "pkm/*"), false);
  });
});

describe("findTailSections", () => {
  // Assemble the text vault_read returns, so the original assertions still apply
  const extractTailSections = (content, n, level) => {
    const { frontmatter, start } = findTailSections(content, n, level);
    return frontmatter + content.slice(start);
  };
  const doc = `---
type: devlog
created: 2026-01-01
tags:
  - dev
---
# Devlog

## 2026-01-01

Entry one.

## 2026-01-15

Entry two.

## 2026-02-01

Entry three.
`;

  it("extracts last N sections at given level", () => {
    const result = extractTailSections(doc, 2, 2);
    assert.ok(result.includes("## 2026-01-15"));
    assert.ok(result.includes("## 2026-02-01"));
    assert.ok(!result.includes("## 2026-01-01"));
  });

  it("preserves frontmatter", () => {
    const result = extractTailSections(doc, 1, 2);
    assert.ok(result.startsWith("---"));
    assert.ok(result.includes("type: devlog"));
    assert.ok(result.includes("## 2026-02-01"));
  });

  it("returns full content when N exceeds available sections", () => {
    const result = extractTailSections(doc, 100, 2);
    assert.ok(result.includes("## 2026-01-01"));
    assert.ok(result.includes("## 2026-01-15"));
    assert.ok(result.includes("## 2026-02-01"));
  });

  it("uses custom heading level", () => {
    const result = extractTailSections(doc, 1, 1);
    // Only one # heading, so it should include everything under it
    assert.ok(result.includes("# Devlog"));
  });

  it("returns full content when no headings match level", () => {
    const result = extractTailSections(doc, 2, 4);
    assert.ok(result.includes("## 2026-01-01"));
    assert.ok(result.includes("## 2026-02-01"));
  });

  it("handles content without frontmatter", () => {
    const noFm = "## A\n\nContent A.\n\n## B\n\nContent B.\n";
    const result = extractTailSections(noFm, 1, 2);
    assert.ok(result.includes("## B"));
    assert.ok(!result.includes("## A"));
  });

  it("does not count headings inside fenced code and reports the tail's first line", () => {
    const content = "---\ntype: devlog\n---\n## A\n```\n## not a section\n```\n## B\nb\n";
    assert.deepEqual(findTailSections(content, 2, 2), { frontmatter: "---\ntype: devlog\n---\n", start: 21, line: 4 });
  });
});

describe("capReadOutput", () => {
  it("returns the text unchanged when it fits the cap", () => {
    assert.equal(capReadOutput("a\nbb\n", { firstLine: 1, totalLines: 3, cap: 5 }), "a\nbb\n");
  });

  it("keeps the whole lines that fit and names the next line to read", () => {
    const text = "line1\nline2\nline3\nline4\n";
    assert.equal(
      capReadOutput(text, { firstLine: 10, totalLines: 40, cap: 14 }),
      "line1\nline2\n[truncated: lines 10–11 of 40; continue with lines: {start: 12}]"
    );
  });

  it("cuts a single line longer than the cap mid-line and continues at the next line", () => {
    assert.equal(
      capReadOutput("abcdefghij\nk\n", { firstLine: 3, totalLines: 9, cap: 4 }),
      "abcd\n[truncated: lines 3–3 of 9; continue with lines: {start: 4}]"
    );
  });
});

describe("buildBasenameMap", () => {
  it("maps lowercase basenames to full paths", () => {
    const files = [
      "01-Projects/MyApp/devlog.md",
      "01-Projects/Other/devlog.md",
      "notes/unique-note.md",
    ];
    const { basenameMap, allFilesSet } = buildBasenameMap(files);

    assert.deepStrictEqual(basenameMap.get("devlog"), [
      "01-Projects/MyApp/devlog.md",
      "01-Projects/Other/devlog.md",
    ]);
    assert.deepStrictEqual(basenameMap.get("unique-note"), ["notes/unique-note.md"]);
    assert.equal(allFilesSet.has("notes/unique-note.md"), true);
  });

  it("handles empty file list", () => {
    const { basenameMap, allFilesSet } = buildBasenameMap([]);
    assert.equal(basenameMap.size, 0);
    assert.equal(allFilesSet.size, 0);
  });

  it("is case-insensitive for basenames", () => {
    const { basenameMap } = buildBasenameMap(["notes/MyNote.md"]);
    assert.deepStrictEqual(basenameMap.get("mynote"), ["notes/MyNote.md"]);
  });
});

describe("resolveFuzzyFolder", () => {
  const allFiles = [
    "01-Projects/Obsidian-MCP/development/devlog.md",
    "01-Projects/Obsidian-MCP/research/note.md",
    "01-Projects/MyApp/development/devlog.md",
    "02-Areas/health/log.md",
  ];

  it("returns exact folder when it matches a known directory", () => {
    const result = resolveFuzzyFolder("01-Projects/Obsidian-MCP", allFiles);
    assert.equal(result, "01-Projects/Obsidian-MCP");
  });

  it("resolves partial folder by substring match", () => {
    const result = resolveFuzzyFolder("Obsidian-MCP", allFiles);
    assert.equal(result, "01-Projects/Obsidian-MCP");
  });

  it("throws on ambiguous folder", () => {
    assert.throws(
      () => resolveFuzzyFolder("development", allFiles),
      (err) => {
        assert.match(err.message, /matches \d+ folders/);
        return true;
      }
    );
  });

  it("throws on no match", () => {
    assert.throws(
      () => resolveFuzzyFolder("nonexistent", allFiles),
      (err) => {
        assert.match(err.message, /not found/i);
        return true;
      }
    );
  });

  it("is case-insensitive", () => {
    const result = resolveFuzzyFolder("obsidian-mcp", allFiles);
    assert.equal(result, "01-Projects/Obsidian-MCP");
  });
});

describe("constants", () => {
  it("exports AUTO_REDIRECT_THRESHOLD as 80000", () => {
    assert.equal(AUTO_REDIRECT_THRESHOLD, 80_000);
  });

  it("exports FORCE_HARD_CAP as 400000", () => {
    assert.equal(FORCE_HARD_CAP, 400_000);
  });

  it("exports CHUNK_SIZE as 80000", () => {
    assert.equal(CHUNK_SIZE, 80_000);
  });
});

describe("computePeek", () => {
  it("returns correct size metrics", () => {
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n# Title\n\nLine 1\nLine 2\n";
    const result = computePeek(content, "test/note.md");
    assert.equal(result.sizeChars, content.length);
    assert.equal(result.sizeLines, content.split("\n").length);
    assert.equal(result.path, "test/note.md");
  });

  it("extracts frontmatter", () => {
    const content = "---\ntype: research\ncreated: 2026-01-01\ntags:\n  - dev\n---\n# Title\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.frontmatter.type, "research");
    assert.deepEqual(result.frontmatter.tags, ["dev"]);
  });

  it("returns null frontmatter for files without it", () => {
    const content = "# Just a heading\n\nSome content.\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.frontmatter, null);
  });

  it("builds heading outline with line numbers and levels", () => {
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - t\n---\n# Title\n\n## Section One\n\nContent.\n\n## Section Two\n\nMore.\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.headings.length, 3);
    assert.equal(result.headings[0].heading, "# Title");
    assert.equal(result.headings[0].level, 1);
    assert.equal(result.headings[1].heading, "## Section One");
    assert.equal(result.headings[1].level, 2);
    assert.equal(result.headings[2].heading, "## Section Two");
    assert.equal(result.headings[2].level, 2);
  });

  it("includes line numbers for headings", () => {
    const content = "# Title\n\n## Section\n\nText.\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.headings[0].lineNumber, 1);
    assert.equal(result.headings[1].lineNumber, 3);
  });

  it("includes line numbers accounting for frontmatter", () => {
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - t\n---\n# Title\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.headings[0].lineNumber, 7);
  });

  it("computes approximate char counts per section", () => {
    const content = "# Title\n\n## Short\n\nHi.\n\n## Long\n\n" + "x".repeat(500) + "\n";
    const result = computePeek(content, "test.md");
    const shortSection = result.headings.find(h => h.heading === "## Short");
    const longSection = result.headings.find(h => h.heading === "## Long");
    assert.ok(longSection.charCount > shortSection.charCount);
  });

  it("computes totalChunks", () => {
    const content = "x".repeat(200_000);
    const result = computePeek(content, "big.md");
    assert.equal(result.totalChunks, 3); // 200k / 80k = 2.5, ceil = 3
  });

  it("totalChunks is 1 for small files", () => {
    const content = "Small file.\n";
    const result = computePeek(content, "small.md");
    assert.equal(result.totalChunks, 1);
  });

  it("returns preview of first ~10 non-frontmatter lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - t\n---\n" + lines.join("\n") + "\n";
    const result = computePeek(content, "test.md");
    assert.ok(result.preview.includes("Line 1"));
    assert.ok(result.preview.includes("Line 10"));
    assert.ok(!result.preview.includes("Line 11"));
  });

  it("handles empty file", () => {
    const result = computePeek("", "empty.md");
    assert.equal(result.sizeChars, 0);
    assert.equal(result.sizeLines, 1); // "".split("\n") = [""]
    assert.equal(result.headings.length, 0);
    assert.equal(result.frontmatter, null);
    assert.equal(result.totalChunks, 0);
  });

  it("handles file with only frontmatter", () => {
    const content = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - t\n---\n";
    const result = computePeek(content, "test.md");
    assert.equal(result.headings.length, 0);
    assert.ok(result.frontmatter !== null);
    assert.equal(result.preview, "");
  });

  for (const [name, content, expected] of [
    ["headings inside fenced code are not in the outline", "# T\n```\n## code\n```\n## Real\n", [["# T", 1], ["## Real", 5]]],
    ["CRLF frontmatter and headings", "---\r\n# yaml comment\r\ntype: x\r\n---\r\n# T\r\n## A\r\n", [["# T", 5], ["## A", 6]]],
  ]) {
    it(`builds the outline with markdown.js parsing: ${name}`, () => {
      assert.deepEqual(computePeek(content, "t.md").headings.map(h => [h.heading, h.lineNumber]), expected);
    });
  }
});

describe("formatPeek", () => {
  const basePeekData = {
    path: "notes/big.md",
    sizeChars: 90000,
    sizeLines: 2000,
    frontmatter: { type: "devlog", created: "2026-01-01", tags: ["dev"] },
    headings: [
      { heading: "# Title", level: 1, lineNumber: 7, charCount: 100 },
      { heading: "## Section A", level: 2, lineNumber: 10, charCount: 45000 },
      { heading: "## Section B", level: 2, lineNumber: 500, charCount: 400 },
    ],
    preview: "Some preview text here.",
    totalChunks: 2,
  };

  it("includes file path, size info, and chunk count on one line", () => {
    const text = formatPeek(basePeekData);
    assert.ok(text.includes("notes/big.md"));
    assert.ok(text.includes("90,000") || text.includes("90000"));
    assert.ok(text.includes("2,000") || text.includes("2000"));
    assert.ok(text.includes("2 chunks"));
  });

  it("includes heading outline as indented tree without line numbers", () => {
    const text = formatPeek(basePeekData);
    assert.ok(text.includes("Title [100 chars]"));
    assert.ok(text.includes("  Section A [45000 chars]"));
    assert.ok(text.includes("  Section B [400 chars]"));
    assert.ok(!text.match(/L\d+/), "should not contain line number prefixes");
    assert.ok(!text.includes("# Title"), "should not contain # markers");
  });

  it("includes frontmatter fields", () => {
    const text = formatPeek(basePeekData);
    assert.ok(text.includes("devlog"));
  });

  it("includes preview", () => {
    const text = formatPeek(basePeekData);
    assert.ok(text.includes("Some preview text here."));
  });

  it("includes redirect guidance when redirected=true", () => {
    const text = formatPeek(basePeekData, { redirected: true });
    assert.ok(text.includes("heading"));
    assert.ok(text.includes("chunk"));
    assert.ok(text.includes("force"));
  });

  it("omits redirect guidance when not redirected", () => {
    const text = formatPeek(basePeekData);
    assert.ok(!text.includes("force"));
  });

  it("handles null frontmatter", () => {
    const data = { ...basePeekData, frontmatter: null };
    const text = formatPeek(data);
    assert.ok(text.includes("notes/big.md"));
  });

  it("handles empty headings", () => {
    const data = { ...basePeekData, headings: [] };
    const text = formatPeek(data);
    assert.ok(text.includes("notes/big.md"));
  });

  it("caps the heading outline at 50 entries with a +N more line", () => {
    const headings = Array.from({ length: 57 }, (_, i) => ({ heading: `## H${i + 1}`, level: 2, lineNumber: i + 1, charCount: 10 }));
    const text = formatPeek({ ...basePeekData, headings, preview: "" });
    assert.ok(text.includes("  H50 [10 chars]"));
    assert.ok(!text.includes("H51 ["));
    assert.ok(text.includes("… +7 more"));
  });
});

describe("updateFrontmatter", () => {
  it("updates an existing field", () => {
    const content = "---\ntype: task\nstatus: pending\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n\nBody text.\n";
    const { content: result, frontmatter } = updateFrontmatter(content, { status: "done" });
    assert.equal(frontmatter.status, "done");
    assert.ok(result.includes("Body text."), "body preserved");
    assert.equal(frontmatter.type, "task", "other fields preserved");
  });

  it("creates a new field that does not exist", () => {
    const content = "---\ntype: task\nstatus: pending\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    const { frontmatter } = updateFrontmatter(content, { completed: "2026-02-10" });
    assert.equal(frontmatter.completed, "2026-02-10");
    assert.equal(frontmatter.status, "pending", "existing fields preserved");
  });

  it("removes a field when value is null", () => {
    const content = "---\ntype: task\nstatus: pending\npriority: high\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    const { content: result, frontmatter } = updateFrontmatter(content, { priority: null });
    assert.equal(frontmatter.priority, undefined);
    assert.ok(!result.includes("priority:"), "field removed from output");
  });

  it("protects required field: type cannot be set to null", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { type: null }), /cannot remove.*type/i);
  });

  it("protects required field: created cannot be set to null", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { created: null }), /cannot remove.*created/i);
  });

  it("protects required field: tags cannot be set to null", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { tags: null }), /cannot remove.*tags/i);
  });

  it("rejects empty tags array", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { tags: [] }), /tags.*non-empty/i);
  });

  it("replaces tags array wholesale", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    const { frontmatter } = updateFrontmatter(content, { tags: ["task", "grocery", "home"] });
    assert.deepEqual(frontmatter.tags, ["task", "grocery", "home"]);
  });

  it("allows updating type to a new string value", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    const { frontmatter } = updateFrontmatter(content, { type: "project" });
    assert.equal(frontmatter.type, "project");
  });

  it("throws on file with no frontmatter", () => {
    const content = "# Title\n\nNo frontmatter here.\n";
    assert.throws(() => updateFrontmatter(content, { status: "done" }), /no frontmatter/i);
  });

  it("throws on unclosed frontmatter", () => {
    const content = "---\ntype: task\nstatus: pending\n# Title\nBody text\n";
    assert.throws(() => updateFrontmatter(content, { status: "done" }), /unclosed/i);
  });

  it("throws descriptive error on malformed YAML", () => {
    const content = "---\n: invalid: yaml: [broken\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { status: "done" }), /failed to parse/i);
  });

  it("rejects prototype pollution keys (__proto__)", () => {
    const content = "---\ntype: test\ncreated: 2026-01-01\ntags:\n  - test\n---\nBody";
    // JSON.parse creates __proto__ as an own property (like MCP tool input)
    const fields = JSON.parse('{"__proto__": "evil"}');
    assert.throws(
      () => updateFrontmatter(content, fields),
      /disallowed/i
    );
  });

  it("rejects prototype pollution keys (constructor)", () => {
    const content = "---\ntype: test\ncreated: 2026-01-01\ntags:\n  - test\n---\nBody";
    assert.throws(
      () => updateFrontmatter(content, { constructor: "evil" }),
      /disallowed/i
    );
  });

  it("rejects prototype pollution keys (prototype)", () => {
    const content = "---\ntype: test\ncreated: 2026-01-01\ntags:\n  - test\n---\nBody";
    assert.throws(
      () => updateFrontmatter(content, { prototype: "evil" }),
      /disallowed/i
    );
  });

  it("rejects invalid field keys", () => {
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(() => updateFrontmatter(content, { "bad key!": "value" }), /invalid.*key/i);
  });

  it("handles multiple updates in one call", () => {
    const content = "---\ntype: task\nstatus: pending\npriority: normal\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    const { frontmatter } = updateFrontmatter(content, {
      status: "done",
      priority: null,
      completed: "2026-02-10"
    });
    assert.equal(frontmatter.status, "done");
    assert.equal(frontmatter.priority, undefined);
    assert.equal(frontmatter.completed, "2026-02-10");
  });

  it("preserves body content exactly", () => {
    const body = "\n# My Task\n\n## Description\n\nBuy groceries for dinner.\n\n## Context\n\nWe need food.\n";
    const content = "---\ntype: task\ncreated: 2026-02-10\ntags:\n  - task\n---" + body;
    const { content: result } = updateFrontmatter(content, { status: "done" });
    assert.ok(result.endsWith(body), "body should be preserved exactly");
  });

  it("rejects invalid task status in vault_update_frontmatter", () => {
    const content = "---\ntype: task\nstatus: pending\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(
      () => updateFrontmatter(content, { status: "open" }),
      /invalid status "open".*task.*pending, active, done, cancelled/i
    );
  });

  it("rejects invalid task priority in vault_update_frontmatter", () => {
    const content = "---\ntype: task\nstatus: pending\npriority: normal\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
    assert.throws(
      () => updateFrontmatter(content, { priority: "medium" }),
      /invalid priority "medium".*task.*urgent, high, normal, low/i
    );
  });

  it("accepts valid task status values in vault_update_frontmatter", () => {
    for (const status of ["pending", "active", "done", "cancelled"]) {
      const content = "---\ntype: task\nstatus: pending\ncreated: 2026-02-10\ntags:\n  - task\n---\n# Title\n";
      const { frontmatter } = updateFrontmatter(content, { status });
      assert.equal(frontmatter.status, status);
    }
  });

  it("skips enum validation for non-task note types", () => {
    const content = "---\ntype: research\nstatus: draft\ncreated: 2026-02-10\ntags:\n  - research\n---\n# Title\n";
    const { frontmatter } = updateFrontmatter(content, { status: "reviewed" });
    assert.equal(frontmatter.status, "reviewed");
  });
});

describe("validateFieldEnum", () => {
  it("throws for invalid task status", () => {
    assert.throws(() => validateFieldEnum("status", "open", "task"), /invalid status "open"/i);
  });

  it("throws for invalid task priority", () => {
    assert.throws(() => validateFieldEnum("priority", "critical", "task"), /invalid priority "critical"/i);
  });

  it("accepts valid task status values", () => {
    for (const v of ["pending", "active", "done", "cancelled"]) {
      assert.doesNotThrow(() => validateFieldEnum("status", v, "task"));
    }
  });

  it("accepts valid task priority values", () => {
    for (const v of ["low", "normal", "high", "urgent"]) {
      assert.doesNotThrow(() => validateFieldEnum("priority", v, "task"));
    }
  });

  it("skips validation for unknown note types", () => {
    assert.doesNotThrow(() => validateFieldEnum("status", "anything", "research"));
  });

  it("skips validation for unknown fields", () => {
    assert.doesNotThrow(() => validateFieldEnum("author", "anyone", "task"));
  });

  it("skips validation for null/undefined values", () => {
    assert.doesNotThrow(() => validateFieldEnum("status", null, "task"));
    assert.doesNotThrow(() => validateFieldEnum("status", undefined, "task"));
  });

  it("includes allowed values in error message", () => {
    assert.throws(
      () => validateFieldEnum("status", "open", "task"),
      /pending, active, done, cancelled/
    );
  });
});

describe("compareFrontmatterValues", () => {
  it("sorts priority with custom ranking (asc: low first)", () => {
    assert.ok(compareFrontmatterValues("low", "high", "priority") < 0);
    assert.ok(compareFrontmatterValues("urgent", "low", "priority") > 0);
    assert.ok(compareFrontmatterValues("normal", "normal", "priority") === 0);
  });

  it("sorts priority desc (urgent first)", () => {
    assert.ok(compareFrontmatterValues("urgent", "high", "priority") > 0);
    assert.ok(compareFrontmatterValues("high", "normal", "priority") > 0);
    assert.ok(compareFrontmatterValues("normal", "low", "priority") > 0);
  });

  it("sorts date-like values chronologically", () => {
    assert.ok(compareFrontmatterValues("2026-01-01", "2026-02-01", "due") < 0);
    assert.ok(compareFrontmatterValues("2026-12-31", "2026-01-01", "created") > 0);
    assert.ok(compareFrontmatterValues("2026-05-15", "2026-05-15", "completed") === 0);
  });

  it("sorts string values with localeCompare", () => {
    assert.ok(compareFrontmatterValues("alpha", "beta", "project") < 0);
    assert.ok(compareFrontmatterValues("zebra", "alpha", "project") > 0);
    assert.ok(compareFrontmatterValues("same", "same", "project") === 0);
  });

  it("null sorts last (positive) regardless of field", () => {
    assert.ok(compareFrontmatterValues(null, "high", "priority") > 0);
    assert.ok(compareFrontmatterValues("high", null, "priority") < 0);
    assert.equal(compareFrontmatterValues(null, null, "priority"), 0);
  });

  it("undefined sorts last like null", () => {
    assert.ok(compareFrontmatterValues(undefined, "2026-01-01", "due") > 0);
    assert.ok(compareFrontmatterValues("2026-01-01", undefined, "due") < 0);
  });

  it("treats unknown priority values as strings", () => {
    assert.ok(compareFrontmatterValues("critical", "zebra", "priority") < 0);
  });

  it("detects date values by pattern regardless of field name", () => {
    assert.ok(compareFrontmatterValues("2026-01-01", "2026-02-01", "my_custom_date") < 0);
  });

  it("handles Date objects (converted to string)", () => {
    const d1 = new Date("2026-01-01");
    const d2 = new Date("2026-06-15");
    assert.ok(compareFrontmatterValues(d1, d2, "created") < 0);
  });
});

describe("computeProximityBonus", () => {
  it("returns 1.0 for depth 0 (self)", () => {
    assert.equal(computeProximityBonus(0), 1.0);
  });
  it("returns 1.0 for depth 1 (direct neighbor)", () => {
    assert.equal(computeProximityBonus(1), 1.0);
  });
  it("returns 0.5 for depth 2", () => {
    assert.equal(computeProximityBonus(2), 0.5);
  });
  it("returns 0.25 for depth 3", () => {
    assert.equal(computeProximityBonus(3), 0.25);
  });
  it("returns 0 for depth 4+", () => {
    assert.equal(computeProximityBonus(4), 0);
    assert.equal(computeProximityBonus(10), 0);
  });
  it("returns 0 for null/undefined (not in graph)", () => {
    assert.equal(computeProximityBonus(null), 0);
    assert.equal(computeProximityBonus(undefined), 0);
  });
});

describe("blendWithGraph", () => {
  it("blends semantic scores with graph proximity", () => {
    const results = [
      { path: "a.md", score: 0.9, preview: "a" },
      { path: "b.md", score: 0.8, preview: "b" },
      { path: "c.md", score: 0.7, preview: "c" },
    ];
    const neighborhood = {
      depthGroups: new Map([
        [1, [{ path: "c.md" }]],
        [2, [{ path: "a.md" }]],
      ]),
    };
    const blended = blendWithGraph(results, neighborhood, 0.3, 3);
    assert.strictEqual(blended.length, 3);
    // c.md should be boosted (depth 1 = proximity 1.0)
    // a.md has depth 2 = proximity 0.5
    // b.md has no depth = proximity 0
    assert.strictEqual(blended[0].path, "c.md");
    assert.ok(blended[0].combined > blended[0].score, "combined should include proximity bonus");
    assert.strictEqual(blended[2].depth, null, "b.md should have null depth");
  });

  it("respects limit parameter", () => {
    const results = [
      { path: "a.md", score: 0.9, preview: "a" },
      { path: "b.md", score: 0.8, preview: "b" },
    ];
    const neighborhood = { depthGroups: new Map() };
    const blended = blendWithGraph(results, neighborhood, 0.3, 1);
    assert.strictEqual(blended.length, 1);
  });

  it("preserves extra properties from input results", () => {
    const results = [
      { path: "a.md", score: 0.9, preview: "a", extra: "data" },
    ];
    const neighborhood = { depthGroups: new Map() };
    const blended = blendWithGraph(results, neighborhood, 0.3, 10);
    assert.strictEqual(blended[0].extra, "data");
    assert.strictEqual(blended[0].depth, null);
    assert.ok("combined" in blended[0]);
  });

  it("uses first depth when note appears at multiple depths", () => {
    const results = [
      { path: "a.md", score: 0.5, preview: "a" },
    ];
    const neighborhood = {
      depthGroups: new Map([
        [1, [{ path: "a.md" }]],
        [3, [{ path: "a.md" }]],
      ]),
    };
    const blended = blendWithGraph(results, neighborhood, 0.5, 10);
    assert.strictEqual(blended[0].depth, 1);
  });
});

describe("obsidianLink", () => {
  it("strips .md from URL but keeps it in link text", () => {
    const link = obsidianLink("notes/hello.md", "PKM");
    assert.equal(link, "[notes/hello.md](obsidian://open?vault=PKM&file=notes%2Fhello)");
  });

  it("handles paths without .md extension", () => {
    const link = obsidianLink("notes/hello", "PKM");
    assert.equal(link, "[notes/hello](obsidian://open?vault=PKM&file=notes%2Fhello)");
  });

  it("encodes spaces in path and vault name", () => {
    const link = obsidianLink("My Folder/My Note.md", "My Vault");
    assert.equal(
      link,
      "[My Folder/My Note.md](obsidian://open?vault=My%20Vault&file=My%20Folder%2FMy%20Note)"
    );
  });

  it("encodes special characters in path", () => {
    const link = obsidianLink("notes/q&a.md", "PKM");
    assert.equal(link, "[notes/q&a.md](obsidian://open?vault=PKM&file=notes%2Fq%26a)");
  });

  it("only strips trailing .md, not .md inside the path", () => {
    const link = obsidianLink("foo.md.bar/note.md", "PKM");
    assert.equal(link, "[foo.md.bar/note.md](obsidian://open?vault=PKM&file=foo.md.bar%2Fnote)");
  });

  it("handles non-md extensions by leaving the path intact", () => {
    const link = obsidianLink("attachments/file.png", "PKM");
    assert.equal(link, "[attachments/file.png](obsidian://open?vault=PKM&file=attachments%2Ffile.png)");
  });

  it("returns empty string for null/undefined/empty path", () => {
    assert.equal(obsidianLink(null, "PKM"), "");
    assert.equal(obsidianLink(undefined, "PKM"), "");
    assert.equal(obsidianLink("", "PKM"), "");
  });
});
