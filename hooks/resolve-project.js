// IMPORTANT: Hooks run via raw `node` from the installed plugin directory,
// which has no node_modules. All functions here MUST be self-contained —
// do NOT import from ../helpers.js, ../utils.js or ../frontmatter.js (they depend on the yaml package).
// Only relative and node: imports are allowed; tests/manifest.test.js enforces this.
import fs from "node:fs/promises";
import path from "node:path";

function assertPathWithinVault(relativePath, vaultPath) {
  const base = path.resolve(vaultPath);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Path escapes vault directory");
  }
}

/**
 * Reduce any git remote URL form to a lowercase "host/owner/repo" key.
 * Credentials and ports are dropped, so the result is safe to show to users.
 *
 * @param {unknown} url
 * @returns {string} "" for non-strings and blank input
 */
export function normalizeRemote(url) {
  if (typeof url !== "string") return "";
  let rest = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Credentials end at the last "@" before the first "/" (scp-style has no scheme to anchor on).
  const slash = rest.indexOf("/");
  const authorityEnd = slash === -1 ? rest.length : slash;
  const at = rest.lastIndexOf("@", authorityEnd);
  if (at !== -1) rest = rest.slice(at + 1);
  return rest
    .replace(/^([^/:]+):\d+(?=\/|$)/, "$1")
    .replace(/^([^/:]+):/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export async function resolveProject(cwd, vaultPath) {
  try {
    await fs.access(vaultPath);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { error: `VAULT_PATH does not exist: ${vaultPath}` };
    }
    return { error: `Cannot access VAULT_PATH (${e.code}): ${vaultPath}` };
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
  } catch (e) {
    if (e.code !== "ENOENT") {
      return { error: `Error reading 01-Projects/: ${e.message}` };
    }
    // 01-Projects/ doesn't exist -- fall through to CLAUDE.md check
  }

  try {
    const claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    const match = claudeMd.match(/^#\s+PKM:\s*(.+)$/m);
    if (match) {
      const annotatedPath = match[1].trim();
      try {
        assertPathWithinVault(annotatedPath, vaultPath);
      } catch (e) {
        if (e.message === "Path escapes vault directory") {
          return { error: `CLAUDE.md annotation escapes vault directory: ${annotatedPath}` };
        }
        throw e;
      }
      try {
        await fs.access(path.join(vaultPath, annotatedPath));
        return { projectPath: annotatedPath };
      } catch (e) {
        if (e.code === "ENOENT") {
          return { error: `CLAUDE.md annotation points to non-existent vault path: ${annotatedPath}` };
        }
        return { error: `Cannot access annotated vault path (${e.code}): ${annotatedPath}` };
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "EACCES") {
      return { error: `Error reading CLAUDE.md: ${e.message}` };
    }
    // No CLAUDE.md or not readable -- fall through
  }

  return {
    error: `No vault project found for "${path.basename(cwd)}". ` +
      `To fix: ensure your project folder name matches the repo name in 01-Projects/, ` +
      `or add "# PKM: 01-Projects/YourProject" to your project's CLAUDE.md.`
  };
}
