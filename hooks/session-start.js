#!/usr/bin/env node

import { resolveProject } from "./resolve-project.js";
import { loadProjectContext } from "./load-context.js";
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

  const { cwd } = input;

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
        additionalContext: "PKM hook warning: VAULT_PATH not set. Run /obsidian-pkm:setup to configure your vault path."
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

  const { projectPath, error } = await resolveProject(cwd, VAULT_PATH);

  if (error) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: staleEnvWarning + `PKM: ${error}\n\n` +
          "The obsidian-pkm plugin is installed but no vault project could be resolved for this directory. " +
          "If the user asks about PKM or documentation, suggest running /obsidian-pkm:init-project."
      },
      systemMessage: "Obsidian PKM: No vault project found. Run /obsidian-pkm:init-project to set up vault integration."
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  // Check if CWD's CLAUDE.md has ## PKM Integration section
  let hasPkmSection = false;
  try {
    const claudeMdContent = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    hasPkmSection = /^## PKM Integration/m.test(claudeMdContent);
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`PKM session-start: error reading CLAUDE.md: ${e.message}`);
    }
    // hasPkmSection stays false
  }

  if (!hasPkmSection) {
    let context = "";
    try {
      ({ context } = await loadProjectContext(VAULT_PATH, projectPath));
    } catch (e) {
      console.error(`PKM session-start: failed to load project context: ${e.message}`);
      // context stays "" — still show the nudge
    }

    const output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: staleEnvWarning + (context ? context + "\n\n" : "") +
          "PKM: This project's CLAUDE.md does not have a ## PKM Integration section. " +
          "The obsidian-pkm plugin is installed but this project is not configured for proactive vault usage. " +
          "If the user asks about PKM or documentation, suggest running /obsidian-pkm:init-project."
      },
      systemMessage: "Obsidian PKM: This project isn't configured yet. Run /obsidian-pkm:init-project to set up vault integration."
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  let context, meta;
  try {
    ({ context, meta } = await loadProjectContext(VAULT_PATH, projectPath));
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
  if (meta.index) loaded.push("index");
  if (meta.devlog) loaded.push("devlog");
  if (meta.tasks > 0) loaded.push(`${meta.tasks} task${meta.tasks !== 1 ? "s" : ""}`);
  const missing = [];
  if (!meta.index) missing.push("index");
  if (!meta.devlog) missing.push("devlog");
  if (meta.tasks === 0) missing.push("tasks");

  let msg = `Obsidian PKM: Loaded ${projectName}`;
  if (loaded.length > 0) msg += ` (${loaded.join(", ")})`;
  if (missing.length > 0) msg += ` [missing: ${missing.join(", ")}]`;
  msg += ` \u2014 ${context.length.toLocaleString()} chars`;

  const stats = await getSemanticStats(VAULT_PATH);
  if (stats) {
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

main().catch((err) => {
  console.error(`PKM SessionStart hook error: ${err.message}`);
  process.exit(1);
});
