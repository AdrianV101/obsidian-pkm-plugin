import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "node:child_process";
import { setImmediate } from "node:timers";
import { fileURLToPath } from "node:url";
import { createHandlers } from "../handlers.js";

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
