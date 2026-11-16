import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ActivityLog } from "../activity.js";
import { readActivityRetention, activityRetentionFile } from "../activity-retention.js";
import { runTrimActivity } from "../trim-activity.js";

const CLI = path.join(import.meta.dirname, "..", "cli.js");
const DAY_MS = 86_400_000;

describe("obsidian-pkm trim-activity", () => {
  let tmp, vault;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-trim-"));
    vault = path.join(tmp, "vault");
    await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const dbFile = () => path.join(vault, ".obsidian", "activity-log.db");
  const exists = (p) => fs.access(p).then(() => true, () => false);

  /** An activity log from an older version, opened once by this version so its trimming waits for approval. */
  async function pendingLog(ages) {
    const db = new Database(dbFile());
    db.exec("CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_json TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO activity (timestamp, session_id, tool_name, args_json) VALUES (?, 'old', ?, '{}')");
    for (const days of ages) insert.run(new Date(Date.now() - days * DAY_MS).toISOString(), `age_${days}`);
    db.close();
    const log = new ActivityLog({ vaultPath: vault, sessionId: "s" });
    await log.initialize();
    log.shutdown();
    assert.equal((await readActivityRetention(vault)).state, "pending");
  }

  function remainingTools() {
    const db = new Database(dbFile(), { readonly: true });
    const tools = db.prepare("SELECT tool_name FROM activity").all().map((r) => r.tool_name).sort();
    db.close();
    return tools;
  }

  const env = (extra = {}) => {
    const out = { ...process.env, HOME: tmp, USERPROFILE: tmp, ...extra };
    delete out.VAULT_PKM_ACTIVITY_RETENTION_DAYS;
    return out;
  };

  it("deletes the entries older than 90 days, approves trimming from then on, reports the count, and runs through cli.js", async () => {
    await pendingLog([0, 89, 91, 400]);

    const result = spawnSync(process.execPath, [CLI, "trim-activity"], { encoding: "utf8", env: env({ VAULT_PATH: vault }) });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Deleted 2 activity log entries older than 90 days. From now on, entries are deleted once they are 90 days old.\n");
    assert.deepEqual(remainingTools(), ["age_0", "age_89"]);
    assert.deepEqual(await readActivityRetention(vault), { state: "approved" });

    const unknown = spawnSync(process.execPath, [CLI, "nope"], { encoding: "utf8", env: env() });
    assert.match(unknown.stderr, /\| trim-activity/);
  });

  it("explains and changes nothing without VAULT_PATH, with an argument, or with no activity log", async () => {
    const cases = [
      { name: "no VAULT_PATH", args: [], env: {}, code: 2, stderr: /VAULT_PATH is not set/ },
      { name: "unexpected argument", args: ["--apply"], env: { VAULT_PATH: vault }, code: 2, stderr: /Unexpected argument: --apply/ },
      { name: "no activity log", args: [], env: { VAULT_PATH: vault }, code: 0, stdout: /^No activity log at .*activity-log\.db; nothing to trim\.\n$/ },
    ];
    for (const c of cases) {
      let stdout = "";
      let stderr = "";
      const code = await runTrimActivity(c.args, {
        env: c.env,
        stdout: { write: (t) => { stdout += t; } },
        stderr: { write: (t) => { stderr += t; } },
      });
      assert.equal(code, c.code, c.name);
      if (c.stderr) assert.match(stderr, c.stderr, c.name);
      if (c.stdout) assert.match(stdout, c.stdout, c.name);
      assert.equal(await exists(dbFile()), false, `${c.name}: no log created`);
      assert.equal(await exists(activityRetentionFile(vault)), false, `${c.name}: no state file written`);
    }
  });
});
