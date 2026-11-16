// Whether the activity log may delete entries older than its retention window. A log this
// version creates may; a log an older version left behind waits for the user's approval
// (`obsidian-pkm trim-activity`). The server records the state beside the log, and session
// start reads it to raise the upgrade step, so this module uses only node: imports.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{ state: "approved" }
 *   | { state: "pending", days: number, older: number, checked: string }} RetentionState
 *   pending: `older` entries are older than `days` days, as counted at `checked` (ISO time)
 */

/**
 * @param {string} vaultPath
 * @returns {string}
 */
export function activityRetentionFile(vaultPath) {
  return path.join(vaultPath, ".obsidian", "activity-retention.json");
}

/**
 * @param {string} vaultPath
 * @returns {Promise<RetentionState|null>} null when the file is missing, unreadable or not a state
 */
export async function readActivityRetention(vaultPath) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(activityRetentionFile(vaultPath), "utf-8"));
  } catch {
    return null;
  }
  if (value?.state === "approved") return { state: "approved" };
  if (value?.state === "pending" && Number.isFinite(value.days) && Number.isInteger(value.older)
    && typeof value.checked === "string") {
    return { state: "pending", days: value.days, older: value.older, checked: value.checked };
  }
  return null;
}

/**
 * Replace the state atomically, so a reader never sees half a file.
 * @param {string} vaultPath
 * @param {RetentionState} state
 * @returns {Promise<void>}
 */
export async function writeActivityRetention(vaultPath, state) {
  const file = activityRetentionFile(vaultPath);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(state)}\n`);
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
