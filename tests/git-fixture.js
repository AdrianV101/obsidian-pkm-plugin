// Real git in throwaway repos. The identity and settings go on every call, so the
// developer's global config (default branch, commit signing) can't change the result.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const GIT_SETTINGS = [
  "-c", "user.email=test@example.com",
  "-c", "user.name=Test",
  "-c", "init.defaultBranch=main",
  "-c", "commit.gpgsign=false",
];

/**
 * Run git in `cwd` and return its stdout. Throws when git exits non-zero.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  return execFileSync("git", [...GIT_SETTINGS, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Create a repo at `dir` with one empty commit, so worktrees can be added, and
 * the given remotes, added (and so configured) in the object's key order.
 *
 * @param {string} dir
 * @param {Record<string, string>} [remotes] remote name -> URL
 * @returns {Promise<string>} dir
 */
export async function makeRepo(dir, remotes = {}) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "init");
  for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
  return dir;
}

/**
 * Create `01-Projects/<name>/_index.md` in the vault, with `extraFrontmatter`
 * (raw YAML lines, e.g. "repos: [github.com/o/r]") added to its frontmatter.
 *
 * @param {string} vaultPath
 * @param {string} name
 * @param {string} [extraFrontmatter]
 * @returns {Promise<string>} the project folder
 */
export async function makeProject(vaultPath, name, extraFrontmatter = "") {
  const dir = path.join(vaultPath, "01-Projects", name);
  await fs.mkdir(dir, { recursive: true });
  const extra = extraFrontmatter && !extraFrontmatter.endsWith("\n") ? `${extraFrontmatter}\n` : extraFrontmatter;
  await fs.writeFile(
    path.join(dir, "_index.md"),
    `---\ntype: project\ncreated: 2026-01-01\ntags: [project]\n${extra}---\n# ${name}\n`,
  );
  return dir;
}
