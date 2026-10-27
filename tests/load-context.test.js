import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { performance } from "node:perf_hooks";
import {
  loadProjectContext,
  CONTEXT_BUDGET,
  INDEX_BUDGET,
  COMPACT_BUDGET,
} from "../hooks/load-context.js";

const projectPath = "01-Projects/Big";
const FOLDER = `${projectPath}/development/devlog`;
const canChmod = process.platform !== "win32" && !(process.getuid && process.getuid() === 0);

const filler = (label, chars) => Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `${label} line ${String(i).padStart(4, "0")} ....................`).join("\n");

/** One `## <key> <heading>` section of a session note. */
function section({ key, heading = "Work", summary = "Did things.", next = "More things.", extra = "" }) {
  return `## ${key} ${heading}\n\n### Summary\n${summary}\n\n### Decisions\nNone.\n\n### Blockers\nNone.\n\n### Next steps\n${next}\n${extra}`;
}

function sessionNote(id, sections) {
  return `---\ntype: devlog-session\nproject: Big\nsession: ${id}\ntags: [devlog]\n---\n\n${sections.map(section).join("\n")}`;
}

const noteName = (key, title = "Work") => `${key.slice(0, 10)} ${key.slice(11, 13)}${key.slice(14)} ${title}.md`;

let vaultPath;
const projectDir = () => path.join(vaultPath, projectPath);

async function write(rel, content, options) {
  await fs.mkdir(path.dirname(path.join(projectDir(), rel)), { recursive: true });
  await fs.writeFile(path.join(projectDir(), rel), content, options);
}

async function writeSession(key, title, sections = [{ key }]) {
  const name = noteName(key, title);
  await write(`development/devlog/${name}`, sessionNote(`s-${key}`, sections));
  return name;
}

const legacyFile = (entries) => `---\ntype: devlog\n---\n\n# Development Log\n\n## Sessions\n\n${entries.join("\n")}`;
const legacyEntry = (heading, body = "Legacy body.") => `### ${heading}\n\n${body}\n`;

/** The `#### <label>` lines of the devlog part, in order. */
const labels = (context) => context.split("\n").filter(l => l.startsWith("#### ")).map(l => l.slice(5));
const devlogPart = (context) => context.split("### Recent Development Activity\n")[1];

beforeEach(async () => {
  vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-ctx-"));
  await fs.mkdir(projectDir(), { recursive: true });
});

afterEach(async () => {
  await fs.rm(vaultPath, { recursive: true, force: true });
});

describe("loadProjectContext items", () => {
  beforeEach(async () => {
    await write("_index.md", "---\ntype: project\n---\n\n# Big\n\n## Overview\nA test project.\n");
  });

  const merge = [
    {
      name: "session and day notes only",
      notes: [["2026-10-20 09:00", "Early"], ["2026-10-22 14:30", "Middle"], ["2026-10-25 08:15", "Late"]],
      day: ["2026-10-21"],
      expected: ["2026-10-25 0815 Late", "2026-10-22 1430 Middle", "2026-10-21 Big devlog", "2026-10-20 0900 Early"],
    },
    {
      name: "an unmigrated devlog.md only",
      legacy: ["2026-10-01 10:00 — A", "2026-10-03 09:00 — B", "2026-10-02 12:00 — C"],
      expected: ["devlog.md: 2026-10-03 09:00 — B", "devlog.md: 2026-10-02 12:00 — C", "devlog.md: 2026-10-01 10:00 — A"],
    },
    {
      name: "notes interleaved with legacy entries, the note first on a tie",
      notes: [["2026-10-05 10:00", "Note five"], ["2026-10-02 10:00", "Note two"]],
      legacy: ["2026-10-05 10:00 — Same", "2026-10-03 10:00 — Between", "2026-10-01 10:00 — Oldest"],
      expected: [
        "2026-10-05 1000 Note five", "devlog.md: 2026-10-05 10:00 — Same", "devlog.md: 2026-10-03 10:00 — Between",
        "2026-10-02 1000 Note two", "devlog.md: 2026-10-01 10:00 — Oldest",
      ],
    },
    {
      name: "more than 10 candidates: the 10 newest",
      notes: Array.from({ length: 12 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")} 10:00`, "Work"]),
      expected: Array.from({ length: 10 }, (_, i) => `2026-10-${String(12 - i).padStart(2, "0")} 1000 Work`),
    },
  ];
  for (const c of merge) {
    it(`index plus up to 10 items, newest first: ${c.name}`, async () => {
      for (const [key, title] of c.notes ?? []) await writeSession(key, title);
      if (c.day) await write(`development/devlog/${c.day[0]} Big devlog.md`, `---\ntype: devlog-day\n---\n\n## ${c.day[0]} 10:00 — Day\nDay body.\n`);
      if (c.legacy) await write("development/devlog.md", legacyFile(c.legacy.map(h => legacyEntry(h))));
      const { context, meta } = await loadProjectContext(vaultPath, projectPath);
      assert.ok(context.startsWith("## PKM Project Context: 01-Projects/Big\n\n### Project Index\n"), context);
      assert.ok(context.includes("A test project."));
      assert.deepEqual(labels(context), c.expected);
      assert.equal(meta.devlog, c.expected.length);
      assert.equal(meta.index, true);
    });
  }

  it("a session note shows its last section's heading, Summary and Next steps, and nothing else", async () => {
    const name = await writeSession("2026-10-27 10:00", "Two parts", [
      { key: "2026-10-27 10:00", heading: "First", summary: "FIRSTSUM", next: "FIRSTNEXT" },
      { key: "2026-10-27 15:30", heading: "Second", summary: "SECONDSUM", next: "SECONDNEXT" },
    ]);
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const part = devlogPart(context);
    assert.ok(part.startsWith(`#### ${name.slice(0, -3)}\n## 2026-10-27 15:30 Second\n`), part);
    assert.ok(part.includes("### Summary\nSECONDSUM") && part.includes("### Next steps\nSECONDNEXT"));
    assert.ok(!part.includes("FIRST") && !part.includes("### Decisions") && !part.includes("### Blockers"));
  });

  it("a newest section without both Summary and Next steps is shown from its top", async () => {
    await write("development/devlog/2026-10-27 1000 No next.md",
      "---\nsession: x\n---\n\n## 2026-10-27 10:00 Only summary\n\n### Summary\nSUM\n\n### Decisions\nDECIDED\n");
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const part = devlogPart(context);
    assert.ok(part.includes("## 2026-10-27 10:00 Only summary") && part.includes("SUM") && part.includes("### Decisions\nDECIDED"), part);
  });

  it("a day note shows its first entry, skipping a container day heading", async () => {
    await write("development/devlog/2026-10-12 Big devlog.md",
      "---\ntype: devlog-day\n---\n\n## 2026-10-12\n\n### 2026-10-12 16:00 Newest\nNEWESTBODY\n\n### 2026-10-12 09:00 Older\nOLDERBODY\n");
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const part = devlogPart(context);
    assert.ok(part.includes("### 2026-10-12 16:00 Newest\nNEWESTBODY"), part);
    assert.ok(!part.includes("OLDERBODY"));
    assert.deepEqual(labels(context), ["2026-10-12 Big devlog"]);
  });

  it("a legacy entry shows itself; the later of two equal-key entries counts as newer; a hub contributes nothing", async () => {
    await write("development/devlog.md", legacyFile([
      legacyEntry("2026-10-08 10:00 — First", "FIRSTBODY"), legacyEntry("2026-10-08 10:00 — Second", "SECONDBODY"),
    ]));
    let { context } = await loadProjectContext(vaultPath, projectPath);
    assert.deepEqual(labels(context), ["devlog.md: 2026-10-08 10:00 — Second", "devlog.md: 2026-10-08 10:00 — First"]);
    assert.ok(devlogPart(context).startsWith("#### devlog.md: 2026-10-08 10:00 — Second\n### 2026-10-08 10:00 — Second\n\nSECONDBODY"), devlogPart(context));

    await write("development/devlog.md", "---\ntype: devlog\n---\n\n# Development Log\n\nEach session has its own note.\n");
    ({ context } = await loadProjectContext(vaultPath, projectPath));
    assert.ok(context.includes("No devlog entries found."));
  });

  it("a CRLF session note renders its newest section's Summary and Next steps", async () => {
    await write("development/devlog/2026-10-27 1000 Crlf.md",
      sessionNote("c", [{ key: "2026-10-27 10:00", summary: "CRLFSUM", next: "CRLFNEXT" }]).replace(/\n/g, "\r\n"));
    const part = devlogPart((await loadProjectContext(vaultPath, projectPath)).context);
    assert.ok(part.includes("### Summary\r\nCRLFSUM") && part.includes("### Next steps\r\nCRLFNEXT"), part);
    assert.ok(!part.includes("### Decisions"));
  });

  it("a session note whose newest section is a container falls back to the last section with content", async () => {
    await write("development/devlog/2026-10-27 1000 Cont.md",
      sessionNote("c", [{ key: "2026-10-27 10:00", summary: "REALSUM", next: "REALNEXT" }]) + "\n## 2026-10-27 12:00 Empty\n\n");
    const part = devlogPart((await loadProjectContext(vaultPath, projectPath)).context);
    assert.ok(part.includes("## 2026-10-27 10:00 Work") && part.includes("REALSUM") && !part.includes("Empty"), part);
  });

  it("an unmigrated day entry with a body is an item", async () => {
    await write("development/devlog.md", "# Development Log\n\n## 2026-10-12\n\nDAYBODY\n");
    const { context } = await loadProjectContext(vaultPath, projectPath);
    assert.deepEqual(labels(context), ["devlog.md: 2026-10-12"]);
    assert.ok(context.includes("DAYBODY"));
  });

  it("dated container sections of an unmigrated devlog are not items", async () => {
    await write("development/devlog.md", "# Development Log\n\n## 2026-10-12\n\n### 2026-10-12 13:50 Child\nCHILDBODY\n");
    const { context } = await loadProjectContext(vaultPath, projectPath);
    assert.deepEqual(labels(context), ["devlog.md: 2026-10-12 13:50 Child"]);
  });

  it("task notes do not affect the context", async () => {
    await write("tasks/add-auth.md", "---\ntype: task\nstatus: active\npriority: high\n---\n\n# Add Authentication\n");
    await writeSession("2026-10-27 10:00", "Work");
    const { context, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(!context.includes("Add Authentication") && !context.includes("Active Tasks"));
    assert.ok(!("tasks" in meta));
  });
});

describe("loadProjectContext failures", () => {
  beforeEach(async () => {
    await write("_index.md", "# Big\n\n## Overview\nOVERVIEW\n");
  });

  it("loads with no devlog folder and no devlog.md, saying so", async () => {
    const { context, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(context.endsWith("### Recent Development Activity\nNo devlog entries found."), context);
    assert.equal(meta.devlog, 0);
    assert.equal(meta.index, true);
  });

  it("loads the devlog without an _index.md", async () => {
    await fs.rm(path.join(projectDir(), "_index.md"));
    await writeSession("2026-10-27 10:00", "Work");
    const { context, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(!context.includes("### Project Index"));
    assert.deepEqual([meta.index, meta.devlog], [false, 1]);
  });

  it("skips an unreadable note with one stderr line; the next one takes its place", { skip: !canChmod }, async (t) => {
    await writeSession("2026-10-03 10:00", "Third");
    await writeSession("2026-10-02 10:00", "Second");
    const broken = await writeSession("2026-10-04 10:00", "Broken");
    await fs.chmod(path.join(projectDir(), "development/devlog", broken), 0o000);
    const errors = t.mock.method(console, "error", () => {});
    const { context, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.deepEqual(labels(context), ["2026-10-03 1000 Third", "2026-10-02 1000 Second"]);
    assert.equal(meta.devlog, 2);
    assert.equal(errors.mock.callCount(), 1);
    assert.ok(String(errors.mock.calls[0].arguments.join(" ")).includes(broken));
  });

  it("never reads more than 20 notes, even when every one is unreadable", { skip: !canChmod }, async (t) => {
    for (let i = 10; i < 40; i++) {
      const name = await writeSession(`2026-10-${i} 10:00`, "Broken");
      await fs.chmod(path.join(projectDir(), "development/devlog", name), 0o000);
    }
    const errors = t.mock.method(console, "error", () => {});
    const { meta } = await loadProjectContext(vaultPath, projectPath);
    assert.equal(meta.devlog, 0);
    assert.equal(errors.mock.callCount(), 20);
  });

  it("a note with no section is skipped without a stderr line", async (t) => {
    await write("development/devlog/2026-10-04 1000 Empty.md", "---\nsession: x\n---\n");
    await writeSession("2026-10-03 10:00", "Real");
    const errors = t.mock.method(console, "error", () => {});
    const { context } = await loadProjectContext(vaultPath, projectPath);
    assert.deepEqual(labels(context), ["2026-10-03 1000 Real"]);
    assert.equal(errors.mock.callCount(), 0);
  });
});

describe("loadProjectContext budgets", () => {
  it("index: Overview and Current Status come first, Key Links and Related are skipped, capped with a vault_read marker", async () => {
    await write("_index.md", "---\ntype: project-index\n---\n\n# Big\n\nPreamble text.\n\n"
      + "## Key Links\nKEYLINKS\n\n## Objectives\nOBJECTIVES\n\n## Current Status\nSTATUS\n\n## Overview\nOVERVIEW\n\n## Related\nRELATED\n\n## Archive\n" + filler("archive", 4000));
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const index = context.split("### Project Index\n")[1].split("\n\n### ")[0];

    assert.ok(index.startsWith("## Overview\nOVERVIEW\n\n## Current Status\nSTATUS\n\n# Big"), index.slice(0, 120));
    assert.ok(!index.includes("KEYLINKS") && !index.includes("RELATED"));
    assert.ok(index.indexOf("OBJECTIVES") < index.indexOf("## Archive"));
    assert.ok(index.length <= INDEX_BUDGET);
    assert.ok(index.endsWith("[truncated — vault_read 01-Projects/Big/_index.md]"));
  });

  it("an index that is one long paragraph keeps its text up to the budget, cut at a word boundary", async () => {
    await write("_index.md", "---\ntype: project\n---\n# Big\n\n## Overview\n" + "Long overview sentence. ".repeat(150) + "\n");
    const index = (await loadProjectContext(vaultPath, projectPath)).context.split("### Project Index\n")[1].split("\n\n### ")[0];
    const marker = "[truncated — vault_read 01-Projects/Big/_index.md]";
    assert.ok(index.length <= INDEX_BUDGET && index.endsWith("\n" + marker));
    const kept = index.slice(index.indexOf("\n") + 1, -(marker.length + 1));
    assert.ok(kept.length > INDEX_BUDGET * 0.8);
    assert.ok(("Long overview sentence. ".repeat(200)).startsWith(kept + " "), `cut mid-word: …${kept.slice(-30)}`);
  });

  const hugeBody = (label) => filler(label, 50_000);
  const totals = [
    {
      name: "a huge index",
      setup: async () => {
        await write("_index.md", "# Big\n\n## Overview\n" + hugeBody("index"));
        for (let i = 1; i <= 3; i++) await writeSession(`2026-10-0${i} 10:00`, "Work", [{ key: `2026-10-0${i} 10:00`, summary: hugeBody("s") }]);
      },
      count: 3,
    },
    {
      name: "ten 50 KB notes",
      setup: async () => {
        await write("_index.md", "# Big\n\n## Overview\nShort.\n");
        for (let i = 10; i < 20; i++) await writeSession(`2026-10-${i} 10:00`, "Work", [{ key: `2026-10-${i} 10:00`, summary: hugeBody("s") }]);
      },
      count: 10,
      markers: true,
    },
    {
      name: "notes whose text has no newlines",
      setup: async () => {
        await write("_index.md", "# Big\n\n## Overview\n" + "word ".repeat(3000));
        for (let i = 10; i < 20; i++) {
          await writeSession(`2026-10-${i} 10:00`, "Work", [{ key: `2026-10-${i} 10:00`, summary: "x".repeat(50_000), next: "y".repeat(50_000) }]);
        }
      },
      count: 10,
    },
  ];
  for (const c of totals) {
    it(`the output never exceeds the context budget: ${c.name}`, async () => {
      await c.setup();
      const { context } = await loadProjectContext(vaultPath, projectPath);
      assert.ok(context.length <= CONTEXT_BUDGET, `${context.length} chars`);
      assert.equal(labels(context).length, c.count);
      if (c.markers) {
        for (const label of labels(context)) {
          assert.ok(context.includes(`[truncated — vault_read ${FOLDER}/${label}.md]`), label);
        }
      }
    });
  }

  for (const hugeIs of ["newest", "oldest"]) {
    it(`unused share passes on: one huge note (${hugeIs}) and nine small ones, which stay whole`, async () => {
      await write("_index.md", "# Big\n\n## Overview\nShort.\n");
      for (let i = 10; i < 20; i++) {
        const huge = hugeIs === "newest" ? i === 19 : i === 10;
        await writeSession(`2026-10-${i} 10:00`, "Work", [{ key: `2026-10-${i} 10:00`, summary: huge ? hugeBody("huge") : `SMALL-${i}\n${"filler text. ".repeat(20)}\nEND-${i}` }]);
      }
      const { context } = await loadProjectContext(vaultPath, projectPath);
      assert.ok(context.length <= CONTEXT_BUDGET);
      for (let i = 10; i < 20; i++) {
        if ((hugeIs === "newest" && i === 19) || (hugeIs === "oldest" && i === 10)) continue;
        assert.ok(context.includes(`END-${i}`), `note ${i} was cut`);
      }
      assert.ok(context.includes(`[truncated — vault_read ${FOLDER}/2026-10-${hugeIs === "newest" ? 19 : 10} 1000 Work.md]`));
      if (hugeIs === "oldest") assert.ok(context.length > CONTEXT_BUDGET - 1500, `only ${context.length} chars used; the huge note should take the rest`);
    });
  }

  it("unused share reaches a huge newest note: it takes all the room the nine small ones leave", async () => {
    await write("_index.md", "# Big\n\n## Overview\nShort.\n");
    for (let i = 10; i < 20; i++) {
      await writeSession(`2026-10-${i} 10:00`, "Work", [{ key: `2026-10-${i} 10:00`, summary: i === 19 ? hugeBody("huge") : `SMALL-${i}\nEND-${i}` }]);
    }
    const { context } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(context.length <= CONTEXT_BUDGET);
    assert.ok(context.length > CONTEXT_BUDGET - 300, `only ${context.length} chars used`);
    for (let i = 10; i < 19; i++) assert.ok(context.includes(`END-${i}`));
    assert.ok(context.includes(`[truncated — vault_read ${FOLDER}/2026-10-19 1000 Work.md]`));
  });

  it("a truncated legacy entry's marker names devlog.md", async () => {
    await write("_index.md", "# Big\n\n## Overview\nShort.\n");
    await write("development/devlog.md", legacyFile([legacyEntry("2026-10-08 10:00 — Long", hugeBody("legacy"))]));
    const { context } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(context.endsWith("[truncated — vault_read 01-Projects/Big/development/devlog.md]"), context.slice(-120));
    assert.ok(context.length <= CONTEXT_BUDGET);
  });

  it("source \"compact\" lists up to 10 labels under Recent sessions within COMPACT_BUDGET, without reading note bodies", async () => {
    await write("_index.md", "# Big\n\n## Overview\nINDEXBODY\n");
    for (let i = 10; i < 22; i++) await writeSession(`2026-10-${i} 10:00`, `Work ${"w".repeat(10)}`, [{ key: `2026-10-${i} 10:00`, summary: "NOTEBODY" }]);
    const { context, meta } = await loadProjectContext(vaultPath, projectPath, { source: "compact" });
    assert.ok(context.startsWith("## PKM Project Context: 01-Projects/Big (compact)\n### Recent sessions\n- 2026-10-21 1000 Work"), context);
    assert.equal(context.split("\n").filter(l => l.startsWith("- ")).length, 10);
    assert.ok(!context.includes("INDEXBODY") && !context.includes("NOTEBODY"));
    assert.ok(context.length <= COMPACT_BUDGET);
    assert.deepEqual([meta.source, meta.devlog, meta.index], ["compact", 10, false]);
  });

  it("source \"compact\" stays within COMPACT_BUDGET with long labels, and says when there is nothing", async () => {
    let result = await loadProjectContext(vaultPath, projectPath, { source: "compact" });
    assert.equal(result.context, "## PKM Project Context: 01-Projects/Big (compact)\n### Recent sessions\nNo devlog entries found.");
    await write("development/devlog.md", legacyFile(Array.from({ length: 10 }, (_, i) => legacyEntry(`2026-10-0${i % 9 + 1} 1${i}:00 — ${"L".repeat(300)}`))));
    result = await loadProjectContext(vaultPath, projectPath, { source: "compact" });
    assert.ok(result.context.length <= COMPACT_BUDGET, `${result.context.length}`);
  });

  it("3,000 session notes and a 2 MB legacy devlog load in under 1 s, reading only the newest notes", async (t) => {
    await write("_index.md", "# Big\n\n## Overview\nShort.\n");
    const dir = path.join(projectDir(), "development", "devlog");
    await fs.mkdir(dir, { recursive: true });
    const old = [];
    for (let i = 0; i < 3000; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const hhmm = String(Math.floor(i / 28)).padStart(4, "0").replace(/^(\d\d)(\d\d)$/, (_, a, b) => `${String(Number(a) % 24).padStart(2, "0")}${String(Number(b) % 60).padStart(2, "0")}`);
      old.push(`2025-01-${day} ${hhmm} Note ${i}.md`);
    }
    // Older notes are unreadable where chmod works, so any read of one shows up on stderr.
    await Promise.all([...new Set(old)].map(n => fs.writeFile(path.join(dir, n), "x", { mode: canChmod ? 0o000 : 0o644 })));
    for (let i = 10; i < 20; i++) await writeSession(`2026-10-${i} 10:00`, "Recent");
    const entries = Array.from({ length: 700 }, (_, i) => legacyEntry(`2024-01-01 10:${String(i % 60).padStart(2, "0")} — Old ${i}`, filler(`l${i}`, 3300)));
    const legacy = legacyFile(entries);
    assert.ok(legacy.length > 2_000_000, `${legacy.length}`);
    await write("development/devlog.md", legacy);

    const errors = t.mock.method(console, "error", () => {});
    const t0 = performance.now();
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const elapsed = performance.now() - t0;
    assert.equal(labels(context).length, 10);
    assert.ok(labels(context).every(l => l.endsWith("Recent")));
    assert.equal(errors.mock.callCount(), 0);
    assert.ok(context.length <= CONTEXT_BUDGET);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });

  const degenerate = [
    { name: "empty _index.md", files: { "_index.md": "" }, includes: "### Project Index\n(empty)" },
    { name: "_index.md with empty frontmatter only", files: { "_index.md": "---\n---\n" }, includes: "### Project Index\n(empty)" },
    { name: "an empty devlog.md", files: { "development/devlog.md": "" }, includes: "No devlog entries found." },
  ];
  for (const c of degenerate) {
    it(`does not throw on ${c.name}`, async () => {
      for (const [rel, content] of Object.entries(c.files)) await write(rel, content);
      const { context } = await loadProjectContext(vaultPath, projectPath);
      assert.ok(context.includes(c.includes), context);
    });
  }
});
