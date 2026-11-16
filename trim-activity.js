// `obsidian-pkm trim-activity`: the user's approval to trim an activity log an older version
// left behind. Claude runs it on the user's OK when session start raises the upgrade step.

import fs from "node:fs/promises";
import path from "node:path";
import { ActivityLog } from "./activity.js";

const USAGE = "Usage: obsidian-pkm trim-activity";

/**
 * @param {string[]} args the arguments after `trim-activity`
 * @param {{ env?: Record<string, string|undefined>,
 *   stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [options]
 * @returns {Promise<number>} 0 done or nothing to trim; 1 the log could not be trimmed; 2 usage error
 */
export async function runTrimActivity(args, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  /** @param {string} line */
  const out = (line) => { stdout.write(`${line}\n`); };
  /** @param {string} line */
  const err = (line) => { stderr.write(`${line}\n`); };

  if (args.length > 0) {
    err(`Unexpected argument: ${args[0]}`);
    err(USAGE);
    return 2;
  }
  const vault = env.VAULT_PATH;
  if (typeof vault !== "string" || vault === "" || vault.includes("${")) {
    err("VAULT_PATH is not set; set it to your vault's folder.");
    err(USAGE);
    return 2;
  }

  const log = new ActivityLog({
    vaultPath: path.resolve(vault),
    sessionId: "trim-activity",
    retentionDays: env.VAULT_PKM_ACTIVITY_RETENTION_DAYS,
  });
  if (!(await fs.access(log.dbPath).then(() => true, () => false))) {
    out(`No activity log at ${log.dbPath}; nothing to trim.`);
    return 0;
  }

  let deleted;
  try {
    await log.initialize();
    // A retention set in the environment already trims while the log opens.
    deleted = log.deletedAtStart + await log.approveRetention();
  } catch (e) {
    err(`Could not trim ${log.dbPath}: ${e.message}`);
    return 1;
  } finally {
    log.shutdown();
  }
  const days = log.retentionDays;
  if (days === 0) {
    out("Trimming approved. VAULT_PKM_ACTIVITY_RETENTION_DAYS is 0, so the log keeps every entry.");
  } else {
    out(`Deleted ${deleted} activity log ${deleted === 1 ? "entry" : "entries"} older than ${days} days. From now on, entries are deleted once they are ${days} days old.`);
  }
  return 0;
}
