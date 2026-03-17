import fs from "fs/promises";
import path from "path";

export async function resolveProject(cwd, vaultPath) {
  try {
    await fs.access(vaultPath);
  } catch {
    return { error: `VAULT_PATH does not exist: ${vaultPath}` };
  }

  const projectsDir = path.join(vaultPath, "01-Projects");
  const cwdBasename = path.basename(cwd).toLowerCase();

  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === cwdBasename) {
        return { projectPath: `01-Projects/${entry.name}` };
      }
    }
  } catch {
    // 01-Projects/ doesn't exist -- fall through to CLAUDE.md check
  }

  try {
    const claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    const match = claudeMd.match(/^#\s+PKM:\s*(.+)$/m);
    if (match) {
      const annotatedPath = match[1].trim();
      try {
        await fs.access(path.join(vaultPath, annotatedPath));
        return { projectPath: annotatedPath };
      } catch {
        return { error: `CLAUDE.md annotation points to non-existent vault path: ${annotatedPath}` };
      }
    }
  } catch {
    // No CLAUDE.md or not readable -- fall through
  }

  return {
    error: `No vault project found for "${path.basename(cwd)}". ` +
      `To fix: ensure your project folder name matches the repo name in 01-Projects/, ` +
      `or add "# PKM: 01-Projects/YourProject" to your project's CLAUDE.md.`
  };
}
