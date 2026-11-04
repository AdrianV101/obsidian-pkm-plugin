import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chunkNote, chunkHash, getPreview, CHUNK_MAX_CHARS } from "../chunker.js";

const MAX = 1000;
const opts = { maxChars: MAX };

const bodyOf = (chunk) => chunk.text.split("\n").slice(2).join("\n");
const titleOf = (chunk) => chunk.text.split("\n")[0];
const para = (ch, n = 140) => ch.repeat(n);
const paras = (prefix, count, size = 140) =>
  Array.from({ length: count }, (_, i) => para(String.fromCharCode(prefix.charCodeAt(0) + i), size));

describe("chunkNote: sizes and splitting", () => {
  it("uses 4000 characters by default", () => {
    assert.equal(CHUNK_MAX_CHARS, 4000);
    const content = "x".repeat(3990);
    assert.equal(chunkNote(content, "a.md").length, 1);
    assert.equal(chunkNote("x".repeat(3890) + "\n\n" + "y".repeat(100), "a.md").length, 1);
  });

  it("keeps a body within the limit as one chunk, with the title line first", () => {
    const content = "---\ntype: note\n---\n\n## One\n\nalpha\n\n## Two\n\nbeta\n\n## Three\n\ngamma";
    const chunks = chunkNote(content, "notes/greeting.md", opts);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.startsWith("greeting \u203a One\n\n"), chunks[0].text);
    assert.ok(chunks[0].text.includes("gamma"));
    assert.ok(!chunks[0].text.includes("type: note"));
    assert.ok(chunks[0].preview.length > 0);
  });

  it("splits a longer body at ## headings; the preamble is its own chunk; ### does not split", () => {
    const content = [
      "Preamble " + para("p", 300),
      "## A\n\n" + para("a", 300) + "\n\n### A.1\n\n" + para("b", 300),
      "## B\n\n" + para("c", 300),
    ].join("\n\n");
    const chunks = chunkNote(content, "n.md", opts);
    assert.equal(chunks.length, 3);
    assert.ok(bodyOf(chunks[0]).startsWith("Preamble"));
    assert.ok(!bodyOf(chunks[0]).includes("## A"));
    assert.ok(bodyOf(chunks[1]).startsWith("## A"));
    assert.ok(bodyOf(chunks[1]).includes("### A.1"));
    assert.ok(bodyOf(chunks[2]).startsWith("## B"));
  });

  for (const fence of ["```", "~~~"]) {
    it(`does not split at a ## line inside a ${fence} fence`, () => {
      const code = `${fence}\n## not a heading\n${para("z", 400)}\n${fence}`;
      const content = `## A\n\n${para("a", 300)}\n\n${code}\n\n## B\n\n${para("b", 300)}`;
      const chunks = chunkNote(content, "n.md", opts);
      assert.equal(chunks.length, 2);
      assert.ok(bodyOf(chunks[0]).includes("## not a heading"));
      assert.ok(bodyOf(chunks[1]).startsWith("## B"));
    });
  }
});

describe("chunkNote: top-up of the last piece", () => {
  const section = (n, size) => "## S\n\n" + paras("a", n, size).join("\n\n");

  // [label, section text, expected pieces] for sections of 1.4x, 2.1x and exactly 2x the limit
  const exact = [499, 499, 499, 497].map((n, i) => para(String.fromCharCode(97 + i), n)).join("\n\n");
  const table = [
    ["1.4x", section(10, 140), 2],
    ["2.1x", section(15, 140), 3],
    ["2x exactly", exact, 2],
  ];
  assert.equal(exact.length, 2 * MAX);
  for (const [label, text, expected] of table) {
    it(`packs whole paragraphs and tops up the last piece (${label})`, () => {
      const chunks = chunkNote(text, "n.md", opts);
      assert.equal(chunks.length, expected);
      const bodies = chunks.map(bodyOf);
      for (const b of bodies) assert.ok(b.length <= MAX, `body of ${b.length} chars`);
      // every paragraph is covered and the pieces end at paragraph boundaries
      for (const p of text.split("\n\n")) assert.ok(bodies.some((b) => b.includes(p)));
      // the last piece cannot be extended by the paragraph before it
      const last = bodies.at(-1);
      const before = text.slice(0, text.lastIndexOf(last));
      const prevPara = before.trimEnd().split(/\n\n/).at(-1);
      assert.ok(last.length + 2 + prevPara.length > MAX || bodies.length === 1,
        `last piece ${last.length} could still absorb ${prevPara.length}`);
    });
  }

  it("makes the last piece overlap the one before it when that fills it up", () => {
    const chunks = chunkNote(section(10, 140), "n.md", opts);
    assert.equal(chunks.length, 2);
    const [first, second] = chunks.map(bodyOf);
    assert.ok(second.length > 140 * 3, "topped up beyond the 3 left-over paragraphs");
    assert.ok(first.includes(second.split("\n\n")[0]), "shares a paragraph with the previous piece");
  });

  it("never reaches into another section", () => {
    const content = [
      "## First\n\n" + paras("a", 6, 140).join("\n\n"),
      "## Second\n\n" + paras("m", 10, 140).join("\n\n"),
    ].join("\n\n");
    const chunks = chunkNote(content, "n.md", opts);
    const second = chunks.filter((c) => titleOf(c).includes("Second"));
    assert.ok(second.length >= 2);
    for (const c of second) assert.ok(!bodyOf(c).includes("a".repeat(140)));
    for (const c of chunks.filter((c) => titleOf(c).endsWith("First"))) {
      assert.ok(!bodyOf(c).includes("m".repeat(140)));
    }
  });
});

describe("chunkNote: stable hashes", () => {
  const mk = (n) => "## S\n\n" + paras("a", n, 1000 - 0).map((p) => p.slice(0, 1000)).join("\n\n");

  it("appending to a partly filled last piece changes only that piece's hash", () => {
    // 1000-char paragraphs, 4000-char limit: three per piece
    const before = chunkNote(mk(8), "n.md").map((c) => c.hash);
    const after = chunkNote(mk(9), "n.md").map((c) => c.hash);
    assert.equal(before.length, after.length);
    assert.deepEqual(before.slice(0, -1), after.slice(0, -1));
    assert.notEqual(before.at(-1), after.at(-1));
  });

  it("a full last piece gets a new piece and leaves earlier hashes alone", () => {
    const before = chunkNote(mk(9), "n.md").map((c) => c.hash);
    const after = chunkNote(mk(10), "n.md").map((c) => c.hash);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before);
  });
});

describe("chunkNote: oversize paragraphs and awkward input", () => {
  it("hard-splits an oversize paragraph at the limit", () => {
    const chunks = chunkNote("y".repeat(20000), "n.md");
    assert.equal(chunks.length, 5);
    for (const c of chunks) assert.ok(bodyOf(c).length <= CHUNK_MAX_CHARS);
    assert.equal(chunks.map(bodyOf).join(""), "y".repeat(20000));
  });

  const awkward = [
    ["CRLF", "## A\r\n\r\n" + "a".repeat(600) + "\r\n\r\n## B\r\n\r\n" + "b".repeat(600), (cs) => {
      assert.equal(cs.length, 2);
      for (const c of cs) assert.ok(!c.text.includes("\r"));
    }],
    ["BOM", "﻿---\ntype: note\n---\n\nHello", (cs) => {
      assert.equal(cs.length, 1);
      assert.ok(!cs[0].text.includes("﻿"));
      assert.ok(!cs[0].text.includes("type: note"));
      assert.ok(cs[0].text.endsWith("Hello"));
    }],
    ["heading-only note", "## Just a heading", (cs) => {
      assert.equal(cs.length, 1);
      assert.deepEqual(cs[0].headingPath, ["Just a heading"]);
    }],
    ["empty body", "---\ntype: note\n---\n\n   \n", (cs) => assert.equal(cs.length, 0)],
    ["emoji", "\u{1F600}".repeat(1500), (cs) => {
      assert.ok(cs.length > 1);
      for (const c of cs) {
        const b = bodyOf(c);
        assert.ok(b.length <= MAX);
        assert.ok(!/[\uD800-\uDBFF]$/.test(b) && !/^[\uDC00-\uDFFF]/.test(b), "split inside a surrogate pair");
      }
    }],
    ["CJK", "中".repeat(2500), (cs) => {
      assert.equal(cs.length, 3);
      for (const c of cs) assert.ok(bodyOf(c).length <= MAX);
    }],
  ];
  for (const [label, content, check] of awkward) {
    it(`handles ${label}`, () => check(chunkNote(content, "n.md", opts)));
  }

  it("keeps every body within maxChars when an oversize paragraph follows normal ones", () => {
    const content = "## S\n\n" + para("a", 300) + "\n\n" + para("b", 2500) + "\n\n" + para("c", 300);
    const chunks = chunkNote(content, "n.md", opts);
    for (const c of chunks) assert.ok(bodyOf(c).length <= MAX);
  });
});

describe("chunkNote: title and heading path", () => {
  it("lists every enclosing heading of any level at the chunk's first line", () => {
    const content = "# Top\n\n## A\n\n### A.1\n\n" + paras("a", 12, 140).join("\n\n");
    const chunks = chunkNote(content, "dir/Note.md", { maxChars: 300 });
    const last = chunks.at(-1);
    assert.equal(titleOf(last), "Note › Top › A › A.1");
    assert.deepEqual(last.headingPath, ["Top", "A", "A.1"]);
  });

  it("a later sibling replaces the earlier one in the path", () => {
    const content = "## A\n\n### A.1\n\n" + para("a", 600) + "\n\n## B\n\n### B.1\n\n" + para("b", 600);
    const chunks = chunkNote(content, "Note.md", opts);
    assert.deepEqual(chunks.at(-1).headingPath, ["B"]);
    assert.equal(titleOf(chunks.at(-1)), "Note › B");
  });

  it("has only the title when no heading encloses the chunk", () => {
    const [c] = chunkNote("just text", "dir/Plain.md");
    assert.equal(titleOf(c), "Plain");
    assert.deepEqual(c.headingPath, []);
  });

  it("renaming the note or a heading changes only the affected hashes", () => {
    const content = "## A\n\n" + para("a", 700) + "\n\n## B\n\n" + para("b", 700);
    const base = chunkNote(content, "One.md", opts).map((c) => c.hash);
    const renamed = chunkNote(content, "Two.md", opts).map((c) => c.hash);
    assert.ok(base.every((h, i) => h !== renamed[i]));
    const retitled = chunkNote(content.replace("## B", "## C"), "One.md", opts).map((c) => c.hash);
    assert.equal(retitled[0], base[0]);
    assert.notEqual(retitled[1], base[1]);
  });

  it("does not count the title line against maxChars", () => {
    const [c] = chunkNote("z".repeat(MAX), "A very long note title ".repeat(10) + ".md", opts);
    assert.equal(bodyOf(c).length, MAX);
  });
});

describe("chunkNote: overlap", () => {
  const content = "## S\n\n" + paras("a", 15, 140).join("\n\n");
  const lastPara = (b) => b.split("\n\n").at(-1);

  it("repeats the previous piece's last paragraph at the start of each following piece", () => {
    const chunks = chunkNote(content, "n.md", { maxChars: MAX, overlap: true }).map(bodyOf);
    assert.ok(chunks.length >= 3);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].length <= MAX);
      // the final piece is also topped up, so it may start earlier than the repeated paragraph
      if (i < chunks.length - 1) assert.equal(chunks[i].split("\n\n")[0], lastPara(chunks[i - 1]), `piece ${i}`);
      else assert.ok(chunks[i].includes(lastPara(chunks[i - 1])), `piece ${i}`);
    }
  });

  it("has no repeated paragraph between full pieces by default", () => {
    const chunks = chunkNote(content, "n.md", opts).map(bodyOf);
    assert.equal(chunks[1].split("\n\n")[0] === lastPara(chunks[0]), false);
  });
});

describe("chunkHash", () => {
  it("is the hex sha256 of the exact text", () => {
    const text = "Title › H\n\nbody";
    assert.equal(chunkHash(text), crypto.createHash("sha256").update(text).digest("hex"));
    const [c] = chunkNote("body", "Title.md");
    assert.equal(c.hash, chunkHash(c.text));
  });
});

describe("getPreview", () => {
  it("returns short text unchanged after stripping heading markers", () => {
    assert.equal(getPreview("This is a short preview."), "This is a short preview.");
  });

  it("truncates to 100 words with an ellipsis", () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const preview = getPreview(text);
    assert.ok(preview.endsWith("..."));
    assert.ok(preview.includes("word99"));
    assert.ok(!preview.includes("word100 "));
  });

  it("returns an empty string for empty input", () => {
    assert.equal(getPreview(""), "");
  });

  it("strips markdown heading markers", () => {
    const preview = getPreview("## Section Title\n\nSome content here.");
    assert.ok(!preview.startsWith("##"));
    assert.ok(preview.includes("Section Title"));
  });
});
