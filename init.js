import os from "os";
import path from "path";
import fs from "fs/promises";

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
    : await fs.readdir(src);

  let created = 0, skipped = 0;

  for (const file of files) {
    const destFile = path.join(dest, file);
    try {
      await fs.access(destFile);
      skipped++;
    } catch {
      await fs.copyFile(path.join(src, file), destFile);
      created++;
    }
  }

  return { created, skipped };
}
