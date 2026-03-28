import os from "os";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

/**
 * Resolve user-provided path input: expand ~, $HOME, resolve relative, normalise.
 */
export function resolveInputPath(raw) {
  let p = raw;

  // Expand ~ at start
  if (p === "~") {
    p = os.homedir();
  } else if (p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(2));
  }

  // Expand $HOME and ${HOME}
  p = p.replace(/\$\{HOME\}/g, os.homedir());
  p = p.replace(/\$HOME/g, os.homedir());

  // Resolve to absolute
  p = path.resolve(p);

  // Normalise (path.resolve already handles double slashes and trailing slashes)
  // But strip any remaining trailing slash (path.resolve keeps root /)
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }

  return p;
}

const PARA_FOLDERS = [
  { name: "00-Inbox", title: "Inbox", desc: "Quick captures and unsorted notes" },
  { name: "01-Projects", title: "Projects", desc: "Active project folders" },
  { name: "02-Areas", title: "Areas", desc: "Ongoing areas of responsibility" },
  { name: "03-Resources", title: "Resources", desc: "Reference material and reusable knowledge" },
  { name: "04-Archive", title: "Archive", desc: "Completed or inactive items" },
  { name: "05-Templates", title: "Templates", desc: "Note templates" },
  { name: "06-System", title: "System", desc: "System configuration and metadata" },
];

function makeIndexStub(title, desc) {
  const today = new Date().toISOString().split("T")[0];
  return `---\ntype: moc\ncreated: ${today}\ntags:\n  - index\n---\n\n# ${title}\n\n${desc}\n`;
}

/**
 * Create PARA folder structure with _index.md stubs.
 * @param {string} vaultPath
 * @returns {Promise<{created: number, skipped: number}>}
 */
export async function scaffoldFolders(vaultPath) {
  let created = 0, skipped = 0;

  for (const folder of PARA_FOLDERS) {
    const dirPath = path.join(vaultPath, folder.name);
    await fs.mkdir(dirPath, { recursive: true });

    const indexPath = path.join(dirPath, "_index.md");
    try {
      await fs.access(indexPath);
      skipped++;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await fs.writeFile(indexPath, makeIndexStub(folder.title, folder.desc));
      created++;
    }
  }

  return { created, skipped };
}

/**
 * Copy templates from src to dest directory.
 * @param {string} src - Source templates directory (bundled)
 * @param {string} dest - Destination 05-Templates/ directory in vault
 * @param {"full"|"minimal"|"skip"} mode
 * @returns {Promise<{created: number, skipped: number}>}
 */
export async function copyTemplates(src, dest, mode) {
  if (mode === "skip") return { created: 0, skipped: 0 };

  await fs.mkdir(dest, { recursive: true });

  const files = mode === "minimal"
    ? ["note.md"]
    : (await fs.readdir(src)).filter(f => f.endsWith(".md"));

  let created = 0, skipped = 0;

  for (const file of files) {
    const destFile = path.join(dest, file);
    try {
      await fs.access(destFile);
      skipped++;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await fs.copyFile(path.join(src, file), destFile);
      created++;
    }
  }

  return { created, skipped };
}

/**
 * Back up a vault directory to a timestamped sibling directory.
 * @param {string} vaultPath
 * @returns {Promise<string>} Path to the backup directory.
 */
export async function backupVault(vaultPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = `${vaultPath}-backup-${timestamp}`;
  await fs.cp(vaultPath, backupPath, { recursive: true });
  return backupPath;
}

/**
 * Calculate total size of a directory (in bytes). Skips symlinks.
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
export async function dirSize(dirPath) {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(fullPath);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

const SYSTEM_DIRS = new Set(["/", "/home", "/usr", "/var", "/etc", "/tmp", "/opt", "/bin", "/sbin"]);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Interactive vault scaffolding wizard.
 * Sets up vault structure (templates, PARA folders) for use with the obsidian-pkm plugin.
 * MCP registration and hooks are handled by the plugin system — use `/obsidian-pkm:setup` in Claude Code.
 */
export async function runInit() {
  const { confirm: confirmPrompt, input, select } = await import("@inquirer/prompts");

  const bundledTemplatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");

  try {
    // ── Step 1: Welcome ──
    console.log(`
obsidian-pkm vault scaffolding

This will set up your Obsidian vault structure for use with the obsidian-pkm
plugin. You'll be asked about 3 things:

  1. Where your vault is (or where to create one)
  2. Whether to install note templates
  3. Whether to set up the recommended folder structure

Nothing is written until you confirm each step. Press Ctrl+C at any time to cancel.

Note: To configure Claude Code (MCP server, hooks, API keys), install the
plugin and run /obsidian-pkm:setup in Claude Code.
`);

    // ── Step 2: Vault Path ──
    const hasVault = await confirmPrompt({
      message: "Do you have an existing Obsidian vault?",
      default: false,
    });

    const defaultPath = hasVault
      ? ""
      : path.join(os.homedir(), "Documents", "PKM");

    const rawPath = await input({
      message: hasVault
        ? "Path to your vault:"
        : "Where should we create your vault?",
      default: defaultPath || undefined,
      validate: (val) => (val.trim() ? true : "Please enter a path."),
    });

    const vaultPath = await resolveVaultPath(resolveInputPath(rawPath.trim()), hasVault);

    // ── Step 3: Templates ──
    const templateMode = await select({
      message: "Install note templates? These are used by the vault_write tool to create structured notes with proper frontmatter.",
      choices: [
        { name: "Full set (13 templates — ADR, devlog, research, task, etc.)", value: "full" },
        { name: "Minimal (just note.md — a single generic template)", value: "minimal" },
        { name: "Skip (I have my own templates)", value: "skip" },
      ],
    });

    const templateDest = path.join(vaultPath, "05-Templates");
    const templateResult = await copyTemplates(bundledTemplatesDir, templateDest, templateMode);
    if (templateMode !== "skip") {
      console.log(`  Templates: ${templateResult.created} installed, ${templateResult.skipped} already existed`);
    } else {
      console.log("  Note: vault_write requires at least one template in 05-Templates/ to function. All other tools work without templates.");
    }

    // ── Step 4: Folders ──
    console.log("\nPARA folder structure to create:");
    for (const folder of PARA_FOLDERS) {
      const suffix = (folder.name === "05-Templates" && templateMode !== "skip")
        ? " (already set up)"
        : "";
      const padded = (folder.name + "/").padEnd(19);
      console.log(`  ${padded} — ${folder.desc}${suffix}`);
    }

    const doFolders = await confirmPrompt({
      message: "Create PARA folder structure?",
      default: true,
    });

    let folderResult = null;
    if (doFolders) {
      folderResult = await scaffoldFolders(vaultPath);
      console.log(`  Folders: ${folderResult.created} created, ${folderResult.skipped} already existed`);
    } else {
      console.log("  Folders: skipped");
    }

    // ── Step 5: Summary ──
    const templateSummary = templateMode === "skip"
      ? "Skipped"
      : `${templateResult.created} installed in 05-Templates/`;
    const folderSummary = folderResult
      ? `${folderResult.created} created`
      : "Skipped";

    console.log(`
Vault scaffolding complete!

  Vault:     ${vaultPath}
  Templates: ${templateSummary}
  Folders:   ${folderSummary}

Next steps:
  1. Install the plugin:  claude plugin marketplace add AdrianV101/obsidian-pkm-plugin
                          claude plugin install obsidian-pkm
  2. Configure Claude Code: /obsidian-pkm:setup
`);
  } catch (e) {
    if (e.name === "ExitPromptError") {
      console.log("\nSetup cancelled.");
      return;
    }
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  }

  // ── Inner function: resolveVaultPath ──
  async function resolveVaultPath(resolved, hasVault) {
    console.log(`\n  Resolved path: ${resolved}\n`);

    // System directory safety check
    if (SYSTEM_DIRS.has(resolved) || resolved === os.homedir()) {
      console.log(`\n  "${resolved}" is a system directory. Using it directly as a vault could be dangerous.`);
      const newRaw = await input({
        message: "Please enter a different path:",
        validate: (val) => (val.trim() ? true : "Please enter a path."),
      });
      return resolveVaultPath(resolveInputPath(newRaw.trim()), hasVault);
    }

    // Check what exists at the path
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (e) {
      if (e.code === "ENOENT") {
        const create = await confirmPrompt({ message: `This directory doesn't exist. Create ${resolved}?` });
        if (!create) { console.log("Setup cancelled."); process.exit(0); }
        await fs.mkdir(resolved, { recursive: true });
        console.log(`  Created ${resolved}`);
        return resolved;
      }
      throw e;
    }

    // Path is a file, not a directory
    if (!stat.isDirectory()) {
      console.log(`\n  "${resolved}" is a file, not a directory.`);
      const newRaw = await input({
        message: "Please enter a directory path:",
        validate: (val) => (val.trim() ? true : "Please enter a path."),
      });
      return resolveVaultPath(resolveInputPath(newRaw.trim()), hasVault);
    }

    // Directory exists — check if empty
    const entries = await fs.readdir(resolved);
    if (entries.length === 0) {
      const useEmpty = await confirmPrompt({ message: `Use ${resolved} as your vault?` });
      if (!useEmpty) { console.log("Setup cancelled."); process.exit(0); }
      console.log(`  Using empty directory ${resolved}`);
      return resolved;
    }

    // Non-empty directory
    if (hasVault) {
      // User said they have a vault — confirm then offer backup
      console.log(`  Using existing vault ${resolved}`);
      await offerBackup(resolved);
      return resolved;
    }

    // Non-empty dir, user said no vault — need to decide
    const dirAction = await select({
      message: `"${resolved}" is not empty. What should we do?`,
      choices: [
        { name: "Use it as-is (add PKM structure alongside existing files)", value: "use" },
        { name: "Create a subfolder inside it", value: "subfolder" },
        { name: "Wipe it and start fresh (DESTRUCTIVE)", value: "wipe" },
      ],
    });

    if (dirAction === "use") {
      // Offer backup
      await offerBackup(resolved);
      console.log(`  Using ${resolved}`);
      return resolved;
    }

    if (dirAction === "subfolder") {
      const subName = await input({ message: "Subfolder name:", default: "PKM" });
      const subPath = path.join(resolved, subName);
      if (!subPath.startsWith(resolved + path.sep) && subPath !== resolved) {
        console.log("  Subfolder name must not contain path separators or navigation (..).\n");
        return resolveVaultPath(resolved, hasVault);
      }
      await fs.mkdir(subPath, { recursive: true });
      console.log(`  Created ${subPath}`);
      return subPath;
    }

    // Wipe — triple confirmation
    const bname = path.basename(resolved);
    console.log(`\n  This will permanently delete ALL contents of ${resolved}`);

    const wipeConfirm1 = await confirmPrompt({
      message: "Are you sure you want to wipe this directory?",
      default: false,
    });
    if (!wipeConfirm1) {
      return resolveVaultPath(resolved, true); // re-evaluate as existing vault
    }

    await offerBackup(resolved);

    const typedName = await input({
      message: `Type "${bname}" to confirm:`,
    });
    if (typedName !== bname) {
      console.log("  Names did not match. Wipe cancelled.");
      return resolveVaultPath(resolved, true);
    }

    // Third confirmation before wipe
    const c3 = await confirmPrompt({ message: `Last chance. Delete all contents of ${resolved}?` });
    if (!c3) { console.log("Wipe cancelled."); process.exit(0); }

    // Do the wipe
    const wipeEntries = await fs.readdir(resolved);
    for (const entry of wipeEntries) {
      await fs.rm(path.join(resolved, entry), { recursive: true, force: true });
    }
    console.log(`  Wiped and using ${resolved}`);
    return resolved;
  }

  async function offerBackup(dirPath) {
    const size = await dirSize(dirPath);
    const sizeStr = formatBytes(size);
    const sizeWarning = size > 500 * 1024 * 1024
      ? ` (${sizeStr} — this may take a while)`
      : ` (${sizeStr})`;

    const doBackup = await confirmPrompt({
      message: `Back up ${dirPath} first?${sizeWarning}`,
      default: true,
    });

    if (doBackup) {
      try {
        const backupPath = await backupVault(dirPath);
        console.log(`  Backup created: ${backupPath}\n`);
      } catch (e) {
        console.error(`Backup failed: ${e.message}. Aborting to keep your data safe.`);
        process.exit(1);
      }
    }
  }
}
