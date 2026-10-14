import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { performance } from "node:perf_hooks";
import {
  loadProjectContext,
  selectRecentEntries,
  CONTEXT_BUDGET,
  INDEX_BUDGET,
  ENTRY_BUDGET,
  MAX_TASKS,
  COMPACT_BUDGET,
} from "../hooks/load-context.js";

describe("loadProjectContext", () => {
  let tmpDir;
  let vaultPath;
  const projectPath = "01-Projects/MyApp";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-ctx-"));
    vaultPath = path.join(tmpDir, "vault");
    const projectDir = path.join(vaultPath, projectPath);
    await fs.mkdir(path.join(projectDir, "development"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });

    await fs.writeFile(
      path.join(projectDir, "_index.md"),
      "---\ntype: project\nstatus: active\ncreated: 2026-01-01\ntags: [project]\n---\n\n# MyApp\n\nA test project."
    );

    await fs.writeFile(
      path.join(projectDir, "development", "devlog.md"),
      "---\ntype: devlog\ncreated: 2026-01-01\ntags: [devlog]\n---\n\n# Development Log\n\n## Sessions\n\n### 2026-01-01 09:00\nOld entry.\n\n### 2026-02-01 10:00\nMiddle entry.\n\n### 2026-03-01 14:00\nRecent entry.\n\n### 2026-03-15 11:00\nLatest entry.\n"
    );

    await fs.writeFile(
      path.join(projectDir, "tasks", "add-auth.md"),
      "---\ntype: task\nstatus: active\npriority: high\ncreated: 2026-03-10\ntags: [task]\n---\n\n# Add Authentication\n\nImplement OAuth2 flow.\nSecond line of description."
    );

    await fs.writeFile(
      path.join(projectDir, "tasks", "setup-ci.md"),
      "---\ntype: task\nstatus: done\npriority: normal\ncreated: 2026-02-01\ntags: [task]\n---\n\n# Setup CI\n\nDone."
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads full project context", async () => {
    const { context: ctx, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(ctx.includes("## PKM Project Context: MyApp"));
    assert.ok(ctx.includes("A test project."));
    assert.ok(ctx.includes("Latest entry."));
    assert.ok(ctx.includes("Add Authentication"));
    assert.ok(ctx.includes("high"));
    assert.ok(!ctx.includes("Setup CI"));
    assert.equal(meta.index, true);
    assert.equal(meta.devlog, true);
    assert.equal(meta.tasks, 1);
  });

  it("returns last 3 devlog sections", async () => {
    const { context: ctx } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(!ctx.includes("Old entry."));
    assert.ok(ctx.includes("Middle entry."));
    assert.ok(ctx.includes("Recent entry."));
    assert.ok(ctx.includes("Latest entry."));
  });

  it("handles missing _index.md gracefully", async () => {
    await fs.rm(path.join(vaultPath, projectPath, "_index.md"));
    const { context: ctx, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(ctx.includes("## PKM Project Context: MyApp"));
    assert.ok(ctx.includes("Latest entry."));
    assert.equal(meta.index, false);
  });

  it("handles missing devlog gracefully", async () => {
    await fs.rm(path.join(vaultPath, projectPath, "development", "devlog.md"));
    const { context: ctx, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(ctx.includes("A test project."));
    assert.equal(meta.devlog, false);
  });

  it("shows 'No active tasks' when none exist", async () => {
    await fs.rm(path.join(vaultPath, projectPath, "tasks"), { recursive: true });
    const { context: ctx, meta } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(ctx.includes("No active tasks"));
    assert.equal(meta.tasks, 0);
  });

  it("returns last 3 devlog sections for old h2-date format", async () => {
    const projectDir = path.join(vaultPath, projectPath);
    await fs.writeFile(
      path.join(projectDir, "development", "devlog.md"),
      "---\ntype: devlog\ncreated: 2026-01-01\ntags: [devlog]\n---\n\n# Devlog\n\n## 2026-01-01\nOld entry.\n\n## 2026-02-01\nMiddle entry.\n\n## 2026-03-01\nRecent entry.\n\n## 2026-03-15\nLatest entry.\n"
    );
    const { context: ctx } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(!ctx.includes("Old entry."));
    assert.ok(ctx.includes("Middle entry."));
    assert.ok(ctx.includes("Recent entry."));
    assert.ok(ctx.includes("Latest entry."));
  });

  it("handles devlog with ## Sessions but no entries", async () => {
    const projectDir = path.join(vaultPath, projectPath);
    await fs.writeFile(
      path.join(projectDir, "development", "devlog.md"),
      "---\ntype: devlog\ncreated: 2026-01-01\ntags: [devlog]\n---\n\n# Development Log\n\n## Sessions\n"
    );
    const { context: ctx } = await loadProjectContext(vaultPath, projectPath);
    assert.ok(ctx.includes("### Recent Development Activity\nNo devlog entries found."));
  });

  it("hybrid devlog: ### entries under ## Sessions and dated ## entries elsewhere, newest first", async () => {
    const projectDir = path.join(vaultPath, projectPath);
    await fs.writeFile(
      path.join(projectDir, "development", "devlog.md"),
      "---\ntype: devlog\ncreated: 2026-01-01\ntags: [devlog]\n---\n\n# Development Log\n\n## 2026-01-01\nLegacy entry.\n\n## Sessions\n\n### 2026-03-01 14:00\nNew entry one.\n\n### 2026-03-15 11:00\nNew entry two.\n"
    );
    const { context: ctx } = await loadProjectContext(vaultPath, projectPath);
    const two = ctx.indexOf("New entry two.");
    const one = ctx.indexOf("New entry one.");
    const legacy = ctx.indexOf("Legacy entry.");
    assert.ok(two !== -1 && one !== -1 && legacy !== -1);
    assert.ok(two < one && one < legacy, "newest first");
  });

  it("handles task file without frontmatter gracefully", async () => {
    const projectDir = path.join(vaultPath, projectPath);
    await fs.writeFile(
      path.join(projectDir, "tasks", "no-frontmatter.md"),
      "# Some Task\n\nNo frontmatter here."
    );
    const { context: ctx } = await loadProjectContext(vaultPath, projectPath);
    // Should not crash, and should still include the auth task
    assert.ok(ctx.includes("Add Authentication"));
    // The no-frontmatter task should be skipped (extractFrontmatter returns null, so fm.status check fails)
    assert.ok(!ctx.includes("Some Task"));
  });
});

// ---------------------------------------------------------------------------
// Devlog entry selection
// ---------------------------------------------------------------------------
const FM = "---\ntype: devlog\ncreated: 2026-01-01\ntags: [devlog]\n---\n\n";

function sessionEntry(heading, body = "Did things.") {
  return `### ${heading}\n\n#### Session Summary\n- ${body}\n\n#### Next Steps\n- More.\n\n`;
}

describe("selectRecentEntries", () => {
  const shapes = [
    {
      name: "## Sessions + ### date time — Title, newest first",
      content: FM + "# Development Log\n\n## Sessions\n" + [
        "2026-10-08 11:01 — Prod API slow", "2026-10-07 09:30 — Review", "2026-10-03 16:00 — Plan", "2026-09-30 10:00 — Old",
      ].map(h => sessionEntry(h)).join(""),
      expected: ["### 2026-10-08 11:01 — Prod API slow", "### 2026-10-07 09:30 — Review", "### 2026-10-03 16:00 — Plan"],
    },
    {
      name: "## Sessions appended oldest first",
      content: FM + "## Sessions\n" + [
        "2026-09-30 10:00", "2026-10-03 16:00", "2026-10-07 09:30", "2026-10-08 11:01",
      ].map(h => sessionEntry(h)).join(""),
      expected: ["### 2026-10-08 11:01", "### 2026-10-07 09:30", "### 2026-10-03 16:00"],
    },
    {
      name: "day/title scheme (## day + ### day Title)",
      content: FM + "# Development Log\n\n"
        + "## 2026-10-08\n\n### 2026-10-08 Prod API slow\n\nScaling policy.\n\n"
        + "## 2026-09-03\n\n### 2026-09-03 11:01 — Field picker\n\nInvariants.\n\n### 2026-09-03 09:00 — Morning\n\nEarly.\n\n"
        + "## 2026-08-25\n\n### 2026-08-25 12:30 — Walk rebuild\n\nRefactor.\n",
      expected: ["### 2026-10-08 Prod API slow", "### 2026-09-03 11:01 — Field picker", "### 2026-09-03 09:00 — Morning"],
    },
    {
      name: "newest-first file with the newest entry appended at EOF",
      content: FM + "## Sessions\n" + [
        "2026-10-07 09:30", "2026-10-03 16:00", "2026-09-30 10:00", "2026-10-09 08:00",
      ].map(h => sessionEntry(h)).join(""),
      expected: ["### 2026-10-09 08:00", "### 2026-10-07 09:30", "### 2026-10-03 16:00"],
    },
    {
      name: "real Scope hybrid (undated day sections on top, ## Sessions blocks, day appended at EOF)",
      content: FM + "# Development Log\n\n"
        + "## 2026-10-13\n\n**AgentCore harness:** ran one agent.\n\n#### Open\n- Merge stack.\n\n"
        + "## 2026-10-12\n\n### 2026-10-12 Collapsed sidebar\n\nAlignment fix.\n\n"
        + "<!-- New entries are added above this line -->\n\n## Sessions\n" + sessionEntry("2026-10-12 13:50") + sessionEntry("2026-09-08 14:45")
        + "## 2026-10-01\n\nLate append.\n",
      expected: ["## 2026-10-13", "### 2026-10-12 13:50", "### 2026-10-12 Collapsed sidebar"],
    },
    {
      name: "same date: timed entries before untimed, later in file first on ties",
      content: FM + "## Sessions\n" + ["2026-10-12", "2026-10-12 13:50", "2026-10-12 09:00", "2026-10-12"].map((h, i) => sessionEntry(h, `entry ${i}`)).join(""),
      expected: ["### 2026-10-12 13:50", "### 2026-10-12 09:00", "### 2026-10-12"],
      firstBodyOfThird: "entry 3",
    },
    {
      name: "a dated heading inside a fenced code block is not an entry",
      content: FM + "## Sessions\n" + sessionEntry("2026-10-01 10:00") + "```md\n### 2026-12-31 Fake\n```\n\n" + sessionEntry("2026-09-01 10:00"),
      expected: ["### 2026-10-01 10:00", "### 2026-09-01 10:00"],
    },
  ];
  for (const c of shapes) {
    it(`returns the newest entries by date, newest first: ${c.name}`, () => {
      const entries = selectRecentEntries(c.content);
      assert.deepEqual(entries.map(e => e.split("\n")[0]), c.expected);
      if (c.firstBodyOfThird) assert.ok(entries[2].includes(c.firstBodyOfThird));
    });
  }

  it("an entry runs from its heading to the next heading of the same or higher level", () => {
    const content = FM + "## Sessions\n" + sessionEntry("2026-10-08 11:01 — A", "first") + sessionEntry("2026-10-07 10:00 — B", "second");
    const [newest] = selectRecentEntries(content, 1);
    assert.ok(newest.startsWith("### 2026-10-08 11:01 — A"));
    assert.ok(newest.includes("#### Session Summary") && newest.includes("first"));
    assert.ok(!newest.includes("second"));
  });

  const fallbacks = [
    {
      name: "first 3 under ## Sessions when no heading has a date",
      content: FM + "## Sessions\n" + ["Newest", "Second", "Third", "Oldest"].map(h => sessionEntry(h)).join(""),
      expected: ["### Newest", "### Second", "### Third"],
    },
    {
      name: "last 3 level-2 sections, last first, without ## Sessions",
      content: FM + "## Alpha\nA\n## Beta\nB\n## Gamma\nC\n## Delta\nD\n",
      expected: ["## Delta", "## Gamma", "## Beta"],
    },
    { name: "nothing when ## Sessions has no entries", content: FM + "# Development Log\n\n## Sessions\n", expected: [] },
  ];
  for (const c of fallbacks) {
    it(`falls back without parseable dates: ${c.name}`, () => {
      assert.deepEqual(selectRecentEntries(c.content).map(e => e.split("\n")[0]), c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
describe("loadProjectContext budgets", () => {
  let vaultPath;
  const projectPath = "01-Projects/Big";
  const projectDir = () => path.join(vaultPath, projectPath);

  async function write(rel, content) {
    await fs.mkdir(path.dirname(path.join(projectDir(), rel)), { recursive: true });
    await fs.writeFile(path.join(projectDir(), rel), content);
  }

  const filler = (label, chars) => Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `${label} line ${String(i).padStart(4, "0")} ....................`).join("\n");

  function task(title, status, priority, due = "null") {
    return `---\ntype: task\nstatus: ${status}\npriority: ${priority}\ndue: ${due}\ntags: [task]\n---\n\n# ${title}\n\nDescription line that is not shown.\n`;
  }

  beforeEach(async () => {
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-budget-"));
    await fs.mkdir(projectDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { recursive: true, force: true });
  });

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

  it("devlog entries are capped at ENTRY_BUDGET each with a vault_read marker", async () => {
    await write("development/devlog.md", FM + "## Sessions\n" + sessionEntry("2026-10-08 11:01", filler("long", 3000)) + sessionEntry("2026-10-07 10:00", "short"));
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const devlog = context.split("### Recent Development Activity\n")[1].split("\n\n### Active Tasks")[0];
    const [first, second] = devlog.split("\n\n### 2026-10-07");

    assert.ok(first.length <= ENTRY_BUDGET);
    assert.ok(first.endsWith("[truncated — vault_read 01-Projects/Big/development/devlog.md]"));
    assert.ok(second.includes("short"));
  });

  it("tasks: active before pending, then priority, then due; titles only, at most MAX_TASKS, then +N more", async () => {
    const specs = [
      ["P low", "pending", "low"], ["P urgent", "pending", "urgent"], ["A normal late", "active", "normal", "2026-12-01"],
      ["A normal early", "active", "normal", "2026-11-01"], ["A normal undated", "active", "normal"], ["A high", "active", "high"],
      ["P high", "pending", "high"], ["P normal 1", "pending", "normal"], ["P normal 2", "pending", "normal"],
      ["P normal 3", "pending", "normal"], ["P normal 4", "pending", "normal"], ["P normal 5", "pending", "normal"],
      ["P normal 6", "pending", "normal"], ["Done one", "done", "urgent"],
    ];
    for (const [title, status, priority, due] of specs) {
      await write(`tasks/${title.toLowerCase().replace(/ /g, "-")}.md`, task(title, status, priority, due));
    }
    const { context, meta } = await loadProjectContext(vaultPath, projectPath);
    const lines = context.split("### Active Tasks\n")[1].split("\n");

    assert.deepEqual(lines.slice(0, MAX_TASKS).map(l => l.replace(/ \(status.*$/, "")), [
      "- A high", "- A normal early", "- A normal late", "- A normal undated",
      "- P urgent", "- P high", "- P normal 1", "- P normal 2", "- P normal 3", "- P normal 4",
    ]);
    assert.equal(lines[0], "- A high (status: active, priority: high)");
    assert.equal(lines[MAX_TASKS], "+3 more (vault_query type: \"task\", folder: \"01-Projects/Big/tasks\")");
    assert.ok(!context.includes("Done one") && !context.includes("Description line"));
    assert.equal(meta.tasks, 13);
  });

  it("total context is hard-capped at CONTEXT_BUDGET, trimming the devlog before the index", async () => {
    await write("_index.md", "# Big\n\n## Overview\n" + filler("index", 4000));
    await write("development/devlog.md", FM + "## Sessions\n" + ["2026-10-08 11:01", "2026-10-07 10:00", "2026-10-06 10:00"].map(h => sessionEntry(h, filler("dev", 3000))).join(""));
    for (let i = 0; i < 10; i++) await write(`tasks/t${i}.md`, task(`Task ${i} ${"x".repeat(140)}`, "active", "normal"));

    const { context } = await loadProjectContext(vaultPath, projectPath);
    const index = context.split("### Project Index\n")[1].split("\n\n### Recent Development Activity")[0];
    const devlog = context.split("### Recent Development Activity\n")[1].split("\n\n### Active Tasks")[0];

    assert.ok(context.length <= CONTEXT_BUDGET, `context is ${context.length} chars`);
    assert.ok(index.length > INDEX_BUDGET - 100, "the index keeps its own budget");
    assert.ok(devlog.endsWith("[truncated — vault_read 01-Projects/Big/development/devlog.md]"));
    assert.ok(context.includes("- Task 9"), "tasks are never trimmed");
  });

  it("source \"compact\" returns only the project path and task titles within COMPACT_BUDGET", async () => {
    await write("_index.md", "# Big\n\n## Overview\nINDEXBODY\n");
    await write("development/devlog.md", FM + "## Sessions\n" + sessionEntry("2026-10-08 11:01", "DEVLOGBODY"));
    for (let i = 0; i < 12; i++) await write(`tasks/t${String(i).padStart(2, "0")}.md`, task(`Task ${i} ${"y".repeat(140)}`, "pending", "normal"));

    const { context, meta } = await loadProjectContext(vaultPath, projectPath, { source: "compact" });

    assert.ok(context.startsWith("## PKM Project Context: Big (compact)\nProject: 01-Projects/Big\n### Active Tasks\n- Task 0 "));
    assert.ok(!context.includes("INDEXBODY") && !context.includes("DEVLOGBODY") && !context.includes("status:"));
    assert.ok(context.length <= COMPACT_BUDGET, `compact context is ${context.length} chars`);
    assert.equal(meta.source, "compact");
  });

  it("a 2 MB devlog with 700 newest-first entries yields the 3 newest within budget in under 200 ms", async () => {
    const start = Date.parse("2026-10-13T23:00:00Z");
    const entries = [];
    for (let i = 0; i < 700; i++) {
      const d = new Date(start - i * 6 * 3600 * 1000).toISOString();
      entries.push(sessionEntry(`${d.slice(0, 10)} ${d.slice(11, 16)} — Session ${i}`, filler(`s${i}`, 3200)));
    }
    const devlog = FM + "# Development Log\n\n## Sessions\n" + entries.join("");
    assert.ok(devlog.length > 2_000_000, `devlog is ${devlog.length} chars`);
    await write("development/devlog.md", devlog);
    await write("_index.md", "# Big\n\n## Overview\nShort.\n");

    const t0 = performance.now();
    const { context } = await loadProjectContext(vaultPath, projectPath);
    const elapsed = performance.now() - t0;

    const headings = context.split("\n").filter(l => l.startsWith("### 20"));
    assert.deepEqual(headings.map(h => h.replace(/ \d\d:\d\d — /, " — ")), [
      "### 2026-10-13 — Session 0", "### 2026-10-13 — Session 1", "### 2026-10-13 — Session 2",
    ]);
    assert.ok(context.length <= CONTEXT_BUDGET);
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  });

  const degenerate = [
    { name: "empty devlog", files: { "development/devlog.md": "" }, includes: "No devlog entries found." },
    { name: "devlog without frontmatter", files: { "development/devlog.md": "## Sessions\n### 2026-10-08 10:00\nBody.\n" }, includes: "### 2026-10-08 10:00" },
    { name: "empty _index.md", files: { "_index.md": "" }, includes: "### Project Index\n(empty)" },
    { name: "_index.md with empty frontmatter only", files: { "_index.md": "---\n---\n" }, includes: "### Project Index\n(empty)" },
    { name: "empty task file", files: { "tasks/empty.md": "" }, includes: "No active tasks" },
    { name: "task with empty frontmatter", files: { "tasks/blank.md": "---\n---\n# Blank\n" }, includes: "No active tasks" },
  ];
  for (const c of degenerate) {
    it(`does not throw on ${c.name}`, async () => {
      for (const [rel, content] of Object.entries(c.files)) await write(rel, content);
      const { context } = await loadProjectContext(vaultPath, projectPath);
      assert.ok(context.includes(c.includes), context);
    });
  }
});
