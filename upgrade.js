// `obsidian-pkm upgrade dismiss <step> [<target>]` and `obsidian-pkm upgrade reset`.
// Claude runs dismiss when the user says "never" to an upgrade step that session start raised.

import { addDismissal, clearDismissals, dismissalFile, validateDismissal } from "./upgrade-dismissals.js";

const USAGE = "Usage: obsidian-pkm upgrade dismiss <step> [<target>] | obsidian-pkm upgrade reset";

/**
 * @param {string[]} args the arguments after `upgrade`
 * @param {{ env?: Record<string, string|undefined>, home?: string, now?: Date,
 *   stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [options]
 * @returns {Promise<number>} 0 done; 1 the file could not be written; 2 usage error
 */
export async function runUpgrade(args, options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const { home, now } = options;
  /** @param {string} line */
  const out = (line) => { stdout.write(`${line}\n`); };
  /** @param {string} line */
  const err = (line) => { stderr.write(`${line}\n`); };
  /** @param {string} reason */
  const usage = (reason) => {
    err(reason);
    err(USAGE);
    return 2;
  };

  const [command, ...rest] = args;
  if (command === "reset") {
    if (rest.length > 0) return usage(`Unexpected argument: ${rest[0]}`);
    try {
      const count = await clearDismissals({ home });
      out(`Cleared ${count} dismissed upgrade step${count === 1 ? "" : "s"} on this device.`);
      return 0;
    } catch (e) {
      err(`Could not clear ${dismissalFile(home)}: ${e.message}`);
      return 1;
    }
  }
  if (command !== "dismiss") return usage(command === undefined ? "Missing command" : `Unknown command: ${command}`);

  const [step, target = null, ...extra] = rest;
  if (step === undefined) return usage("Missing <step>");
  if (extra.length > 0) return usage(`Unexpected argument: ${extra[0]}`);
  const vault = env.VAULT_PATH;
  if (typeof vault !== "string" || vault === "" || vault.includes("${")) {
    return usage("VAULT_PATH is not set; set it to your vault's folder.");
  }
  const problem = validateDismissal({ step, vault, target });
  if (problem) return usage(problem);

  try {
    const { replaced } = await addDismissal(
      { step: /** @type {import("./upgrade-dismissals.js").StepId} */ (step), vault, target },
      { home, now },
    );
    if (replaced) err(`Replaced an unreadable ${dismissalFile(home)}: ${replaced}`);
  } catch (e) {
    err(`Could not write ${dismissalFile(home)}: ${e.message}`);
    return 1;
  }
  out(`Dismissed ${step}${target === null ? "" : ` for ${target}`} on this device. Undo with: obsidian-pkm upgrade reset`);
  return 0;
}
