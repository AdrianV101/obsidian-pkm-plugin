import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { performance } from "node:perf_hooks";
import {
  devlogFolder,
  sessionPrefix,
  classifyNoteName,
  dayNoteName,
  listDevlogNotes,
  findSessionNote,
  parseDevlog,
} from "../devlog.js";

const pad = (n) => String(n).padStart(2, "0");
function localPrefix(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

describe("devlogFolder", () => {
  it("is the project's development/devlog folder, vault-relative with forward slashes", () => {
    assert.equal(devlogFolder("01-Projects/My App"), "01-Projects/My App/development/devlog");
  });
});

describe("sessionPrefix", () => {
  it("formats a timestamp as local YYYY-MM-DD HHmm", () => {
    const iso = "2026-10-27T09:14:33.000Z";
    const offset = "2026-10-27T09:14:33+02:00";
    const ms = Date.UTC(2026, 9, 27, 23, 59, 0);
    assert.equal(sessionPrefix(iso), localPrefix(new Date(iso)));
    assert.equal(sessionPrefix(offset), localPrefix(new Date(offset)));
    assert.equal(sessionPrefix(ms), localPrefix(new Date(ms)));
    assert.match(sessionPrefix(iso), /^\d{4}-\d{2}-\d{2} \d{4}$/);
  });

  it("returns null for invalid input", () => {
    for (const bad of ["", "not a date", null, undefined, NaN, {}]) {
      assert.equal(sessionPrefix(bad), null, String(bad));
    }
  });
});

describe("classifyNoteName", () => {
  it("classifies session notes, day notes and non-matches", () => {
    const cases = [
      ["2026-10-27 0914 SP4 devlog brainstorm.md", { kind: "session", date: "2026-10-27", time: "09:14", title: "SP4 devlog brainstorm" }],
      ["2026-10-27 0914 Fix the devlog.md", { kind: "session", date: "2026-10-27", time: "09:14", title: "Fix the devlog" }],
      ["2026-10-27 2359 Late night.md", { kind: "session", date: "2026-10-27", time: "23:59", title: "Late night" }],
      ["2026-10-27 My App devlog.md", { kind: "day", date: "2026-10-27", project: "My App" }],
      ["2026-10-27 Scope devlog.md", { kind: "day", date: "2026-10-27", project: "Scope" }],
      ["devlog.md", null],
      ["2026-10-27 Some title.md", null],
      ["2026-10-27 2460 Bad time.md", null],
      ["2026-10-27 0914 Not markdown.txt", null],
      ["2026-10-27.md", null],
      ["2026-10-27", null],
    ];
    for (const [name, expected] of cases) {
      assert.deepEqual(classifyNoteName(name), expected, name);
    }
  });
});

describe("dayNoteName", () => {
  it("round-trips through classifyNoteName, including a project name with spaces", () => {
    for (const project of ["Scope", "My Cool App"]) {
      const name = dayNoteName("2026-10-27", project);
      assert.equal(name, `2026-10-27 ${project} devlog.md`);
      assert.deepEqual(classifyNoteName(name), { kind: "day", date: "2026-10-27", project });
    }
  });
});

describe("devlog folder reads", () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-devlog-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("listDevlogNotes", () => {
    it("lists newest first, day notes at 00:00, ties by name descending, skipping non-matches", async () => {
      const names = [
        "2026-10-26 2330 Late work.md",
        "2026-10-27 0000 Midnight.md",
        "2026-10-27 My App devlog.md",
        "2026-10-27 0914 Morning session.md",
        "2026-10-27 0914 Another morning.md",
        "devlog.md",
        "notes.txt",
        "2026-10-27 2460 Bad.md",
      ];
      for (const n of names) await fs.writeFile(path.join(tmpDir, n), "x");
      await fs.mkdir(path.join(tmpDir, "2026-10-28 1000 Folder named like a note.md"));
      await fs.mkdir(path.join(tmpDir, "sub"));

      const listed = await listDevlogNotes(tmpDir);
      assert.deepEqual(listed, [
        { name: "2026-10-27 0914 Morning session.md", kind: "session", key: "2026-10-27 09:14" },
        { name: "2026-10-27 0914 Another morning.md", kind: "session", key: "2026-10-27 09:14" },
        { name: "2026-10-27 My App devlog.md", kind: "day", key: "2026-10-27 00:00" },
        { name: "2026-10-27 0000 Midnight.md", kind: "session", key: "2026-10-27 00:00" },
        { name: "2026-10-26 2330 Late work.md", kind: "session", key: "2026-10-26 23:30" },
      ]);
    });

    it("gives [] for a missing folder and throws for other errors", async () => {
      assert.deepEqual(await listDevlogNotes(path.join(tmpDir, "absent")), []);
      const file = path.join(tmpDir, "plain.txt");
      await fs.writeFile(file, "x");
      await assert.rejects(listDevlogNotes(file));
    });
  });

  describe("findSessionNote", () => {
    const prefix = "2026-10-27 0914";
    const note = (id) => `---\ntype: devlog-session\nsession: ${id}\n---\n\n## body\n`;

    it("returns the note whose prefix and session id match, plain or quoted", async () => {
      await fs.writeFile(path.join(tmpDir, `${prefix} Plain id.md`), note("abc-123"));
      await fs.writeFile(path.join(tmpDir, `${prefix} Double quoted.md`), note('"def-456"'));
      await fs.writeFile(path.join(tmpDir, `${prefix} Single quoted.md`), note("'ghi-789'  "));
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), `${prefix} Plain id.md`);
      assert.equal(await findSessionNote(tmpDir, prefix, "def-456"), `${prefix} Double quoted.md`);
      assert.equal(await findSessionNote(tmpDir, prefix, "ghi-789"), `${prefix} Single quoted.md`);
    });

    it("is null without a prefix match, with only another session's id, and for a missing folder", async () => {
      await fs.writeFile(path.join(tmpDir, `${prefix} Other.md`), note("other-id"));
      await fs.writeFile(path.join(tmpDir, "2026-10-27 0915 Later.md"), note("abc-123"));
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), null);
      assert.equal(await findSessionNote(tmpDir, "2026-01-01 0000", "abc-123"), null);
      assert.equal(await findSessionNote(path.join(tmpDir, "absent"), prefix, "abc-123"), null);
    });

    it("picks the right one of two notes sharing a prefix and ignores a prefix that is a longer number", async () => {
      await fs.writeFile(path.join(tmpDir, `${prefix} First.md`), note("one"));
      await fs.writeFile(path.join(tmpDir, `${prefix} Second.md`), note("two"));
      assert.equal(await findSessionNote(tmpDir, prefix, "two"), `${prefix} Second.md`);
      assert.equal(await findSessionNote(tmpDir, prefix, "one"), `${prefix} First.md`);
      assert.equal(await findSessionNote(tmpDir, prefix, "on"), null);
    });

    it("skips an unreadable candidate", async (t) => {
      if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("chmod not enforceable");
      const bad = path.join(tmpDir, `${prefix} Locked.md`);
      await fs.writeFile(bad, note("abc-123"));
      await fs.chmod(bad, 0o000);
      await fs.writeFile(path.join(tmpDir, `${prefix} Open.md`), note("abc-123"));
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), `${prefix} Open.md`);
    });

    it("opens no file without the prefix", async (t) => {
      if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("chmod not enforceable");
      const other = path.join(tmpDir, "2026-10-27 0915 Unreadable.md");
      await fs.writeFile(other, note("abc-123"));
      await fs.chmod(other, 0o000);
      await fs.writeFile(path.join(tmpDir, `${prefix} Target.md`), note("abc-123"));
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), `${prefix} Target.md`);
    });

    it("reads at most 4,096 bytes of a candidate", async () => {
      const head = "---\ntype: devlog-session\n";
      const padding = "x: " + "a".repeat(5000) + "\n";
      await fs.writeFile(path.join(tmpDir, `${prefix} Late id.md`), head + padding + "session: abc-123\n---\n");
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), null);
      await fs.writeFile(path.join(tmpDir, `${prefix} Early id.md`), head + "session: abc-123\n---\n" + "z".repeat(10000));
      assert.equal(await findSessionNote(tmpDir, prefix, "abc-123"), `${prefix} Early id.md`);
    });
  });
});

describe("parseDevlog", () => {
  const INTRO = "This log tracks development progress, decisions made, and lessons learned.";
  const slices = (content, ranges) => ranges.map((r) => content.slice(r.start, r.end));

  /** Every range, sorted by offset, tiles the content exactly once; each array is in offset order. */
  function assertPartition(content, parsed, label) {
    for (const key of ["entries", "kept", "scaffolding"]) {
      const starts = parsed[key].map((r) => r.start);
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${label}: ${key} in offset order`);
    }
    const ranges = [parsed.frontmatter, ...parsed.entries, ...parsed.kept, ...parsed.scaffolding]
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const r of ranges) {
      assert.equal(r.start, pos, `${label}: gap or overlap at ${pos}`);
      assert.ok(r.end > r.start, `${label}: empty range at ${r.start}`);
      pos = r.end;
    }
    assert.equal(pos, content.length, `${label}: ranges stop short of the end`);
    assert.equal(slices(content, ranges).join(""), content, label);
  }

  it("opens an entry at a dated ## or ### heading with its date, time, key, heading text and style", () => {
    const entry = (content, fields) => [{ start: 0, end: content.length, ...fields }];
    const cases = [
      ["### 2026-05-19 14:32\n- did x\n", { date: "2026-05-19", time: "14:32", key: "2026-05-19 14:32", heading: "2026-05-19 14:32", style: "h3" }],
      ["### 2026-05-19 14:32 - Title\n- did x\n", { date: "2026-05-19", time: "14:32", key: "2026-05-19 14:32", heading: "2026-05-19 14:32 - Title", style: "h3" }],
      ["### 2026-05-19 9:05 Early start\n- did x\n", { date: "2026-05-19", time: "09:05", key: "2026-05-19 09:05", heading: "2026-05-19 9:05 Early start", style: "h3" }],
      ["### 2026-05-19\n- did x\n", { date: "2026-05-19", time: null, key: "2026-05-19 00:00", heading: "2026-05-19", style: "h3" }],
      [
        "## 2026-05-19\n\n### 14:32\n- did x\n\n### 16:05 Wrap-up\n- did y\n",
        { date: "2026-05-19", time: null, key: "2026-05-19 00:00", heading: "2026-05-19", style: "day" },
      ],
      ["## 2026-10-26: Title\n- did x\n", { date: "2026-10-26", time: null, key: "2026-10-26 00:00", heading: "2026-10-26: Title", style: "h2" }],
      ["## 2026-10-26 18:40 Title\n- did x\n", { date: "2026-10-26", time: "18:40", key: "2026-10-26 18:40", heading: "2026-10-26 18:40 Title", style: "h2" }],
    ];
    for (const [content, fields] of cases) {
      assert.deepEqual(parseDevlog(content).entries, entry(content, fields), content);
    }
    for (const content of ["# 2026-05-19\n- x\n", "#### 2026-05-19 14:32\n- x\n", "### Session 2026-05-19\n- x\n"]) {
      assert.deepEqual(parseDevlog(content).entries, [], content);
    }
  });

  it("runs an entry to the next dated ##/### heading or undated #/## heading; undated ### to ###### headings and --- lines stay in it", () => {
    const cases = [
      ["### 2026-05-19 14:32\nA\n### 2026-05-18 09:00\nB\n", ["### 2026-05-19 14:32\nA\n", "### 2026-05-18 09:00\nB\n"]],
      ["## 2026-10-26: X\nA\n\n## 2026-10-25: Y\nB\n", ["## 2026-10-26: X\nA\n\n", "## 2026-10-25: Y\nB\n"]],
      ["## 2026-10-26: X\nA\n### 2026-10-25 10:00\nB\n", ["## 2026-10-26: X\nA\n", "### 2026-10-25 10:00\nB\n"]],
      ["### 2026-05-19 14:32\nA\n\n## Related\n- [[x]]\n", ["### 2026-05-19 14:32\nA\n\n"]],
      ["### 2026-05-19\nA\n## Sessions\n### 2026-05-18\nB\n", ["### 2026-05-19\nA\n", "### 2026-05-18\nB\n"]],
      ["### 2026-05-19 14:32\nA\n# Archive\nold\n", ["### 2026-05-19 14:32\nA\n"]],
      [
        "### 2026-05-19 14:32\n#### Session Summary\n- a\n### Commit\nabc\n##### Detail\n###### Deep\n---\n- b\n\n---\n\n",
        ["### 2026-05-19 14:32\n#### Session Summary\n- a\n### Commit\nabc\n##### Detail\n###### Deep\n---\n- b\n\n---\n\n"],
      ],
    ];
    for (const [content, expected] of cases) {
      const parsed = parseDevlog(content);
      assert.deepEqual(slices(content, parsed.entries), expected, content);
    }
  });

  it("treats frontmatter, # headings, blank and --- lines outside entries, the intro sentence, every ## Sessions line and a leading BOM as scaffolding", () => {
    const cases = [
      {
        content: `---\ntype: devlog\ntags:\n  - devlog\n---\n\n# Development Log\n\n${INTRO}\n\n## Sessions\n\n### 2026-05-19 14:32\nA\n`,
        frontmatter: "---\ntype: devlog\ntags:\n  - devlog\n---\n",
        scaffolding: `\n# Development Log\n\n${INTRO}\n\n## Sessions\n\n`,
      },
      {
        content: "### 2026-05-19 14:32\nA\n\n## Sessions\n\n---\n\n### 2026-05-18 09:00\nB\n## sessions\n---\n### 2026-05-17\nC\n",
        frontmatter: null,
        scaffolding: "## Sessions\n\n---\n\n## sessions\n---\n",
      },
      {
        content: `# Development Log\n  ${INTRO}  \n\n## 2026-10-26: A\nB\n`,
        frontmatter: null,
        scaffolding: `# Development Log\n  ${INTRO}  \n\n`,
      },
      {
        content: "﻿---\ntype: devlog\n---\n# Development Log\n### 2026-05-19\nA\n",
        frontmatter: "---\ntype: devlog\n---\n",
        scaffolding: "﻿# Development Log\n",
        bomRange: true,
      },
    ];
    for (const c of cases) {
      const parsed = parseDevlog(c.content);
      assert.equal(parsed.frontmatter && c.content.slice(parsed.frontmatter.start, parsed.frontmatter.end), c.frontmatter, c.content);
      assert.equal(slices(c.content, parsed.scaffolding).join(""), c.scaffolding, c.content);
      assert.deepEqual(parsed.kept, [], c.content);
      if (c.bomRange) assert.deepEqual(parsed.scaffolding[0], { start: 0, end: 1 });
    }
  });

  it("keeps all other text outside entries in file order: preamble and Sessions prose line by line, an undated ## section whole", () => {
    const content = [
      "---", "type: devlog", "---",
      "# Development Log",
      "",
      "Notes about this log.",
      "Second line.",
      "",
      "Another paragraph.",
      "",
      "## Sessions",
      "Newest first.",
      "",
      "### 2026-05-19 14:32",
      "A",
      "",
      "## Related",
      "",
      "### Links",
      "- [[one]]",
      "",
      "---",
      "- [[two]]",
      "",
      "## Notes",
      "text",
      "### 2026-05-18",
      "B",
      "# Archive",
      "",
      "old notes",
      "---",
      "more old notes",
      "",
    ].join("\n");
    assert.deepEqual(slices(content, parseDevlog(content).kept), [
      "Notes about this log.\nSecond line.\n",
      "Another paragraph.\n",
      "Newest first.\n",
      "## Related\n\n### Links\n- [[one]]\n\n---\n- [[two]]\n\n",
      "## Notes\ntext\n",
      "old notes\n",
      "more old notes\n",
    ]);
  });

  describe("partitions the content exactly", () => {
    const FRONTMATTER = "---\ntype: devlog\nproject: Demo\ncreated: 2026-05-19\ntags:\n  - devlog\n---\n";
    const PREAMBLE = `\n# Development Log\n\n${INTRO}\n\n`;
    const body = "#### Session Summary\n- did a thing\n\n#### Next Steps\n- next\n\n---\n\n";
    const singleStyle = (headings, sessions) =>
      FRONTMATTER + PREAMBLE + (sessions ? "## Sessions\n\n" : "") + headings.map((h) => `${h}\n\n${body}`).join("");

    const scopeLike = [
      FRONTMATTER + "\n# Development Log\n",
      "## 2026-10-26: Clippy prompt fixed (draft PR [#9000](https://example.com/pull/9000))",
      "",
      "Branch `clippy/fixed`, design [[design-note]].",
      "",
      "**Root cause:**",
      "- one",
      "",
      "#### Next Steps",
      "- Merge.",
      "",
      "---",
      "",
      "",
      "## 2026-10-20",
      "",
      "**Template import failures**",
      "",
      "### 14:32",
      "- undated child",
      "",
      "### 16:05 Wrap-up",
      "- more",
      "",
      "---",
      "",
      "<!-- New entries are added above this line -->",
      "",
      "",
      "## Sessions",
      "### 2026-10-19 19:17",
      "",
      "#### Session Summary",
      "- a",
      "---",
      "- b",
      "",
      "## Sessions",
      "",
      "### 2026-09-01",
      "",
      "#### Session Summary",
      "- fixed",
      "",
      "---",
      "",
      "",
      "## Sessions",
      "",
      "### 2026-09-07 22:40 — Fixed iOS camera roll permission bug (PR #5229)",
      "",
      "#### Blockers / Issues",
      "- x",
      "",
      "### 2026-05-19 9:05 - Early title",
      "- y",
      "",
    ].join("\n");
    const scopeEntries = [
      "2026-10-26: Clippy prompt fixed (draft PR [#9000](https://example.com/pull/9000))",
      "2026-10-20",
      "2026-10-19 19:17",
      "2026-09-01",
      "2026-09-07 22:40 — Fixed iOS camera roll permission bug (PR #5229)",
      "2026-05-19 9:05 - Early title",
    ];

    const fixtures = [
      { name: "h3 date and time", content: singleStyle(["### 2026-05-19 14:32", "### 2026-05-18 09:00"], true), entries: ["2026-05-19 14:32", "2026-05-18 09:00"] },
      { name: "h3 date, time and title", content: singleStyle(["### 2026-05-19 14:32 - Fix a bug", "### 2026-05-18 09:00 - Plan"], true), entries: ["2026-05-19 14:32 - Fix a bug", "2026-05-18 09:00 - Plan"] },
      { name: "h3 date only", content: singleStyle(["### 2026-05-19", "### 2026-05-18"], true), entries: ["2026-05-19", "2026-05-18"] },
      { name: "day sections", content: singleStyle(["## 2026-05-19\n\n### 14:32", "## 2026-05-18\n\n### 09:00"], false), entries: ["2026-05-19", "2026-05-18"] },
      { name: "h2 date and title", content: singleStyle(["## 2026-10-26: Title one", "## 2026-10-25: Title two"], false), entries: ["2026-10-26: Title one", "2026-10-25: Title two"] },
      { name: "Scope-like mixed file", content: scopeLike, entries: scopeEntries },
      { name: "CRLF", content: scopeLike.replace(/\n/g, "\r\n"), entries: scopeEntries },
      { name: "no frontmatter", content: `# Development Log\n\n${INTRO}\n\n## 2026-10-26: A\nB\n\n## Related\n- [[x]]\n`, entries: ["2026-10-26: A"] },
      { name: "no final newline after an entry", content: "# Development Log\n\n### 2026-05-19 14:32\n- last line", entries: ["2026-05-19 14:32"] },
      { name: "no final newline after kept text", content: "### 2026-05-19\nA\n## Related\n- [[x]]", entries: ["2026-05-19"] },
      { name: "no final newline after scaffolding", content: "Preamble.\n## Sessions\n---", entries: [] },
      {
        name: "emoji and CJK",
        content: `${FRONTMATTER}# 开发日志 \u{1F4D3}\n\n前言 \u{1F600}\n\n### 2026-05-19 14:32 \u{1F680} 发布 版本\n- 完成了 測試 \u{1F44D}\n\n## 相关\n- [[笔记]] \u{1F517}\n`,
        entries: ["2026-05-19 14:32 \u{1F680} 发布 版本"],
      },
      {
        name: "dated headings inside fenced code",
        content: "# Dev\n\n~~~\n## 2026-01-01 fake\n~~~\n\n### 2026-05-19 14:32\nExample:\n```md\n## 2026-05-18 not an entry\n### 2026-05-17 10:00 nor this\n## Sessions\n```\ndone\n",
        entries: ["2026-05-19 14:32"],
      },
      { name: "unclosed fence swallows later headings", content: "### 2026-05-19\n```\n### 2026-05-18\n## Related\n", entries: ["2026-05-19"] },
      { name: "empty", content: "", entries: [] },
      { name: "BOM only", content: "﻿", entries: [] },
      { name: "frontmatter only, no final newline", content: "---\ntype: devlog\n---", entries: [] },
      { name: "unclosed frontmatter", content: "---\ntype: devlog\n# Dev\n### 2026-05-19\nA\n", entries: ["2026-05-19"] },
      { name: "BOM, frontmatter and CRLF", content: "﻿---\r\ntype: devlog\r\n---\r\n\r\n## 2026-05-19\r\n### 14:32\r\nA\r\n", entries: ["2026-05-19"] },
    ];

    for (const f of fixtures) {
      it(f.name, () => {
        const parsed = parseDevlog(f.content);
        assertPartition(f.content, parsed, f.name);
        assert.deepEqual(parsed.entries.map((e) => e.heading), f.entries, f.name);
      });
    }
  });

  it("parses a 2 MB devlog with 800 entries in under 1 s", () => {
    const filler = "- " + "lorem ipsum dolor sit amet, ".repeat(4) + "\n";
    const entryBody = "\n#### Session Summary\n" + filler.repeat(14) + "\n```js\n## not a heading\n```\n\n#### Next Steps\n" + filler.repeat(8) + "\n---\n\n";
    const parts = ["---\ntype: devlog\n---\n\n# Development Log\n\n## Sessions\n\n"];
    for (let i = 0; i < 800; i++) {
      const date = new Date(Date.UTC(2026, 9, 27) - i * 86_400_000).toISOString().slice(0, 10);
      const heading = [`### ${date} 14:32 - Entry ${i}`, `## ${date}: Entry ${i}`, `## ${date}\n\n### 09:15`, `### ${date}`][i % 4];
      parts.push(`${heading}\n${entryBody}`);
    }
    const content = parts.join("");
    assert.ok(content.length >= 2_000_000, `fixture is ${content.length} chars`);

    const t0 = performance.now();
    const parsed = parseDevlog(content);
    const elapsed = performance.now() - t0;
    assert.equal(parsed.entries.length, 800);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });
});
