// IMPORTANT: Hooks run via raw `node` from the installed plugin directory,
// which has no node_modules. Only relative and node: imports are allowed here,
// and ../markdown.js is dependency-free for that reason; tests/manifest.test.js enforces this.
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { splitFrontmatter, frontmatterList } from "../markdown.js";

const GIT_TIMEOUT_MS = 2000;
const INDEX_READ_BYTES = 8192;
const PROJECTS_DIR = "01-Projects";
const ANNOTATION_FILES = ["CLAUDE.local.md", "CLAUDE.md", path.join(".claude", "CLAUDE.md")];
const ANNOTATION_RE = /^#[ \t]+PKM:[ \t]*(\S[^\r\n]*?)[ \t]*\r?$/m;

/**
 * @typedef {object} ProjectResolution
 * @property {string|null} projectPath vault-relative and "/"-separated, e.g. "01-Projects/MyApp"
 * @property {boolean} inGitRepo
 * @property {"annotation"|"repos"|"folder"} [via]
 * @property {string} [detail] the annotation file's path, the normalised remote, or the folder name
 * @property {"no-vault"|"invalid-annotation"|"ambiguous"|"no-match"} [code] set when projectPath is null
 * @property {string} [reason] human-readable, set when projectPath is null
 */

/**
 * @typedef {object} GitFacts
 * @property {string} topLevel
 * @property {string} mainRoot the main checkout's root, which differs from topLevel in a linked worktree
 * @property {string[]} remotes URLs, origin's first, then the rest in config order
 */

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

/** Path comparisons go through path.relative, which is case-insensitive on Windows. */
function samePath(a, b) {
  return path.relative(a, b) === "";
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The realpath when it exists. git reports realpaths, so cwd and home must be
 * canonical too (macOS /var -> /private/var, Windows 8.3 short names).
 */
async function canonical(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** @returns {Promise<{ error: (Error & { code?: unknown }) | null, stdout: string }>} */
function runGit(git, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(git, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      resolve({ error, stdout: String(stdout ?? "") });
    });
  });
}

/** @returns {Promise<GitFacts|null>} null when git is missing, times out, or cwd is not in a work tree */
async function gitFacts(cwd, git, timeoutMs) {
  const [revParse, config] = await Promise.all([
    runGit(git, ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], timeoutMs),
    runGit(git, ["-C", cwd, "config", "--get-regexp", "^remote\\..*\\.url$"], timeoutMs),
  ]);
  // config --get-regexp exits 1 when no key matches, i.e. a repo without remotes.
  const noRemotes = config.error?.code === 1 && config.stdout === "";
  if (revParse.error || (config.error && !noRemotes)) return null;

  // git < 2.31 echoes the unknown --path-format option and may print a relative common dir.
  const lines = revParse.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const [top, commonDir] = lines.slice(-2).map((line) => path.resolve(cwd, line));
  const topLevel = await canonical(top);
  const mainRoot = path.basename(commonDir) === ".git" ? await canonical(path.dirname(commonDir)) : topLevel;
  return { topLevel, mainRoot, remotes: orderRemotes(config.stdout) };
}

function orderRemotes(configOutput) {
  const remotes = [];
  for (const line of configOutput.split(/\r?\n/)) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line);
    if (match) remotes.push({ name: match[1], url: match[2] });
  }
  return [
    ...remotes.filter((r) => r.name === "origin"),
    ...remotes.filter((r) => r.name !== "origin"),
  ].map((r) => r.url);
}

/** @returns {Promise<string|null>} the problem with the vault path, or null when it is a folder */
async function vaultProblem(vaultPath) {
  try {
    return (await fs.stat(vaultPath)).isDirectory() ? null : `VAULT_PATH is not a folder: ${vaultPath}`;
  } catch (e) {
    return e.code === "ENOENT"
      ? `VAULT_PATH does not exist: ${vaultPath}`
      : `cannot access VAULT_PATH (${e.code}): ${vaultPath}`;
  }
}

/**
 * Directories whose CLAUDE files may carry the annotation, nearest first:
 * cwd up to the top level, then the main checkout root. Outside git, cwd only.
 * Home is excluded, so ~/.claude/CLAUDE.md can never act as an annotation.
 */
function annotationDirs(cwd, facts, home) {
  const dirs = [cwd];
  if (facts && isWithin(cwd, facts.topLevel)) {
    for (let dir = cwd; !samePath(dir, facts.topLevel); ) {
      dir = path.dirname(dir);
      dirs.push(dir);
    }
  }
  if (facts && !dirs.some((dir) => samePath(dir, facts.mainRoot))) dirs.push(facts.mainRoot);
  return home ? dirs.filter((dir) => !samePath(dir, home)) : dirs;
}

/** @returns {Promise<{ file: string, value: string }|null>} the first annotation found */
async function findAnnotation(dirs) {
  for (const dir of dirs) {
    for (const name of ANNOTATION_FILES) {
      const file = path.join(dir, name);
      let text;
      try {
        text = await fs.readFile(file, "utf-8");
      } catch {
        continue;
      }
      const match = ANNOTATION_RE.exec(text.replace(/^\uFEFF/, ""));
      if (match) return { file, value: match[1] };
    }
  }
  return null;
}

/**
 * An explicit annotation is never silently overridden: when invalid, resolution stops here.
 *
 * @returns {Promise<ProjectResolution>}
 */
async function resolveAnnotation({ file, value }, vaultRoot, inGitRepo) {
  /** @type {(problem: string) => ProjectResolution} */
  const invalid = (problem) => ({
    projectPath: null,
    inGitRepo,
    code: "invalid-annotation",
    reason: `the # PKM annotation in ${file} ${problem}`,
  });
  const target = path.resolve(vaultRoot, value.replace(/\\/g, "/"));
  if (!isWithin(target, vaultRoot)) return invalid(`points outside the vault: ${value}`);
  const relative = path.relative(vaultRoot, target);
  if (relative === "") return invalid(`names the vault root, not a project folder: ${value}`);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR"
      ? invalid(`names a folder that does not exist in the vault: ${value}`)
      : invalid(`names a folder that cannot be read (${e.code}): ${value}`);
  }
  if (!stat.isDirectory()) return invalid(`names a file, not a folder: ${value}`);
  return { projectPath: relative.split(path.sep).join("/"), inGitRepo, via: "annotation", detail: file };
}

/** Project folder names under 01-Projects, dot-folders excluded. */
async function listProjects(vaultRoot) {
  try {
    const entries = await fs.readdir(path.join(vaultRoot, PROJECTS_DIR), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The normalised `repos:` entries of a project's _index.md, reading only its first 8 KB. */
async function projectRepos(vaultRoot, name) {
  let handle;
  try {
    handle = await fs.open(path.join(vaultRoot, PROJECTS_DIR, name, "_index.md"), "r");
    const buffer = Buffer.alloc(INDEX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, INDEX_READ_BYTES, 0);
    const { frontmatterText } = splitFrontmatter(buffer.toString("utf8", 0, bytesRead));
    return frontmatterList(frontmatterText, "repos").map(normalizeRemote).filter(Boolean);
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

/**
 * The first remote any project lists decides; a remote listed by two projects is ambiguous.
 *
 * @returns {Promise<ProjectResolution|null>} null when no project lists any remote
 */
async function matchRepos(vaultRoot, projects, remotes, inGitRepo) {
  const repoLists = await Promise.all(projects.map((name) => projectRepos(vaultRoot, name)));
  /** @type {Map<string, Set<string>>} */
  const listedBy = new Map();
  projects.forEach((name, i) => {
    for (const key of repoLists[i]) listedBy.set(key, (listedBy.get(key) ?? new Set()).add(name));
  });
  for (const url of remotes) {
    const key = normalizeRemote(url);
    const names = [...(listedBy.get(key) ?? [])].sort();
    if (names.length === 1) {
      return { projectPath: `${PROJECTS_DIR}/${names[0]}`, inGitRepo, via: "repos", detail: key };
    }
    if (names.length > 1) {
      const projectPaths = names.map((name) => `${PROJECTS_DIR}/${name}`).join(" and ");
      return {
        projectPath: null,
        inGitRepo,
        code: "ambiguous",
        reason: `remote ${key} is listed in the repos: of more than one project: ${projectPaths}`,
      };
    }
  }
  return null;
}

/**
 * Map a working directory to a vault project: a `# PKM:` annotation, then a
 * `repos:` entry matching a git remote, then the main checkout's folder name.
 *
 * @param {string} cwd
 * @param {string} vaultPath
 * @param {{ git?: string, timeoutMs?: number, home?: string }} [options] git binary, per-call git timeout, home directory
 * @returns {Promise<ProjectResolution>}
 */
export async function resolveProject(cwd, vaultPath, { git = "git", timeoutMs = GIT_TIMEOUT_MS, home = os.homedir() } = {}) {
  const vaultRoot = path.resolve(vaultPath);
  const [facts, problem, start, homeDir] = await Promise.all([
    gitFacts(cwd, git, timeoutMs),
    vaultProblem(vaultPath),
    canonical(cwd),
    home ? canonical(home) : null,
  ]);
  const inGitRepo = facts !== null;
  if (problem) return { projectPath: null, inGitRepo, code: "no-vault", reason: problem };

  const annotation = await findAnnotation(annotationDirs(start, facts, homeDir));
  if (annotation) return resolveAnnotation(annotation, vaultRoot, inGitRepo);

  const projects = await listProjects(vaultRoot);
  if (facts && facts.remotes.length > 0) {
    const byRemote = await matchRepos(vaultRoot, projects, facts.remotes, inGitRepo);
    if (byRemote) return byRemote;
  }

  const folder = path.basename(facts ? facts.mainRoot : path.resolve(cwd));
  const project = projects.find((name) => name.toLowerCase() === folder.toLowerCase());
  if (project) return { projectPath: `${PROJECTS_DIR}/${project}`, inGitRepo, via: "folder", detail: folder };

  return {
    projectPath: null,
    inGitRepo,
    code: "no-match",
    reason: "no # PKM annotation, repos: entry or project folder name matches",
  };
}

/**
 * How a resolution was found, for user-facing summaries; "" when unresolved.
 *
 * @param {ProjectResolution} resolution
 * @returns {string}
 */
export function describeVia(resolution) {
  switch (resolution.via) {
    case "repos":
      return `via repos: ${resolution.detail}`;
    case "folder":
      return `via folder name: ${resolution.detail}`;
    case "annotation":
      return `via # PKM in ${withTilde(resolution.detail)}`;
    default:
      return "";
  }
}

function withTilde(file) {
  const home = os.homedir();
  if (!home || !isWithin(file, home) || samePath(file, home)) return file;
  return path.join("~", path.relative(home, file));
}
