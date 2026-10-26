import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  splitFrontmatter,
  parseHeadings,
  matchHeadings,
  sectionRange,
  findSection,
  formatHeadingList,
  maskCode,
  frontmatterList,
} from "../markdown.js";

const texts = (headings) => headings.map(h => `${h.level}:${h.text}`);

describe("splitFrontmatter", () => {
  it("returns the verbatim YAML between the fences and the body after the closing fence", () => {
    const content = "---\ntype: note\ntags: [a]\n---\n# Title\nBody\n";
    assert.deepEqual(splitFrontmatter(content), {
      frontmatterText: "type: note\ntags: [a]\n",
      body: "# Title\nBody\n",
      bodyOffset: 29,
    });
  });

  it("handles CRLF fences and keeps CRLF inside the frontmatter text", () => {
    const content = "---\r\ntype: note\r\n---\r\n# Title\r\n";
    assert.deepEqual(splitFrontmatter(content), {
      frontmatterText: "type: note\r\n",
      body: "# Title\r\n",
      bodyOffset: 22,
    });
  });

  it("treats an empty block (---\\n---\\n) as empty frontmatter", () => {
    assert.deepEqual(splitFrontmatter("---\n---\n"), { frontmatterText: "", body: "", bodyOffset: 8 });
  });

  it("closes at the end of content when the closing fence has no newline", () => {
    assert.deepEqual(splitFrontmatter("---\na: 1\n---"), { frontmatterText: "a: 1\n", body: "", bodyOffset: 12 });
  });

  for (const [name, content] of [
    ["empty content", ""],
    ["no frontmatter", "# Title\nBody\n"],
    ["missing opening fence", "type: x\n---\nBody\n"],
    ["unclosed frontmatter", "---\ntype: x\n# Title\n"],
    ["lone opening fence", "---"],
    ["indented opening fence", " ---\na: 1\n---\n"],
    ["four-dash fences", "----\na: 1\n----\n"],
  ]) {
    it(`returns null frontmatter and the whole content as body: ${name}`, () => {
      assert.deepEqual(splitFrontmatter(content), { frontmatterText: null, body: content, bodyOffset: 0 });
    });
  }

  for (const [name, content, frontmatterText] of [
    ["--- mid-line does not close", "---\nd: a --- b\n---\nBody", "d: a --- b\n"],
    ["a ---- line does not close", "---\na: 1\n----\n---\nBody", "a: 1\n----\n"],
    ["trailing whitespace after --- still closes", "---\na: 1\n---  \t\nBody", "a: 1\n"],
  ]) {
    it(`closes only on a line that is exactly ---: ${name}`, () => {
      const result = splitFrontmatter(content);
      assert.equal(result.frontmatterText, frontmatterText);
      assert.equal(result.body, "Body");
    });
  }
});

describe("parseHeadings", () => {
  it("returns level, text, raw, 1-based line, offset and lineEnd for each heading after the frontmatter", () => {
    const content = "---\ntype: note\n---\n# Title\n\nText\n## Section ##\n";
    assert.deepEqual(parseHeadings(content), [
      { level: 1, text: "Title", raw: "# Title", line: 4, offset: 19, lineEnd: 27 },
      { level: 2, text: "Section", raw: "## Section ##", line: 7, offset: 33, lineEnd: 47 },
    ]);
  });

  for (const [name, line, expected] of [
    ["six #s is a level-6 heading", "###### Six", ["6:Six"]],
    ["#s after text on the line are not a heading", "See ## Section One inline", []],
    ["#hashtag (no space) is not a heading", "#hashtag", []],
    ["seven #s is not a heading", "####### seven", []],
    ["#s with no text and no space is not a heading", "##", []],
    ["closing #s are stripped", "## Foo ##", ["2:Foo"]],
    ["a # attached to text is kept", "## C#", ["2:C#"]],
    ["a leading #tag in the text is kept", "## #tag", ["2:#tag"]],
    ["surrounding whitespace is trimmed", "##   spaced out   ", ["2:spaced out"]],
    ["up to 3 spaces of indentation is a heading", "   ### Indented", ["3:Indented"]],
    ["4 spaces of indentation is not a heading", "    ## Code", []],
    ["a tab-indented line is not a heading", "\t# Tab", []],
  ]) {
    it(`applies ATX heading rules: ${name}`, () => {
      assert.deepEqual(texts(parseHeadings(`${line}\n`)), expected);
    });
  }

  it("skips heading-like lines inside the frontmatter", () => {
    const content = "---\n# yaml comment\ntype: note\n---\n## Real\n";
    assert.deepEqual(texts(parseHeadings(content)), ["2:Real"]);
  });

  for (const [name, content, expected] of [
    ["``` fence", "```\n## in\n```\n## out\n", ["2:out"]],
    ["~~~ fence", "~~~\n## in\n~~~\n## out\n", ["2:out"]],
    ["~~~ does not close a ``` fence", "```\n~~~\n## in\n```\n## out\n", ["2:out"]],
    ["a shorter fence does not close a longer one", "````\n```\n## in\n````\n## out\n", ["2:out"]],
    ["a longer fence closes a shorter one", "```\n## in\n`````\n## out\n", ["2:out"]],
    ["an unclosed fence runs to the end", "## before\n```\n## in\n## also in\n", ["2:before"]],
    ["a fence indented 3 spaces counts", "   ```\n## in\n   ```\n## out\n", ["2:out"]],
    ["a fence indented 4 spaces is not a fence", "    ```\n## out\n", ["2:out"]],
    ["a backtick in a ``` info string is not a fence", "```js `x`\n## out\n", ["2:out"]],
    ["a fence closer with an info string does not close", "```\n``` js\n## in\n```\n## out\n", ["2:out"]],
  ]) {
    it(`ignores headings inside fenced code: ${name}`, () => {
      assert.deepEqual(texts(parseHeadings(content)), expected);
    });
  }

  it("handles CRLF: raw and text exclude \\r, offsets index into the CRLF content", () => {
    const content = "---\r\na: 1\r\n---\r\n# One\r\nx\r\n## Two\r\n";
    const headings = parseHeadings(content);
    assert.deepEqual(headings.map(h => [h.raw, h.text, h.line]), [["# One", "One", 4], ["## Two", "Two", 6]]);
    assert.equal(content.slice(headings[0].offset, headings[0].lineEnd), "# One\r\n");
    assert.equal(content.slice(headings[1].offset, headings[1].lineEnd), "## Two\r\n");
  });

  for (const [name, content] of [
    ["empty content", ""],
    ["frontmatter only", "---\ntype: note\n---\n"],
    ["empty frontmatter", "---\n---\n"],
  ]) {
    it(`returns [] without throwing: ${name}`, () => {
      assert.deepEqual(parseHeadings(content), []);
    });
  }
});

describe("matchHeadings", () => {
  const headings = parseHeadings("# Foo\n## Foo\n### Foo\n## Bar\n## #hashtag\n");

  for (const [query, expected] of [
    ["## Foo", ["2:Foo"]],
    ["  ## Foo  ", ["2:Foo"]],
    ["## Foo ##", ["2:Foo"]],
    ["# Bar", []],
  ]) {
    it(`a query with #s matches level and exact text: ${JSON.stringify(query)}`, () => {
      assert.deepEqual(texts(matchHeadings(headings, query)), expected);
    });
  }

  for (const [query, expected] of [
    ["Foo", ["1:Foo", "2:Foo", "3:Foo"]],
    ["  Bar ", ["2:Bar"]],
    ["#hashtag", ["2:#hashtag"]],
  ]) {
    it(`a query without #s matches the exact text at any level: ${JSON.stringify(query)}`, () => {
      assert.deepEqual(texts(matchHeadings(headings, query)), expected);
    });
  }

  for (const query of ["Fo", "## Fo", "foo", "## foo"]) {
    it(`requires the whole text with the same case: ${JSON.stringify(query)}`, () => {
      assert.deepEqual(matchHeadings(headings, query), []);
    });
  }
});

describe("findSection", () => {
  const doc = "---\ntype: devlog\n---\n# Devlog\n\n## 2026-10-07\n\nOne.\n\n## 2026-10-08\n\nTwo.\n\n### Detail\n\nNested.\n\n## 2026-10-09\n\nThree.\n";

  it("spans the heading line and the section up to the next same-or-higher heading, including subheadings", () => {
    const range = findSection(doc, "## 2026-10-08");
    assert.equal(doc.slice(range.headingStart, range.afterHeading), "## 2026-10-08\n");
    assert.equal(doc.slice(range.afterHeading, range.sectionEnd), "\nTwo.\n\n### Detail\n\nNested.\n\n");
    assert.equal(range.heading.line, 10);
  });

  it("finds a section by text alone (the 2026-10-13 live failure: \"2026-10-08\" against \"## 2026-10-08\")", () => {
    const range = findSection(doc, "2026-10-08");
    assert.equal(doc.slice(range.headingStart, range.afterHeading), "## 2026-10-08\n");
  });

  for (const query of ["## 2026-10", "2026-10"]) {
    it(`does not prefix-match: ${JSON.stringify(query)} is not found when only ## 2026-10-0x exists`, () => {
      assert.throws(() => findSection(doc, query), /^Error: Heading not found/);
    });
  }

  it("extends the last section to the end of content", () => {
    const range = findSection(doc, "## 2026-10-09");
    assert.equal(range.sectionEnd, doc.length);
  });

  it("does not end a section at a heading-like line inside fenced code", () => {
    const content = "## A\n```\n## not a heading\n```\nmore\n## B\n";
    const range = findSection(content, "## A");
    assert.equal(content.slice(range.afterHeading, range.sectionEnd), "```\n## not a heading\n```\nmore\n");
  });

  it("throws Heading not found with the available headings", () => {
    assert.throws(
      () => findSection(doc, "## Missing"),
      { message: "Heading not found: ## Missing\nAvailable headings:\n# Devlog\n## 2026-10-07\n## 2026-10-08\n### Detail\n## 2026-10-09" }
    );
  });

  it("caps the available-headings list at 30 with a +N more line", () => {
    const content = Array.from({ length: 45 }, (_, i) => `## H${i + 1}\n`).join("");
    assert.throws(() => findSection(content, "## Missing"), (err) => {
      const lines = err.message.split("\n");
      assert.equal(lines[2], "## H1");
      assert.equal(lines[31], "## H30");
      assert.equal(lines[32], "… +15 more");
      assert.equal(lines.length, 33);
      return true;
    });
  });

  it("throws on duplicate headings, listing each match with its line number", () => {
    const content = "# T\n## Notes\na\n## Other\n## Notes\nb\n";
    assert.throws(
      () => findSection(content, "Notes"),
      { message: "Heading \"Notes\" is ambiguous (2 matches):\n  line 2: ## Notes\n  line 5: ## Notes\nUse a unique heading." }
    );
  });

  it("works on CRLF content: the section keeps CRLF and stops before the next heading", () => {
    const content = "---\r\na: 1\r\n---\r\n## A\r\nline\r\n## B\r\n";
    const range = findSection(content, "## A");
    assert.equal(content.slice(range.headingStart, range.sectionEnd), "## A\r\nline\r\n");
  });

  for (const [name, content] of [
    ["empty content", ""],
    ["frontmatter only", "---\ntype: note\n---\n"],
    ["empty frontmatter", "---\n---\n"],
  ]) {
    it(`throws Heading not found (not a crash) on ${name}`, () => {
      assert.throws(() => findSection(content, "## A"), { message: "Heading not found: ## A\nAvailable headings:\n(none)" });
    });
  }

  it("parses and finds a section in a 2 MB note with 750 headings in under 200 ms", () => {
    const entry = (i) => `## 2026-01-01 ${String(i).padStart(4, "0")}\n\n${"Entry text with some words. ".repeat(95)}\n\n\`\`\`js\n## not a heading ${i}\n\`\`\`\n\n`;
    const content = "---\ntype: devlog\n---\n# Devlog\n\n" + Array.from({ length: 750 }, (_, i) => entry(i)).join("");
    assert.ok(content.length >= 1_900_000, `fixture is ${content.length} chars`);
    const start = performance.now();
    const headings = parseHeadings(content);
    const range = findSection(content, "## 2026-01-01 0700");
    const elapsed = performance.now() - start;
    assert.equal(headings.length, 751);
    assert.ok(content.slice(range.headingStart).startsWith("## 2026-01-01 0700\n"));
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  });
});

describe("sectionRange", () => {
  it("bounds the section of a given heading object from parseHeadings", () => {
    const content = "# T\n## A\na\n### A1\nb\n## B\n";
    const headings = parseHeadings(content);
    const range = sectionRange(content, headings, headings[1]);
    assert.deepEqual(
      [range.headingStart, range.afterHeading, range.sectionEnd, range.heading],
      [4, 9, content.indexOf("## B"), headings[1]]
    );
  });
});

describe("formatHeadingList", () => {
  const headings = parseHeadings("# A\n## B\n## C\n### D\n");

  for (const [name, list, max, expected] of [
    ["empty", [], 30, "(none)"],
    ["under the cap", headings, 30, "# A\n## B\n## C\n### D"],
    ["over the cap", headings, 2, "# A\n## B\n… +2 more"],
  ]) {
    it(`renders raw lines capped at max: ${name}`, () => {
      assert.equal(formatHeadingList(list, max), expected);
    });
  }

  it("defaults the cap to 30", () => {
    const many = parseHeadings(Array.from({ length: 31 }, (_, i) => `## H${i}\n`).join(""));
    assert.equal(formatHeadingList(many).split("\n").at(-1), "… +1 more");
  });
});

describe("maskCode", () => {
  for (const [name, content, expected] of [
    ["``` block including fence lines", "a\n```\n[[x]]\n```\nb\n", "a\n   \n     \n   \nb\n"],
    ["~~~ block", "~~~\n[[x]]\n~~~\n", "   \n     \n   \n"],
    ["unclosed fence to the end", "a\n```\n[[x]]\n", "a\n   \n     \n"],
    ["CRLF block keeps \\r\\n", "```\r\n[[x]]\r\n```\r\nb", "   \r\n     \r\n   \r\nb"],
  ]) {
    it(`blanks fenced code blocks: ${name}`, () => {
      assert.equal(maskCode(content), expected);
    });
  }

  for (const [name, content, expected] of [
    ["single backticks", "see `[[x]]` and [[y]]", "see " + " ".repeat(7) + " and [[y]]"],
    ["double backticks containing a single backtick", "``a ` [[x]]`` [[y]]", " ".repeat(13) + " [[y]]"],
    ["span across a single line break", "`a\n[[x]]` [[y]]", "  \n" + " ".repeat(6) + " [[y]]"],
  ]) {
    it(`blanks inline code spans: ${name}`, () => {
      assert.equal(maskCode(content), expected);
    });
  }

  for (const [name, content] of [
    ["unmatched backtick", "it`s [[x]]"],
    ["mismatched run lengths", "``a` [[x]]"],
    ["span broken by a blank line", "`a\n\n[[x]]`"],
  ]) {
    it(`leaves backticks that do not form a span literal: ${name}`, () => {
      assert.equal(maskCode(content), content);
    });
  }

  it("leaves the frontmatter untouched", () => {
    const content = "---\nrelated: \"`[[x]]`\"\n---\n`[[y]]`\n";
    assert.equal(maskCode(content), "---\nrelated: \"`[[x]]`\"\n---\n       \n");
  });
});

describe("frontmatterList", () => {
  const cases = [
    ["inline list", "repos: [a, b]\n", ["a", "b"]],
    ["inline list with quoted items", "repos: [\"a/b\", 'c, d']\n", ["a/b", "c, d"]],
    ["inline list with a trailing comment", "repos: [a, b] # note\n", ["a", "b"]],
    ["empty inline list", "repos: []\n", []],
    ["indented block list", "repos:\n  - a\n  - b\n", ["a", "b"]],
    ["block list at column 0", "repos:\n- a\n- b\n", ["a", "b"]],
    ["quoted block items", "repos:\n  - \"a#b\"\n  - 'c'\n", ["a#b", "c"]],
    ["block list with blank and comment lines", "repos:\n  - a\n\n  # skip\n  - b\n", ["a", "b"]],
    ["block list after a comment on the key line", "repos: # where\n  - a\n", ["a"]],
    ["block list stopping at the next key", "repos:\n  - a\ntags:\n  - t\n", ["a"]],
    ["block item with a trailing comment", "repos:\n  - a # note\n", ["a"]],
    ["plain scalar", "repos: a/b\n", ["a/b"]],
    ["scalar with a trailing comment", "repos: a/b # note\n", ["a/b"]],
    ["quoted scalar containing #", "repos: \"a#b\"\n", ["a#b"]],
    ["empty value", "repos:\ntags: [x]\n", []],
    ["null", "repos: null\n", []],
    ["tilde", "repos: ~\n", []],
    ["CRLF block list", "repos:\r\n  - a\r\n  - b\r\ntags: [x]\r\n", ["a", "b"]],
    ["CRLF inline list", "repos: [a, b]\r\n", ["a", "b"]],
    ["absent key", "tags: [x]\n", []],
    ["longer key with the same prefix", "repos_old: [x]\n", []],
    ["indented (non-top-level) key", "meta:\n  repos: [x]\n", []],
    ["null frontmatter", null, []],
  ];
  for (const [name, fm, expected] of cases) {
    it(`reads ${name}`, () => {
      assert.deepEqual(frontmatterList(fm, "repos"), expected);
    });
  }
});
