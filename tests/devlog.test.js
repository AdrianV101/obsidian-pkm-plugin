import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  devlogFolder,
  sessionPrefix,
  classifyNoteName,
  dayNoteName,
  listDevlogNotes,
  findSessionNote,
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
