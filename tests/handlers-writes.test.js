import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "node:child_process";
import { setImmediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { createHandlers } from "../handlers.js";
import { loadTemplates } from "../helpers.js";

const IS_WIN = process.platform === "win32";

const note = (title, body = "") => `---\ntype: note\ncreated: 2026-01-01\ntags:\n  - test\n---\n# ${title}\n\n${body}\n`;

async function makeVault(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "writes-vault-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  const make = () => createHandlers({
    vaultPath: root,
    templateRegistry: new Map(),
    semanticIndex: null,
    activityLog: null,
    sessionId: "writes-test",
  });
  return { root, handlers: await make(), make, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("note-modifying tools go through mutateFile", () => {
  const INSTANCES = [
    ["one handler instance", async (v) => [v.handlers, v.handlers]],
    ["two handler instances on the same vault (two servers)", async (v) => [v.handlers, await v.make()]],
  ];
  for (const [label, getPair] of INSTANCES) {
    it(`concurrent vault_append calls to one note all land (${label})`, async () => {
      const v = await makeVault({ "notes/log.md": note("Log") });
      try {
        const [h1, h2] = await getPair(v);
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? h1 : h2).get("vault_append")({ path: "notes/log.md", content: `entry ${i}` })
        ));
        const content = await fs.readFile(path.join(v.root, "notes", "log.md"), "utf-8");
        for (let i = 0; i < 10; i++) assert.match(content, new RegExp(`entry ${i}\\b`));
      } finally {
        await v.cleanup();
      }
    });
  }

  const TOOLS = [
    ["vault_append", "notes/a.md", { path: "notes/a.md", content: "more" }],
    ["vault_edit", "notes/a.md", { path: "notes/a.md", old_string: "body a", new_string: "edited" }],
    ["vault_update_frontmatter", "notes/a.md", { path: "notes/a.md", fields: { status: "active" } }],
    ["vault_add_links", "notes/a.md", { path: "notes/a.md", links: [{ target: "notes/b.md" }] }],
    ["vault_move (referrer rewrite)", "notes/ref.md", { old_path: "notes/b.md", new_path: "notes/c.md" }],
  ];
  for (const [label, watched, args] of TOOLS) {
    it(`${label} replaces the note atomically: a reader that opened it first still sees the complete old version`,
      { skip: IS_WIN && "Windows cannot rename over a file another handle holds open" }, async () => {
        const v = await makeVault({
          "notes/a.md": note("A", "body a"),
          "notes/b.md": note("B"),
          "notes/ref.md": note("Ref", "See [[b]]."),
        });
        try {
          const original = await fs.readFile(path.join(v.root, watched), "utf-8");
          const handle = await fs.open(path.join(v.root, watched), "r");
          try {
            await v.handlers.get(label.split(" ")[0])(args);
            assert.equal(await handle.readFile("utf-8"), original);
            assert.notEqual(await fs.readFile(path.join(v.root, watched), "utf-8"), original);
          } finally {
            await handle.close();
          }
        } finally {
          await v.cleanup();
        }
      });
  }

  const CRLF_NOTE = "---\r\ntype: note\r\ncreated: 2026-01-01\r\ntags:\r\n  - test\r\n---\r\n# CRLF\r\n\r\n## Log\r\nfirst\r\n\r\n## Other\r\nother\r\n";
  const ADDED = "line one\r\nline two";
  const CRLF_CASES = [
    ["at the end", {}, CRLF_NOTE + "\r\n" + ADDED],
    ["after a heading", { heading: "## Log" }, CRLF_NOTE.replace("## Log\r\n", "## Log\r\n" + ADDED + "\r\n")],
    ["at the end of a section", { heading: "## Log", position: "end_of_section" }, CRLF_NOTE.replace("## Other\r\n", ADDED + "\r\n## Other\r\n")],
  ];
  for (const [label, extra, expected] of CRLF_CASES) {
    it(`vault_append ${label} keeps a CRLF note CRLF and its existing bytes intact`, async () => {
      const v = await makeVault({ "notes/crlf.md": CRLF_NOTE });
      try {
        await v.handlers.get("vault_append")({ path: "notes/crlf.md", content: "line one\nline two", ...extra });
        assert.equal(await fs.readFile(path.join(v.root, "notes", "crlf.md"), "utf-8"), expected);
      } finally {
        await v.cleanup();
      }
    });
  }

  const WITH_RELATED = CRLF_NOTE.replace("## Other\r\n", "## Related\r\n- [[other]]\r\n\r\n## Other\r\n");
  const LINK_CASES = [
    ["creating the section", CRLF_NOTE, CRLF_NOTE + "\r\n## Related\r\n- [[b]]\r\n"],
    ["into an existing section", WITH_RELATED, WITH_RELATED.replace("\r\n## Other\r\n", "\r\n- [[b]]\r\n## Other\r\n")],
  ];
  for (const [label, original, expected] of LINK_CASES) {
    it(`vault_add_links ${label} keeps a CRLF note CRLF and its existing bytes intact`, async () => {
      const v = await makeVault({ "notes/crlf.md": original, "notes/b.md": note("B"), "notes/other.md": note("Other") });
      try {
        const result = await v.handlers.get("vault_add_links")({ path: "notes/crlf.md", links: [{ target: "notes/b.md" }] });
        assert.match(result.content[0].text, /Added 1 link/);
        assert.equal(await fs.readFile(path.join(v.root, "notes", "crlf.md"), "utf-8"), expected);
      } finally {
        await v.cleanup();
      }
    });
  }
});

const WORKER = fileURLToPath(new URL("./fixtures/append-worker.js", import.meta.url));

function runWorker(file, tag, count) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [WORKER, file, tag, String(count)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    cp.stderr.on("data", (d) => { err += d; });
    cp.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exited ${code}: ${err}`))));
  });
}

const leaksPath = (text, root) => text.includes(root);

describe("separate processes writing one note", () => {
  it("every append from three real processes lands exactly once and no lock or temp file remains", async () => {
    const v = await makeVault({ "notes/log.md": "" });
    try {
      const file = path.join(v.root, "notes", "log.md");
      const N = 40;
      await Promise.all(["a", "b", "c"].map((tag) => runWorker(file, tag, N)));
      const lines = (await fs.readFile(file, "utf-8")).split("\n").filter(Boolean);
      const expected = ["a", "b", "c"].flatMap((tag) => Array.from({ length: N }, (_, i) => `${tag}-${i}`));
      assert.deepEqual([...lines].sort(), expected.sort());
      assert.deepEqual((await fs.readdir(path.join(v.root, "notes"))).filter((n) => n !== "log.md"), []);
    } finally {
      await v.cleanup();
    }
  });
});

describe("vault_move races and write errors", () => {
  it("vault_move never lets a racing vault_append recreate the old path", async () => {
    for (let delay = 0; delay < 12; delay++) {
      const v = await makeVault({ "notes/b.md": note("B") });
      try {
        const ticks = async () => { for (let i = 0; i < delay; i++) await new Promise((r) => setImmediate(r)); };
        await Promise.allSettled([
          v.handlers.get("vault_append")({ path: "notes/b.md", content: "APPENDED" }),
          ticks().then(() => v.handlers.get("vault_move")({ old_path: "notes/b.md", new_path: "notes/c.md" })),
        ]);
        await assert.rejects(() => fs.access(path.join(v.root, "notes", "b.md")), { code: "ENOENT" });
        await fs.access(path.join(v.root, "notes", "c.md"));
      } finally {
        await v.cleanup();
      }
    }
  });

  it("vault_move finishes the remaining rewrites and reports a referrer it could not update",
    { skip: IS_WIN && "POSIX permission bits" }, async () => {
      const v = await makeVault({
        "notes/b.md": note("B"),
        "notes/r1.md": note("R1", "See [[b]]."),
        "notes/r2.md": note("R2", "See [[b]]."),
      });
      try {
        await fs.chmod(path.join(v.root, "notes", "r1.md"), 0o444);
        const res = await v.handlers.get("vault_move")({ old_path: "notes/b.md", new_path: "notes/c.md" });
        const text = res.content[0].text;
        assert.match(text, /Moved notes\/b\.md/);
        assert.match(text, /could not update links in 1 file/i);
        assert.match(text, /notes\/r1\.md/);
        assert.match(await fs.readFile(path.join(v.root, "notes", "r2.md"), "utf-8"), /\[\[c\]\]/);
        assert.equal(leaksPath(text, v.root), false);
      } finally {
        await v.cleanup();
      }
    });

  it("vault_write into a missing folder reports a vault-relative message, not a temp file path", async () => {
    const v = await makeVault({ "notes/a.md": note("A") });
    try {
      const templateRegistry = new Map([["t", { content: "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - x\n---\n# {{title}}\n" }]]);
      const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "w" });
      await assert.rejects(
        () => h.get("vault_write")({ template: "t", path: "nope/new.md", createDirs: false }),
        (err) => {
          assert.equal(leaksPath(err.message, v.root), false);
          assert.doesNotMatch(err.message, /\.tmp/);
          assert.match(err.message, /nope/);
          return true;
        }
      );
    } finally {
      await v.cleanup();
    }
  });

  // DOMException's message is a prototype getter, so the path rewrite must not assign to it naively.
  for (const [label, message, expected] of [
    ["an abort error passes through unchanged", "This operation was aborted", "This operation was aborted"],
    ["one naming the vault is reported vault-relative", "ROOT/notes/a.md failed", "notes/a.md failed"],
  ]) {
    it(`a DOMException from a tool: ${label}`, async () => {
      const v = await makeVault({ "notes/a.md": note("A") });
      try {
        const thrown = new DOMException(message.replace("ROOT", v.root), "AbortError");
        const h = await createHandlers({
          vaultPath: v.root, templateRegistry: new Map(), activityLog: null, sessionId: "dom",
          semanticIndex: { isAvailable: true, search: async () => { throw thrown; } },
        });
        await assert.rejects(h.get("vault_semantic_search")({ query: "q" }), (err) => {
          assert.equal(err, thrown);
          assert.equal(err.name, "AbortError");
          assert.equal(err.message, expected);
          return true;
        });
      } finally {
        await v.cleanup();
      }
    });
  }

  // Low-level filesystem errors name absolute paths; tools must report them vault-relative.
  const FS_ERRORS = [
    ["vault_read of an unreadable note (EACCES)", "vault_read", { path: "notes/locked.md" }, /notes\/locked\.md/, { posixOnly: true }],
    ["vault_append under a file (ENOTDIR)", "vault_append", { path: "notes/a.md/child.md", content: "x" }, /notes\/a\.md\/child\.md/],
    ["vault_write under a file (mkdir EEXIST)", "vault_write", { template: "t", path: "notes/a.md/child.md" }, /notes\/a\.md/],
    ["vault_move of a folder into itself (EINVAL)", "vault_move", { old_path: "folder", new_path: "folder/sub" }, /folder\/sub/],
    ["vault_move of a note under a file (ENOTDIR)", "vault_move", { old_path: "folder/x.md", new_path: "notes/a.md/x.md" }, /notes\/a\.md/],
  ];
  for (const [label, tool, args, names, { posixOnly = false } = {}] of FS_ERRORS) {
    it(`${label} reports vault-relative paths, never the vault's absolute or real path`, { skip: posixOnly && IS_WIN && "POSIX permission bits" }, async (t) => {
      const v = await makeVault({ "notes/a.md": note("A"), "notes/locked.md": note("L"), "folder/x.md": note("X") });
      const real = await fs.realpath(v.root);
      try {
        await fs.chmod(path.join(v.root, "notes", "locked.md"), 0o000);
        try {
          await fs.readFile(path.join(v.root, "notes", "locked.md"));
          if (posixOnly) return t.skip("running with permission to read any file");
        } catch { /* expected */ }
        const templateRegistry = new Map([["t", { content: "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - x\n---\n# {{title}}\n" }]]);
        const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "rel" });
        await assert.rejects(() => h.get(tool)(args), (err) => {
          assert.equal(leaksPath(err.message, v.root) || leaksPath(err.message, real), false, err.message);
          assert.match(err.message, names);
          return true;
        });
      } finally {
        await fs.chmod(path.join(v.root, "notes", "locked.md"), 0o644);
        await v.cleanup();
      }
    });
  }

  describe("write tools report the note by its normalised vault-relative path", () => {
    const TITLE_TEMPLATE = "---\ntype: note\ncreated: 2026-01-01\ntags:\n  - x\n---\n# <% tp.file.title %>\n";
    const CASES = [
      ["vault_write", { template: "t", path: "notes\\Idea.md" }, "notes/Idea.md"],
      ["vault_append", { path: "notes\\a.md", content: "more" }, "notes/a.md"],
      ["vault_edit", { path: "notes\\a.md", old_string: "body a", new_string: "edited" }, "notes/a.md"],
      ["vault_edit (no match)", { path: "notes\\a.md", old_string: "absent", new_string: "x" }, "notes/a.md"],
      ["vault_update_frontmatter", { path: "notes\\a.md", fields: { status: "active" } }, "notes/a.md"],
      ["vault_add_links", { path: "notes\\a.md", links: [{ target: "notes\\b.md" }] }, "notes/a.md"],
      ["vault_add_links (nothing added)", { path: "notes\\a.md", links: [{ target: "notes\\missing.md" }] }, "notes/a.md"],
    ];
    for (const [label, args, rel] of CASES) {
      it(`${label} given a backslash path names the note with '/' separators`, async () => {
        const v = await makeVault({ "notes/a.md": note("A", "body a"), "notes/b.md": note("B") });
        try {
          const templateRegistry = new Map([["t", { content: TITLE_TEMPLATE }]]);
          const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "sep" });
          const text = (await h.get(label.split(" ")[0])(args)).content[0].text;
          assert.ok(text.includes(rel), text);
          assert.doesNotMatch(text, /\\/);
        } finally {
          await v.cleanup();
        }
      });
    }

    // An absolute path inside the vault names that note; one outside is an escape, never a vault-relative path.
    const ABS_CASES = [
      ["vault_write", (root) => ({ template: "t", path: path.join(root, "notes", "new.md") }), "notes/new.md"],
      ["vault_append", (root) => ({ path: path.join(root, "notes", "a.md"), content: "more" }), "notes/a.md"],
      ["vault_edit", (root) => ({ path: path.join(root, "notes", "a.md"), old_string: "body a", new_string: "edited" }), "notes/a.md"],
      ["vault_update_frontmatter", (root) => ({ path: path.join(root, "notes", "a.md"), fields: { status: "active" } }), "notes/a.md"],
      ["vault_add_links", (root) => ({ path: path.join(root, "notes", "a.md"), links: [{ target: "notes/b.md" }] }), "notes/a.md"],
      ["vault_move", (root) => ({ old_path: path.join(root, "notes", "a.md"), new_path: path.join(root, "moved", "a.md") }), "moved/a.md"],
      ["vault_trash", (root) => ({ path: path.join(root, "notes", "a.md") }), ".trash/notes/a.md"],
    ];
    for (const [tool, makeArgs, rel] of ABS_CASES) {
      it(`${tool} given an absolute path inside the vault acts on that note`, async () => {
        const v = await makeVault({ "notes/a.md": note("A", "body a"), "notes/b.md": note("B") });
        try {
          const templateRegistry = new Map([["t", { content: TITLE_TEMPLATE }]]);
          const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "abs" });
          const text = (await h.get(tool)(makeArgs(v.root))).content[0].text;
          assert.ok(text.includes(rel), text);
          await fs.access(path.join(v.root, ...rel.split("/")));
          const top = (await fs.readdir(v.root)).filter((e) => !["notes", "moved", ".trash"].includes(e));
          assert.deepEqual(top, [], "no copy of the absolute path's folders inside the vault");
        } finally {
          await v.cleanup();
        }
      });
    }

    it("vault_write and vault_move refuse an absolute path outside the vault", async () => {
      const v = await makeVault({ "notes/a.md": note("A") });
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "writes-outside-"));
      try {
        const templateRegistry = new Map([["t", { content: TITLE_TEMPLATE }]]);
        const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "abs-out" });
        await assert.rejects(h.get("vault_write")({ template: "t", path: path.join(outside, "x.md") }), /escapes vault/);
        await assert.rejects(h.get("vault_move")({ old_path: "notes/a.md", new_path: path.join(outside, "a.md") }), /escapes vault/);
        assert.deepEqual(await fs.readdir(outside), []);
        assert.deepEqual((await fs.readdir(v.root)).sort(), ["notes"]);
        await fs.access(path.join(v.root, "notes", "a.md"));
      } finally {
        await v.cleanup();
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("vault_write given a backslash path titles the note by its file name", async () => {
      const v = await makeVault({});
      try {
        const templateRegistry = new Map([["t", { content: TITLE_TEMPLATE }]]);
        const h = await createHandlers({ vaultPath: v.root, templateRegistry, semanticIndex: null, activityLog: null, sessionId: "title" });
        await h.get("vault_write")({ template: "t", path: "notes\\Idea.md" });
        assert.match(await fs.readFile(path.join(v.root, "notes", "Idea.md"), "utf-8"), /^# Idea$/m);
      } finally {
        await v.cleanup();
      }
    });
  });

  it("vault_append to a read-only note refuses without leaking the absolute path", { skip: IS_WIN && "POSIX permission bits" }, async () => {
    const v = await makeVault({ "notes/ro.md": note("RO") });
    try {
      await fs.chmod(path.join(v.root, "notes", "ro.md"), 0o444);
      await assert.rejects(
        () => v.handlers.get("vault_append")({ path: "notes/ro.md", content: "x" }),
        (err) => {
          assert.match(err.message, /read-only/);
          assert.equal(leaksPath(err.message, v.root), false);
          return true;
        }
      );
    } finally {
      await v.cleanup();
    }
  });
});

describe("vault_write with bundled templates", () => {
  async function bundledVault() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-vault-"));
    const handlers = await createHandlers({
      vaultPath: root,
      templateRegistry: await loadTemplates(root),
      semanticIndex: null,
      activityLog: null,
      sessionId: "bundled-test",
    });
    return { root, handlers, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  }

  it("devlog-session creates a session note with its properties", async () => {
    const v = await bundledVault();
    try {
      const rel = "01-Projects/Demo/development/devlog/2026-10-27 0930 Fix Thing.md";
      await v.handlers.get("vault_write")({
        template: "devlog-session",
        path: rel,
        frontmatter: { tags: ["devlog"], project: "Demo", session: "abc-123" },
      });
      const content = await fs.readFile(path.join(v.root, rel), "utf-8");
      const fm = content.split("---")[1];
      assert.match(fm, /^type: devlog-session$/m);
      assert.match(fm, /^project: Demo$/m);
      assert.match(fm, /^session: abc-123$/m);
      assert.match(fm, /^created: \d{4}-\d{2}-\d{2}$/m);
      assert.match(fm, /^tags:\n\s+- devlog$/m);
    } finally {
      await v.cleanup();
    }
  });

  it("devlog creates the hub embedding a table of the folder, and fails without devlog_folder", async () => {
    const v = await bundledVault();
    try {
      const rel = "01-Projects/Demo/development/devlog.md";
      const folder = "01-Projects/Demo/development/devlog";
      await v.handlers.get("vault_write")({
        template: "devlog",
        path: rel,
        frontmatter: { tags: ["devlog"], project: "Demo" },
        variables: { devlog_folder: folder },
      });
      const content = await fs.readFile(path.join(v.root, rel), "utf-8");
      const body = content.slice(content.indexOf("---", 3) + 4).replace(/^\n/, "");
      assert.equal(body, [
        "# Development Log",
        "",
        "Each session has its own note in the devlog folder next to this one; the table lists them newest first.",
        "",
        "```base",
        "filters:",
        "  and:",
        `    - file.inFolder("${folder}")`,
        "views:",
        "  - type: table",
        "    name: Sessions",
        "    order:",
        "      - file.name",
        "      - type",
        "      - file.mtime",
        "    sort:",
        "      - property: file.name",
        "        direction: DESC",
        "```",
        "",
      ].join("\n"));

      await assert.rejects(
        v.handlers.get("vault_write")({ template: "devlog", path: "01-Projects/Other/development/devlog.md", frontmatter: { tags: ["devlog"] } }),
        /Unsubstituted template variables/,
      );
    } finally {
      await v.cleanup();
    }
  });
});
