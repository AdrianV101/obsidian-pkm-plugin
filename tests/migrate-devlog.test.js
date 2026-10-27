import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { runMigrateDevlog } from "../migrate-devlog.js";

const ROOT = path.join(import.meta.dirname, "..");
const P = "My Project";
const PROJECT = `01-Projects/${P}`;
const DEVLOG = `${PROJECT}/development/devlog.md`;
const FOLDER = `${PROJECT}/development/devlog`;
const TRASH = `.trash/${DEVLOG}`;
const USAGE = "Usage: obsidian-pkm [init | doctor | migrate-devlog <project> [--apply]]";
const PREVIEW_END = "Preview only; nothing was written. Run with --apply to migrate.";
const KEPT_HEADING = "## Kept from the old devlog";
// 09:14:05.123Z, so the timestamped trash name is fixed whatever the local zone.
const NOW = new Date(Date.UTC(2026, 9, 27, 9, 14, 5, 123));

const FM = "---\ntype: devlog\nproject: My Project\ncreated: 2026-01-01\ntags:\n  - devlog\n---\n";

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A devlog assembled from labelled pieces, so a test knows each piece's role
 * (frontmatter, scaffolding, entry of a date, kept text) without the parser.
 */
function devlog(pieces, eol = "\n") {
  const parts = pieces.map(([kind, text, date]) => ({ kind, text: text.replaceAll("\n", eol), date }));
  const firstEntry = parts.findIndex((p) => p.kind === "entry");
  return {
    content: parts.map((p) => p.text).join(""),
    frontmatter: parts.find((p) => p.kind === "fm")?.text ?? null,
    entries: parts.filter((p) => p.kind === "entry"),
    kept: parts.filter((p) => p.kind === "kept").map((p) => p.text),
    beforeEntries: parts.slice(0, firstEntry).map((p) => p.text).join(""),
    entriesOnlyAfterFirst: parts.slice(firstEntry).every((p) => p.kind === "entry"),
    eol,
  };
}

const MIXED = [
  ["fm", FM],
  ["scaffold", "\n# Development Log\n\nThis log tracks development progress, decisions made, and lessons learned.\n\n"],
  ["kept", "> Older history lives in the wiki.\n"],
  ["scaffold", "\n## Sessions\n\n"],
  ["entry", "### 2026-10-04 16:20 Ship the parser\n- did things\n\n```text\n### 2026-01-01 not an entry (inside a fence)\n```\n\n---\n\n", "2026-10-04"],
  ["entry", "### 2026-10-04 09:05 Morning fixes\n- more\n\n", "2026-10-04"],
  ["scaffold", "## Sessions\n\n"],
  ["entry", "## 2026-10-03\n\n### 14:32 Undated child\n- child body\n\n", "2026-10-03"],
  ["entry", "## 2026-10-03: Big refactor\nBody of the dated h2.\n\n", "2026-10-03"],
  ["entry", "## 2026-10-02\n\n", "2026-10-02"],
  ["entry", "## 2026-10-01: First day\n- start\n\n", "2026-10-01"],
  ["entry", "### 2026-10-04 07:00 Late addition\n- appended out of order\n\n", "2026-10-04"],
  ["kept", "## Related\n- [[Other note]]\n"],
];

function dayHeader(date, eol = "\n", projectValue = P) {
  return ["---", "type: devlog-day", `project: ${projectValue}`, `created: ${date}`, "tags:", "  - devlog", "---", "", ""].join(eol);
}

/** Expected day notes: vault path -> content, one per date, entries in file order. */
function expectedDayNotes(fx, { project = P, folder = FOLDER, projectValue = project } = {}) {
  const bodies = new Map();
  for (const e of fx.entries) bodies.set(e.date, (bodies.get(e.date) ?? "") + e.text);
  return new Map(
    [...bodies].map(([date, body]) => [`${folder}/${date} ${project} devlog.md`, dayHeader(date, fx.eol, projectValue) + body]),
  );
}

async function templateBody(folder, eol) {
  const raw = (await fs.readFile(path.join(ROOT, "templates", "devlog.md"), "utf-8")).replace(/\r\n/g, "\n");
  const close = raw.indexOf("\n---\n", 3);
  return raw.slice(close + 5).replaceAll("<% devlog_folder %>", folder).replaceAll("\n", eol);
}

function freshFrontmatter(eol, projectValue = P) {
  return ["---", "type: devlog", `project: ${projectValue}`, `created: ${localDate(NOW)}`, "tags:", "  - devlog", "---", ""].join(eol);
}

async function expectedHub(fx, folder = FOLDER) {
  let hub = (fx.frontmatter ?? freshFrontmatter(fx.eol)) + (await templateBody(folder, fx.eol));
  if (fx.kept.length > 0) hub += fx.eol + KEPT_HEADING + fx.eol + fx.eol + fx.kept.join(fx.eol);
  return hub;
}

async function makeVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pkm-migrate-"));
}

async function put(vault, rel, content) {
  const abs = path.join(vault, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function read(vault, rel, encoding = "utf-8") {
  return fs.readFile(path.join(vault, ...rel.split("/")), encoding);
}

async function exists(vault, rel) {
  try {
    await fs.lstat(path.join(vault, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

/** Every file (base64) and folder (null, key ending in "/") under `root`. */
async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (ent.isDirectory()) {
        out[`${rel}/`] = null;
        await walk(abs);
      } else {
        out[rel] = (await fs.readFile(abs)).toString("base64");
      }
    }
  }
  await walk(root);
  return out;
}

async function filesIn(vault, rel) {
  try {
    return (await fs.readdir(path.join(vault, ...rel.split("/")))).sort();
  } catch {
    return [];
  }
}

async function run(args, { vault, env, now = NOW, checkpoint } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runMigrateDevlog(args, {
    env: env ?? { VAULT_PATH: vault },
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    now,
    checkpoint,
  });
  return { code, stdout, stderr };
}

const codePoints = (s) => [...s].length;
const lineOf = (content, text) => content.slice(0, content.indexOf(text)).split("\n").length;

/** Asserts the full lossless outcome of an apply: day notes, the trashed original and the hub. */
async function assertMigrated(vault, fx, { trash = TRASH } = {}) {
  const notes = expectedDayNotes(fx);
  assert.deepEqual(await filesIn(vault, FOLDER), [...notes.keys()].map((p) => p.slice(FOLDER.length + 1)).sort());
  for (const [rel, content] of notes) assert.equal(await read(vault, rel), content, rel);
  assert.ok((await read(vault, trash, null)).equals(Buffer.from(fx.content)), "the trashed original is byte-identical");
  assert.equal(await read(vault, DEVLOG), await expectedHub(fx));
  return notes;
}

describe("migrate-devlog", () => {
  let vault;

  beforeEach(async () => {
    vault = await makeVault();
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  describe("preview", () => {
    it("writes nothing and reports entries per style, day notes, range, largest, kept text, blockers and the closing line", async () => {
      const fx = devlog(MIXED);
      const notes = expectedDayNotes(fx);
      const sizes = [...notes].map(([rel, c]) => ({ name: rel.slice(FOLDER.length + 1), bytes: Buffer.byteLength(c) }));
      const largest = sizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
      assert.equal(sizes.filter((s) => s.bytes === largest.bytes).length, 1, "fixture has one largest note");
      const keptChars = fx.kept.reduce((n, k) => n + codePoints(k), 0);
      const report = [
        `Devlog: ${DEVLOG}`,
        "Entries: 7 (### dated: 3, ## day sections: 2, ## dated: 2)",
        `Day notes: 4 in ${FOLDER}, 2026-10-01 to 2026-10-04; largest ${largest.name} (${largest.bytes} bytes)`,
        `Kept text: 2 blocks, ${keptChars} characters, starting at lines 13, ${lineOf(fx.content, "## Related")}`,
      ];

      const cases = [
        { name: "no blocker", existing: [], code: 0, blockers: [] },
        {
          name: "a day note already exists",
          existing: [`${FOLDER}/2026-10-02 ${P} devlog.md`],
          code: 1,
          blockers: [`Blocker: ${FOLDER}/2026-10-02 ${P} devlog.md already exists`],
        },
      ];
      for (const c of cases) {
        const v = await makeVault();
        try {
          await put(v, DEVLOG, fx.content);
          for (const rel of c.existing) await put(v, rel, "someone else's note\n");
          const before = await snapshot(v);
          const result = await run([P], { vault: v });
          assert.equal(result.code, c.code, c.name);
          assert.equal(result.stdout, [...report, ...c.blockers, PREVIEW_END].join("\n") + "\n", c.name);
          assert.deepEqual(await snapshot(v), before, `${c.name}: nothing written`);
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });
  });

  describe("apply", () => {
    it("writes the day notes, trashes the original and writes the hub with the kept text", async () => {
      const fx = devlog(MIXED);
      await put(vault, DEVLOG, fx.content);
      const result = await run([P, "--apply"], { vault });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        [`Wrote 4 day notes to ${FOLDER}`, `Moved the old devlog to ${TRASH}`, `Wrote the hub at ${DEVLOG}`].join("\n") + "\n",
      );
      const notes = await assertMigrated(vault, fx);
      assert.deepEqual(
        [...notes.keys()].sort(),
        ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((d) => `${FOLDER}/${d} My Project devlog.md`),
      );

      const hub = await read(vault, DEVLOG);
      assert.ok(hub.startsWith(FM + "\n# Development Log\n\nEach session has its own note in the devlog folder next to this one; the table lists them newest first.\n\n```base\n"));
      assert.ok(hub.includes(`file.inFolder("${FOLDER}")`));
      assert.doesNotMatch(hub, /<%/);
      assert.ok(hub.endsWith(`\n\n${KEPT_HEADING}\n\n> Older history lives in the wiki.\n\n## Related\n- [[Other note]]\n`));

      const all = Object.keys(await snapshot(vault)).filter((k) => !k.endsWith("/")).sort();
      assert.deepEqual(all, [DEVLOG, TRASH, ...notes.keys()].sort(), "no other files written");
    });

    it("quotes a project value that YAML would not read back as the same plain string", async () => {
      const cases = [
        ["Scope", "Scope"],
        ["Café Notes", "Café Notes"],
        ["v2.0_beta-x", "v2.0_beta-x"],
        ["C# & F#", '"C# & F#"'],
        ["Notes [old]", '"Notes [old]"'],
        ["true", '"true"'],
        ["2026", '"2026"'],
      ];
      for (const [name, value] of cases) {
        const v = await makeVault();
        try {
          const project = `01-Projects/${name}`;
          await put(v, `${project}/development/devlog.md`, "## 2026-10-05: Only\n- x\n");
          const result = await run([name, "--apply"], { vault: v });
          assert.equal(result.code, 0, `${name}: ${result.stderr}`);
          assert.equal(
            await read(v, `${project}/development/devlog/2026-10-05 ${name} devlog.md`),
            dayHeader("2026-10-05", "\n", value) + "## 2026-10-05: Only\n- x\n",
            name,
          );
          assert.ok((await read(v, `${project}/development/devlog.md`)).startsWith(freshFrontmatter("\n", value)), name);
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });

    it("loses no byte of any entry or kept text", async () => {
      const rows = [
        {
          name: "### dated entries, newest first",
          rebuild: true,
          fx: devlog([
            ["fm", FM],
            ["scaffold", "\n# Development Log\n\nThis log tracks development progress, decisions made, and lessons learned.\n\n## Sessions\n\n"],
            ["entry", "### 2026-10-05 10:00 Five\n- a\n\n", "2026-10-05"],
            ["entry", "### 2026-10-05 08:00 Five early\n- b\n\n---\n\n", "2026-10-05"],
            ["entry", "### 2026-10-03 12:00 Three\n- c\n", "2026-10-03"],
          ]),
        },
        {
          name: "## day sections with undated ### children",
          rebuild: true,
          fx: devlog([
            ["fm", FM],
            ["scaffold", "\n# Development Log\n\n"],
            ["entry", "## 2026-10-05\n\n### 10:00 Late\n- a\n\n### 08:00 Early\n- b\n\n", "2026-10-05"],
            ["entry", "## 2026-10-03\n\n### 12:00 Noon\n- c\n", "2026-10-03"],
          ]),
        },
        {
          name: "## dated entries without frontmatter",
          rebuild: true,
          fx: devlog([
            ["scaffold", "# Dotfiles Development Log\n"],
            ["entry", "## 2026-02-24 - Fix leak\n\n### Session Summary\n- x\n\n", "2026-02-24"],
            ["entry", "## 2026-02-20 - Older\n- y\n", "2026-02-20"],
          ]),
        },
        { name: "mixed styles, stray ## Sessions, kept text, fenced headings", rebuild: false, fx: devlog(MIXED) },
        { name: "mixed styles with CRLF", rebuild: false, fx: devlog(MIXED, "\r\n") },
        {
          name: "no final newline",
          rebuild: true,
          fx: devlog([
            ["fm", FM],
            ["scaffold", "\n## Sessions\n\n"],
            ["entry", "### 2026-10-05 10:00 A\n- a\n\n", "2026-10-05"],
            ["entry", "### 2026-10-04 09:00 B\n- b", "2026-10-04"],
          ]),
        },
        {
          name: "Unicode",
          rebuild: true,
          fx: devlog([
            ["fm", FM],
            ["scaffold", "\n## Sessions\n\n"],
            ["entry", "### 2026-10-05 10:00 Ünïcödé 🎉 release\n- 日本語のテキスト, e\u0301 and 👩‍💻\n\n", "2026-10-05"],
            ["entry", "### 2026-10-04 09:00 Ελληνικά — dash\n- 中文 🚀\n", "2026-10-04"],
          ]),
        },
        {
          name: "an entry holding a base block (not a hub)",
          rebuild: true,
          fx: devlog([
            ["fm", FM],
            ["scaffold", "\n## Sessions\n\n"],
            ["entry", "### 2026-10-05 10:00 Hub design\n```base\nfilters:\n  and: []\n```\n\n", "2026-10-05"],
            ["entry", "### 2026-10-04 09:00 B\n- b\n", "2026-10-04"],
          ]),
        },
        {
          name: "BOM before the frontmatter",
          rebuild: true,
          fx: devlog([
            ["scaffold", "\uFEFF"],
            ["fm", FM],
            ["scaffold", "\n## Sessions\n\n"],
            ["entry", "### 2026-10-05 10:00 A\n- a\n\n", "2026-10-05"],
            ["entry", "### 2026-10-04 09:00 B\n- b\n", "2026-10-04"],
          ]),
        },
      ];

      for (const { name, rebuild, fx } of rows) {
        const v = await makeVault();
        try {
          await put(v, DEVLOG, fx.content);
          const result = await run([P, "--apply"], { vault: v });
          assert.equal(result.code, 0, `${name}: ${result.stderr}`);
          const notes = await assertMigrated(v, fx);
          if (rebuild) {
            assert.ok(fx.entriesOnlyAfterFirst, `${name}: fixture is single-style`);
            const newestFirst = [...notes.keys()].sort().reverse();
            const joined = newestFirst.map((rel) => notes.get(rel).slice(dayHeader("0000-00-00", fx.eol).length)).join("");
            assert.equal(fx.beforeEntries + joined, fx.content, `${name}: rebuilt exactly from the day notes`);
          }
          if (fx.eol === "\r\n") {
            for (const rel of [...notes.keys(), DEVLOG]) assert.doesNotMatch(await read(v, rel), /[^\r]\n/, `${name}: ${rel} uses CRLF`);
          }
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });

    it("gives the trashed original a timestamped name when its trash path is taken", async () => {
      const fx = devlog(MIXED);
      await put(vault, DEVLOG, fx.content);
      await put(vault, TRASH, "an older trashed devlog\n");
      const stamped = `.trash/${PROJECT}/development/devlog.2026-10-27T09-14-05.md`;
      const result = await run([P, "--apply"], { vault });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`^Moved the old devlog to ${stamped.replace(/[.[\]]/g, "\\$&")}$`, "m"));
      await assertMigrated(vault, fx, { trash: stamped });
      assert.equal(await read(vault, TRASH), "an older trashed devlog\n");
    });
  });

  describe("blockers", () => {
    it("exit 1 and write nothing", async () => {
      const fx = devlog(MIXED);
      const cases = [
        {
          name: "a day note already exists",
          args: [P, "--apply"],
          setup: async (v) => {
            await put(v, DEVLOG, fx.content);
            await put(v, `${FOLDER}/2026-10-03 ${P} devlog.md`, "someone else's note\n");
          },
          blocker: `Blocker: ${FOLDER}/2026-10-03 ${P} devlog.md already exists`,
        },
        {
          name: "the project folder is missing",
          args: ["Ghost", "--apply"],
          setup: async (v) => put(v, DEVLOG, fx.content),
          blocker: "Blocker: project folder 01-Projects/Ghost does not exist",
        },
        {
          name: "the devlog is not valid UTF-8",
          args: [P, "--apply"],
          setup: async (v) => put(v, DEVLOG, Buffer.concat([Buffer.from("### 2026-10-05 10:00 A\n- "), Buffer.from([0xff, 0xfe]), Buffer.from("\n")])),
          blocker: `Blocker: ${DEVLOG} is not valid UTF-8, so its bytes could not be kept exactly`,
        },
      ];
      for (const c of cases) {
        const v = await makeVault();
        try {
          await c.setup(v);
          const before = await snapshot(v);
          const result = await run(c.args, { vault: v });
          assert.equal(result.code, 1, c.name);
          assert.ok(result.stdout.split("\n").includes(c.blocker), `${c.name}: ${result.stdout}`);
          assert.deepEqual(await snapshot(v), before, `${c.name}: nothing written`);
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });
  });

  describe("failure after the first write", () => {
    const appendTo = (v, rel, text) => fs.appendFile(path.join(v, ...rel.split("/")), text);

    it("restores the starting state and exits 1 with the reason", async () => {
      const fx = devlog(MIXED);
      const firstNote = `${FOLDER}/2026-10-01 ${P} devlog.md`;
      const cases = [
        {
          name: "a day note reads back differently",
          step: "read-back",
          act: (v) => appendTo(v, firstNote, "tampered\n"),
          reason: `${firstNote}: it does not match what was written`,
        },
        {
          name: "the source changes before the trash step",
          step: "source-check",
          act: (v) => appendTo(v, DEVLOG, "### 2026-10-27 09:00 Written meanwhile\n"),
          reason: `${DEVLOG}: it changed since it was read`,
          changedSource: fx.content + "### 2026-10-27 09:00 Written meanwhile\n",
        },
        {
          name: "the hub write fails",
          step: "hub-write",
          act: () => { throw new Error("disk full"); },
          reason: "disk full",
        },
        {
          name: "the hub write fails with the devlog folder already there",
          step: "hub-write",
          act: () => { throw new Error("disk full"); },
          reason: "disk full",
          setup: (v) => put(v, `${FOLDER}/2026-10-26 1500 Earlier session note.md`, "---\ntype: devlog-session\n---\n"),
        },
      ];
      for (const c of cases) {
        const v = await makeVault();
        try {
          await put(v, DEVLOG, fx.content);
          if (c.setup) await c.setup(v);
          const before = await snapshot(v);
          let reached = false;
          const result = await run([P, "--apply"], {
            vault: v,
            checkpoint: async (step) => {
              if (step !== c.step) return;
              reached = true;
              await c.act(v);
            },
          });
          assert.ok(reached, `${c.name}: checkpoint ${c.step} reached`);
          assert.equal(result.code, 1, c.name);
          assert.ok(result.stderr.includes(c.reason), `${c.name}: ${result.stderr}`);
          assert.match(result.stderr, /^Restored the starting state\.$/m, c.name);
          const expected = c.changedSource ? { ...before, [DEVLOG]: Buffer.from(c.changedSource).toString("base64") } : before;
          assert.deepEqual(await snapshot(v), expected, `${c.name}: vault as it was`);
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });

    it(
      "lists every file left behind when the restore itself fails",
      { skip: process.platform === "win32" || process.getuid?.() === 0 },
      async () => {
        const fx = devlog(MIXED);
        await put(vault, DEVLOG, fx.content);
        const folderAbs = path.join(vault, ...FOLDER.split("/"));
        try {
          const result = await run([P, "--apply"], {
            vault,
            checkpoint: async (step) => {
              if (step !== "hub-write") return;
              await fs.chmod(folderAbs, 0o555);
              throw new Error("disk full");
            },
          });
          assert.equal(result.code, 1);
          assert.ok(result.stderr.includes("disk full"), result.stderr);
          const left = [...expectedDayNotes(fx).keys(), `${FOLDER}/`];
          for (const rel of left) assert.match(result.stderr, new RegExp(`^- ${rel.replace(/[.[\]]/g, "\\$&")}$`, "m"), rel);
          assert.doesNotMatch(result.stderr, /^Restored the starting state\.$/m);
          assert.ok((await read(vault, DEVLOG, null)).equals(Buffer.from(fx.content)), "the original is back in place");
          assert.equal(await exists(vault, ".trash"), false);
        } finally {
          await fs.chmod(folderAbs, 0o755).catch(() => {});
        }
      },
    );
  });

  describe("nothing to migrate", () => {
    it("exits 0 and writes nothing", async () => {
      const hub = FM + (await templateBody(FOLDER, "\n"));
      const cases = [
        { name: "no devlog.md", content: null, message: `Nothing to migrate: ${DEVLOG} does not exist` },
        { name: "a hub without entries", content: hub, message: `Nothing to migrate: ${DEVLOG} is already a hub` },
        {
          name: "a CRLF hub without entries",
          content: hub.replaceAll("\n", "\r\n"),
          message: `Nothing to migrate: ${DEVLOG} is already a hub`,
        },
        {
          name: "a hub with kept text and no entries",
          content: `${hub}\n${KEPT_HEADING}\n\n> kept before\n`,
          message: `Nothing to migrate: ${DEVLOG} is already a hub`,
        },
      ];
      for (const c of cases) {
        for (const args of [[P], [P, "--apply"]]) {
          const v = await makeVault();
          try {
            await fs.mkdir(path.join(v, ...PROJECT.split("/"), "development"), { recursive: true });
            if (c.content !== null) await put(v, DEVLOG, c.content);
            const before = await snapshot(v);
            const result = await run(args, { vault: v });
            assert.equal(result.code, 0, `${c.name} ${args}`);
            assert.equal(result.stdout, `${c.message}\n`, `${c.name} ${args}`);
            assert.deepEqual(await snapshot(v), before, `${c.name} ${args}: nothing written`);
          } finally {
            await fs.rm(v, { recursive: true, force: true });
          }
        }
      }
    });

    it("migrates old-style entries written into a hub and keeps the hub's own text", async () => {
      const hubBody = await templateBody(FOLDER, "\n");
      const fx = devlog([
        ["fm", FM],
        ["hub", hubBody],
        ["hub", `\n${KEPT_HEADING}\n\n> kept before\n\n`],
        ["sessions", "## Sessions\n"],
        ["hub", "\n"],
        ["entry", "### 2026-11-02 10:00 Old plugin entry\n- x\n\n", "2026-11-02"],
        ["entry", "### 2026-11-01 09:00 Older\n- y\n", "2026-11-01"],
      ]);
      await put(vault, DEVLOG, fx.content);
      const result = await run([P, "--apply"], { vault });
      assert.equal(result.code, 0, result.stderr);
      for (const [rel, content] of expectedDayNotes(fx)) assert.equal(await read(vault, rel), content, rel);
      assert.equal(await read(vault, DEVLOG), `${FM}${hubBody}\n${KEPT_HEADING}\n\n> kept before\n\n\n`);
      assert.ok((await read(vault, TRASH, null)).equals(Buffer.from(fx.content)));
    });
  });

  describe("usage", () => {
    it("exits 2 with a message for bad arguments or an unset VAULT_PATH", async () => {
      await put(vault, DEVLOG, devlog(MIXED).content);
      const cases = [
        { args: [], usage: true },
        { args: ["--apply"], usage: true },
        { args: [P, "--force"], usage: true },
        { args: [P, "Other"], usage: true },
        { args: [P, "--apply", "--apply"], usage: true },
        { args: ["../outside"], usage: true },
        { args: ["01-Projects/../../outside"], usage: true },
        { args: ["/abs/path"], usage: true },
        { args: [P], env: {}, vaultMessage: true },
        { args: [P], env: { VAULT_PATH: "" }, vaultMessage: true },
        { args: [P], env: { VAULT_PATH: "${VAULT_PATH}" }, vaultMessage: true },
      ];
      const before = await snapshot(vault);
      for (const c of cases) {
        const label = `${JSON.stringify(c.args)} ${JSON.stringify(c.env ?? null)}`;
        const result = await run(c.args, { vault, env: c.env });
        assert.equal(result.code, 2, label);
        assert.equal(result.stdout, "", label);
        if (c.usage) assert.ok(result.stderr.split("\n").includes(USAGE), `${label}: ${result.stderr}`);
        if (c.vaultMessage) assert.match(result.stderr, /VAULT_PATH/, label);
      }
      assert.deepEqual(await snapshot(vault), before);
    });

    it("takes the project as a folder name under 01-Projects or as a vault-relative path", async () => {
      const content = "## 2026-10-05: Only\n- x\n";
      await put(vault, DEVLOG, content);
      await put(vault, "02-Areas/Home Lab/development/devlog.md", content);
      const cases = [
        { arg: P, devlog: DEVLOG, note: `${FOLDER}/2026-10-05 ${P} devlog.md` },
        { arg: PROJECT, devlog: DEVLOG, note: `${FOLDER}/2026-10-05 ${P} devlog.md` },
        { arg: `${PROJECT}/`, devlog: DEVLOG, note: `${FOLDER}/2026-10-05 ${P} devlog.md` },
        { arg: "02-Areas/Home Lab", devlog: "02-Areas/Home Lab/development/devlog.md", note: "02-Areas/Home Lab/development/devlog/2026-10-05 Home Lab devlog.md" },
      ];
      for (const c of cases) {
        const result = await run([c.arg], { vault });
        assert.equal(result.code, 0, `${c.arg}: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`^Devlog: ${c.devlog}$`, "m"), c.arg);
        const largest = c.note.slice(c.note.lastIndexOf("/") + 1);
        assert.ok(result.stdout.includes(`largest ${largest} (`), `${c.arg}: ${result.stdout}`);
      }
      const applied = await run(["02-Areas/Home Lab", "--apply"], { vault });
      assert.equal(applied.code, 0, applied.stderr);
      assert.equal(
        await read(vault, "02-Areas/Home Lab/development/devlog/2026-10-05 Home Lab devlog.md"),
        dayHeader("2026-10-05", "\n", "Home Lab") + content,
      );
    });
  });

  describe("project spelling", () => {
    /** Whether `dir`'s filesystem finds a name typed in another case, or in another Unicode form. */
    async function filesystemFolds(dir) {
      const probe = path.join(dir, "Probe\u00e9");
      await fs.writeFile(probe, "");
      try {
        const found = async (name) => fs.lstat(path.join(dir, name)).then(() => true, () => false);
        return { case: await found("pROBE\u00e9"), unicode: await found("Probee\u0301") };
      } finally {
        await fs.rm(probe);
      }
    }

    it("uses the project folder's name as it is on disk when the argument differs only in case or Unicode form", async (t) => {
      const folds = await filesystemFolds(vault);
      const nfd = "Cafe\u0301 Notes";
      const cases = [
        { onDisk: P, arg: "my project", needs: "case" },
        { onDisk: P, arg: "01-projects/MY PROJECT", needs: "case" },
        { onDisk: nfd, arg: nfd.normalize("NFC"), needs: "unicode" },
      ].filter((c) => folds[c.needs]);
      if (cases.length === 0) {
        t.skip("the filesystem tells these spellings apart");
        return;
      }
      for (const { onDisk, arg } of cases) {
        const v = await makeVault();
        try {
          const project = `01-Projects/${onDisk}`;
          const folder = `${project}/development/devlog`;
          await put(v, `${project}/development/devlog.md`, "## 2026-10-05: Only\n- x\n");
          const result = await run([arg, "--apply"], { vault: v });
          assert.equal(result.code, 0, `${arg}: ${result.stderr}`);
          assert.equal(
            result.stdout,
            [
              `Wrote 1 day note to ${folder}`,
              `Moved the old devlog to .trash/${project}/development/devlog.md`,
              `Wrote the hub at ${project}/development/devlog.md`,
            ].join("\n") + "\n",
            arg,
          );
          // Names as the folders list them: a case-insensitive lookup would match any spelling.
          const name = `2026-10-05 ${onDisk} devlog.md`;
          assert.deepEqual(await filesIn(v, folder), [name], arg);
          assert.deepEqual(await filesIn(v, ".trash/01-Projects"), [onDisk], arg);
          const projectLine = (await read(v, `${folder}/${name}`)).split("\n")[2];
          const value = projectLine.slice("project: ".length);
          assert.equal(value.startsWith('"') ? JSON.parse(value) : value, onDisk, arg);
          assert.ok((await read(v, `${project}/development/devlog.md`)).includes(`file.inFolder("${folder}")`), arg);
        } finally {
          await fs.rm(v, { recursive: true, force: true });
        }
      }
    });
  });

  describe("scale", () => {
    it("previews and applies a Scope-sized devlog (2 MB, 800 entries, 96 days) in under 10 s", async () => {
      const pieces = [["fm", FM], ["scaffold", "\n# Development Log\n\n## Sessions\n\n"]];
      const filler = Array.from({ length: 21 }, (_, i) => `- line ${i}: ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n");
      const day0 = Date.UTC(2026, 9, 27);
      let entries = 0;
      for (let d = 0; d < 96; d++) {
        const date = new Date(day0 - d * 86_400_000).toISOString().slice(0, 10);
        const count = d < 32 ? 9 : 8;
        for (let k = 0; k < count; k++) {
          const time = `${pad(20 - k)}:${pad(30 - k)}`;
          const heading = d % 2 === 0 ? `### ${date} ${time} Entry ${entries}` : `## ${date}: Entry ${entries}`;
          pieces.push(["entry", `${heading}\n${filler}\n\n`, date]);
          entries++;
        }
      }
      const fx = devlog(pieces);
      assert.equal(entries, 800);
      assert.ok(fx.content.length >= 2_000_000, `fixture is ${fx.content.length} chars`);
      await put(vault, DEVLOG, fx.content);

      const t0 = performance.now();
      const preview = await run([P], { vault });
      const applied = await run([P, "--apply"], { vault });
      const elapsed = performance.now() - t0;

      assert.equal(preview.code, 0, preview.stderr);
      assert.match(preview.stdout, /^Entries: 800 \(### dated: 400, ## day sections: 0, ## dated: 400\)$/m);
      assert.equal(applied.code, 0, applied.stderr);
      assert.equal((await filesIn(vault, FOLDER)).length, 96);
      const notes = expectedDayNotes(fx);
      const newestFirst = [...notes.keys()].sort().reverse();
      const joined = (await Promise.all(newestFirst.map((rel) => read(vault, rel)))).map((c) => c.slice(dayHeader("0000-00-00").length)).join("");
      assert.equal(fx.beforeEntries + joined, fx.content);
      assert.ok(elapsed < 10_000, `took ${Math.round(elapsed)} ms`);
    });
  });
});
