import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dismissalFile,
  validateDismissal,
  readDismissals,
  addDismissal,
  clearDismissals,
  isDismissed,
} from "../upgrade-dismissals.js";

const NOW = new Date("2026-11-16T10:20:30.000Z");

describe("upgrade dismissals", () => {
  let home, vault;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-dismiss-"));
    vault = path.join(home, "vault");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const exists = (p) => fs.access(p).then(() => true, () => false);

  it("records a dismissal in <home>/.claude/vault-pkm/upgrade-dismissals.json, read back normalised", async () => {
    await addDismissal({ step: "devlog-migration", vault: `${vault}/`, target: "01-Projects/A/" }, { home, now: NOW });

    assert.equal(dismissalFile(home), path.join(home, ".claude", "vault-pkm", "upgrade-dismissals.json"));
    assert.ok(await exists(dismissalFile(home)));
    assert.deepEqual(await readDismissals({ home }), {
      dismissals: [{ step: "devlog-migration", vault: path.resolve(vault), target: "01-Projects/A", at: NOW.toISOString() }],
      error: null,
    });
  });

  it("isDismissed matches only the same step, vault and target; a bare project name is a folder under 01-Projects", () => {
    const recorded = [
      { step: "devlog-migration", vault: path.resolve("/v"), target: "01-Projects/A", at: NOW.toISOString() },
      { step: "claude-md-section", vault: path.resolve("/v"), target: path.resolve("/repo"), at: NOW.toISOString() },
      { step: "devlog-template", vault: path.resolve("/v"), target: null, at: NOW.toISOString() },
    ];
    const rows = [
      [{ step: "devlog-migration", vault: "/v", target: "01-Projects/A" }, true],
      [{ step: "devlog-migration", vault: "/v/", target: "01-Projects/A" }, true],
      [{ step: "devlog-migration", vault: "/x/../v", target: "01-Projects/A" }, true],
      [{ step: "devlog-migration", vault: "/v", target: "01-Projects/A/" }, true],
      [{ step: "devlog-migration", vault: "/v", target: "A" }, true],
      [{ step: "claude-md-section", vault: "/v", target: "/repo/" }, true],
      [{ step: "devlog-template", vault: "/v", target: null }, true],
      [{ step: "devlog-migration", vault: "/other", target: "01-Projects/A" }, false],
      [{ step: "devlog-migration", vault: "/v", target: "01-Projects/B" }, false],
      [{ step: "claude-md-section", vault: "/v", target: "/other-repo" }, false],
      [{ step: "devlog-template", vault: "/other", target: null }, false],
    ];
    for (const [key, expected] of rows) {
      assert.equal(isDismissed(recorded, /** @type {any} */ (key)), expected, JSON.stringify(key));
    }
    assert.equal(isDismissed(recorded.slice(1), { step: "devlog-migration", vault: "/v", target: "01-Projects/A" }), false);
  });

  it("adding a dismissal that is already recorded keeps one entry", async () => {
    const key = { step: "devlog-template", vault, target: null };
    await addDismissal(/** @type {any} */ (key), { home, now: NOW });
    await addDismissal(/** @type {any} */ (key), { home, now: new Date(NOW.getTime() + 1000) });
    assert.equal((await readDismissals({ home })).dismissals.length, 1);
  });

  it("readDismissals reads a missing file as none, and an unreadable one as none with the reason", async () => {
    assert.deepEqual(await readDismissals({ home }), { dismissals: [], error: null });

    const file = dismissalFile(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const unreadable = [
      "not json",
      "[]",
      JSON.stringify({ version: 2, dismissed: [] }),
      JSON.stringify({ version: 1, dismissed: {} }),
    ];
    for (const text of unreadable) {
      await fs.writeFile(file, text);
      const read = await readDismissals({ home });
      assert.deepEqual(read.dismissals, [], text);
      assert.equal(typeof read.error, "string", text);
      assert.notEqual(read.error, "", text);
    }

    const good = { step: "devlog-template", vault: "/v", target: null, at: NOW.toISOString() };
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      dismissed: [good, { step: "nope", vault: "/v", target: null, at: "x" }, { step: "devlog-template", vault: 3, target: null }],
    }));
    assert.deepEqual(await readDismissals({ home }), { dismissals: [good], error: null });
  });

  it("addDismissal over an unreadable file replaces it and returns the read error", async () => {
    const file = dismissalFile(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ broken");

    const { replaced } = await addDismissal({ step: "devlog-template", vault, target: null }, { home, now: NOW });

    assert.equal(typeof replaced, "string");
    assert.notEqual(replaced, "");
    const read = await readDismissals({ home });
    assert.equal(read.error, null);
    assert.deepEqual(read.dismissals.map((d) => d.step), ["devlog-template"]);
  });

  it("clearDismissals removes every dismissal and says how many; with no file it creates nothing", async () => {
    assert.equal(await clearDismissals({ home }), 0);
    assert.equal(await exists(dismissalFile(home)), false);

    await addDismissal({ step: "devlog-template", vault, target: null }, { home, now: NOW });
    await addDismissal({ step: "devlog-migration", vault, target: "01-Projects/A" }, { home, now: NOW });
    assert.equal(await clearDismissals({ home }), 2);
    assert.deepEqual(await readDismissals({ home }), { dismissals: [], error: null });
  });

  it("validateDismissal accepts each step's shape and rejects the rest; addDismissal writes nothing for a rejected key", async () => {
    const valid = [
      { step: "devlog-template", vault: "/v", target: null },
      { step: "devlog-migration", vault: "/v", target: "01-Projects/A" },
      { step: "claude-md-section", vault: "/v", target: "/repo" },
    ];
    for (const key of valid) assert.equal(validateDismissal(key), null, JSON.stringify(key));

    const invalid = [
      { step: "nope", vault: "/v", target: null },
      { step: "devlog-template", vault: "/v", target: "x" },
      { step: "devlog-migration", vault: "/v", target: null },
      { step: "devlog-migration", vault: "/v", target: "  " },
      { step: "claude-md-section", vault: "/v", target: null },
      { step: "claude-md-section", vault: "/v", target: "" },
    ];
    for (const key of invalid) {
      const message = validateDismissal(key);
      assert.equal(typeof message, "string", JSON.stringify(key));
      await assert.rejects(addDismissal(/** @type {any} */ (key), { home, now: NOW }), { message });
    }
    assert.equal(await exists(dismissalFile(home)), false);
  });
});
