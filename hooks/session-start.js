#!/usr/bin/env node

import { resolveProject, describeVia } from "./resolve-project.js";
import { loadProjectContext } from "./load-context.js";
import { healthFromStats, describeHealth } from "../semantic-health.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const VAULT_PATH = process.env.VAULT_PATH;

async function getSemanticStats(vaultPath) {
  try {
    const statsPath = path.join(vaultPath, ".obsidian", "semantic-stats.json");
    const raw = await fs.readFile(statsPath, "utf-8");
    const stats = JSON.parse(raw);
    if (typeof stats.indexed_files !== "number") return null;
    return stats;
  } catch {
    return null;
  }
}

const UNLINKED_HINT = "vault-pkm: this repo isn't linked to a vault project. Run /vault-pkm:init-project to link it.";

/**
 * The user message for an unresolved project, or null to stay silent (no match outside git).
 * @param {import("./resolve-project.js").ProjectResolution} resolution
 * @returns {string|null}
 */
function unresolvedMessage({ code, reason = "", inGitRepo }) {
  if (code === "invalid-annotation" || code === "no-vault") return `vault-pkm: ${reason.replace(/\.$/, "")}.`;
  if (!inGitRepo) return null;
  return code === "ambiguous" ? `${UNLINKED_HINT} (${reason})` : UNLINKED_HINT;
}

async function main() {
  let inputJson = "";
  for await (const chunk of process.stdin) {
    inputJson += chunk;
  }

  let input;
  try {
    input = JSON.parse(inputJson);
  } catch {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "PKM hook error: could not parse hook input JSON."
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  const { cwd, source } = input;

  if (!cwd || typeof cwd !== "string") {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "PKM hook error: hook input missing 'cwd' field."
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  if (!VAULT_PATH) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "PKM hook warning: VAULT_PATH not set. Run /vault-pkm:setup to configure your vault path."
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // Check for stale VAULT_PATH (user changed settings but didn't restart)
  let staleEnvWarning = "";
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    const settingsVaultPath = settings?.env?.VAULT_PATH;
    if (settingsVaultPath && settingsVaultPath !== VAULT_PATH) {
      staleEnvWarning = `PKM warning: VAULT_PATH may be stale — settings.json says "${settingsVaultPath}" but the running server uses "${VAULT_PATH}". Restart Claude Code (/quit then relaunch) to pick up the change.\n\n`;
    }
  } catch {
    // settings.json missing or unreadable — not an error
  }

  const resolution = await resolveProject(cwd, VAULT_PATH);
  const { projectPath } = resolution;

  if (projectPath === null) {
    const message = unresolvedMessage(resolution);
    if (message) console.log(JSON.stringify({ systemMessage: message }));
    process.exit(0);
  }

  let context, meta;
  try {
    ({ context, meta } = await loadProjectContext(VAULT_PATH, projectPath, { source }));
  } catch (e) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: staleEnvWarning + `PKM hook error: failed to load project context: ${e.message}`
      }
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  const projectName = path.basename(projectPath);
  const loaded = [];
  const missing = [];
  if (meta.source === "compact") {
    loaded.push("compact");
  } else {
    if (meta.index) loaded.push("index");
    if (meta.devlog > 0) loaded.push(`${meta.devlog} devlog item${meta.devlog !== 1 ? "s" : ""}`);
    if (!meta.index) missing.push("index");
    if (meta.devlog === 0) missing.push("devlog");
  }

  let msg = `Obsidian PKM: Loaded ${projectName}`;
  if (loaded.length > 0) msg += ` (${loaded.join(", ")})`;
  if (missing.length > 0) msg += ` [missing: ${missing.join(", ")}]`;
  msg += ` \u2014 ${context.length.toLocaleString()} chars (${describeVia(resolution)})`;

  const stats = await getSemanticStats(VAULT_PATH);
  const health = healthFromStats(stats);
  if (health) {
    msg += ` | semantic: ${describeHealth(health)}`;
  } else if (stats) {
    // Stats written by a server version that does not report health yet.
    if (stats.vault_files > 0 && stats.indexed_files < stats.vault_files) {
      msg += ` | semantic: ${stats.indexed_files}/${stats.vault_files} notes`;
    } else {
      msg += ` | semantic: ${stats.indexed_files} notes`;
    }
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: staleEnvWarning + context
    },
    systemMessage: msg
  };
  console.log(JSON.stringify(output));
}

// A failing SessionStart hook is reported to the user as a hook error; missing PKM context is not
// worth that, so log and exit cleanly.
main().catch((err) => {
  console.error(`PKM SessionStart hook error: ${err.message}`);
  process.exit(0);
});
