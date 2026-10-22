import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveProject, describeVia, normalizeRemote } from "../hooks/resolve-project.js";
import { git, makeRepo, makeProject } from "./git-fixture.js";

const POSIX_ONLY = { skip: process.platform === "win32" ? "needs POSIX symlinks and shell scripts" : false };

describe("resolveProject", () => {
  let tmp; // as created; on macOS it sits under the /var -> /private/var symlink
  let real; // tmp's canonical path, the form git and the resolver report
  let vault;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-project-"));
    real = await fs.realpath(tmp);
    vault = path.join(tmp, "vault");
    await fs.mkdir(path.join(vault, "01-Projects"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Resolve against `vault`, with a home directory no test annotates unless it means to. */
  function resolve(cwd, options = {}) {
    return resolveProject(cwd, vault, { home: path.join(tmp, "home"), ...options });
  }

  /** The canonical form of a path under tmp. */
  function canon(p) {
    return path.join(real, path.relative(tmp, p));
  }

  async function write(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  async function mkdir(dir) {
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  function assertUnresolved(result, code, inGitRepo, label) {
    assert.equal(result.projectPath, null, label);
    assert.equal(result.code, code, label);
    assert.equal(result.inGitRepo, inGitRepo, label);
    assert.equal(result.via, undefined, label);
    assert.equal(typeof result.reason, "string", label);
    assert.notEqual(result.reason, "", label);
  }

  it("an annotation beats a repos: match and a folder-name match", async () => {
    await makeProject(vault, "MyApp");
    await makeProject(vault, "ByRemote", "repos: [github.com/owner/repo]");
    await makeProject(vault, "Annotated");
    const repo = await makeRepo(path.join(tmp, "myapp"), { origin: "git@github.com:owner/repo.git" });
    await write(path.join(repo, "CLAUDE.md"), "# Repo\n\n# PKM: 01-Projects/Annotated\n");

    assert.deepEqual(await resolve(repo), {
      projectPath: "01-Projects/Annotated",
      inGitRepo: true,
      via: "annotation",
      detail: canon(path.join(repo, "CLAUDE.md")),
    });
  });

  const PER_DIRECTORY_ORDER = [
    {
      name: "CLAUDE.local.md beats CLAUDE.md and .claude/CLAUDE.md",
      files: { "CLAUDE.local.md": "Local", "CLAUDE.md": "Shared", ".claude/CLAUDE.md": "Dotclaude" },
      expected: ["CLAUDE.local.md", "Local"],
    },
    {
      name: "CLAUDE.md beats .claude/CLAUDE.md",
      files: { "CLAUDE.md": "Shared", ".claude/CLAUDE.md": "Dotclaude" },
      expected: ["CLAUDE.md", "Shared"],
    },
    {
      name: ".claude/CLAUDE.md is used when it is the only annotation",
      files: { ".claude/CLAUDE.md": "Dotclaude" },
      expected: [".claude/CLAUDE.md", "Dotclaude"],
    },
    {
      name: "a CLAUDE.local.md without a # PKM line doesn't hide CLAUDE.md's annotation",
      files: { "CLAUDE.local.md": null, "CLAUDE.md": "Shared" },
      expected: ["CLAUDE.md", "Shared"],
    },
  ];
  for (const c of PER_DIRECTORY_ORDER) {
    it(`in one directory, the CLAUDE files are checked in a fixed order: ${c.name}`, async () => {
      for (const name of ["Local", "Shared", "Dotclaude"]) await makeProject(vault, name);
      const dir = await mkdir(path.join(tmp, "work"));
      for (const [file, project] of Object.entries(c.files)) {
        await write(path.join(dir, file), project ? `# PKM: 01-Projects/${project}\n` : "# Local notes\n");
      }

      const result = await resolve(dir);
      assert.equal(result.projectPath, `01-Projects/${c.expected[1]}`);
      assert.equal(result.via, "annotation");
      assert.equal(result.detail, canon(path.join(dir, c.expected[0])));
    });
  }

  const WALK_UP = [
    {
      name: "a parent directory's annotation is found",
      files: { "CLAUDE.local.md": "Top" },
      expected: ["CLAUDE.local.md", "Top"],
    },
    {
      name: "a nearer directory's .claude/CLAUDE.md beats the top level's CLAUDE.local.md",
      files: { "CLAUDE.local.md": "Top", "packages/.claude/CLAUDE.md": "Nearer" },
      expected: ["packages/.claude/CLAUDE.md", "Nearer"],
    },
  ];
  for (const c of WALK_UP) {
    it(`from a nested folder, the nearest annotation up to the repo top level wins: ${c.name}`, async () => {
      await makeProject(vault, "Top");
      await makeProject(vault, "Nearer");
      const repo = await makeRepo(path.join(tmp, "repo"));
      const cwd = await mkdir(path.join(repo, "packages", "web", "src"));
      for (const [file, project] of Object.entries(c.files)) {
        await write(path.join(repo, file), `# PKM: 01-Projects/${project}\n`);
      }

      assert.deepEqual(await resolve(cwd), {
        projectPath: `01-Projects/${c.expected[1]}`,
        inGitRepo: true,
        via: "annotation",
        detail: canon(path.join(repo, c.expected[0])),
      });
    });
  }

  it("an annotation above the repo top level is ignored", async () => {
    await makeProject(vault, "Outer");
    const outer = await mkdir(path.join(tmp, "outer"));
    await write(path.join(outer, "CLAUDE.md"), "# PKM: 01-Projects/Outer\n");
    const repo = await makeRepo(path.join(outer, "repo"));
    const cwd = await mkdir(path.join(repo, "src"));

    assertUnresolved(await resolve(cwd), "no-match", true);
  });

  it("a linked worktree uses an annotation that exists only in the main checkout's untracked CLAUDE.local.md", async () => {
    await makeProject(vault, "FromMain");
    const main = await makeRepo(path.join(tmp, "main-checkout"));
    await write(path.join(main, "CLAUDE.local.md"), "# PKM: 01-Projects/FromMain\n");
    const worktree = path.join(main, ".claude", "worktrees", "feature");
    git(main, "worktree", "add", "-b", "feature", worktree);
    const cwd = await mkdir(path.join(worktree, "src"));

    assert.deepEqual(await resolve(cwd), {
      projectPath: "01-Projects/FromMain",
      inGitRepo: true,
      via: "annotation",
      detail: canon(path.join(main, "CLAUDE.local.md")),
    });
  });

  const OUTSIDE_GIT = [
    { name: "a parent's annotation is ignored", annotated: "parent", expected: null },
    { name: "cwd's annotation is used", annotated: "parent/child", expected: "01-Projects/Plain" },
  ];
  for (const c of OUTSIDE_GIT) {
    it(`outside git only cwd is searched: ${c.name}`, async () => {
      await makeProject(vault, "Plain");
      const cwd = await mkdir(path.join(tmp, "parent", "child"));
      const file = path.join(tmp, c.annotated, "CLAUDE.md");
      await write(file, "# PKM: 01-Projects/Plain\n");

      const result = await resolve(cwd);
      if (c.expected === null) {
        assertUnresolved(result, "no-match", false);
      } else {
        assert.deepEqual(result, { projectPath: c.expected, inGitRepo: false, via: "annotation", detail: canon(file) });
      }
    });
  }

  const HOME_CASES = [
    { name: "cwd is home, outside git", inGitRepo: false, cwd: (home) => home },
    { name: "home is the repo top level above cwd", inGitRepo: true, cwd: (home) => path.join(home, "notes") },
    { name: "cwd is home and home is a repo", inGitRepo: true, cwd: (home) => home },
  ];
  for (const c of HOME_CASES) {
    it(`home is never searched, even when it is cwd: ${c.name}`, async () => {
      await makeProject(vault, "Home");
      const home = path.join(tmp, "user-home");
      if (c.inGitRepo) await makeRepo(home);
      for (const file of ["CLAUDE.local.md", "CLAUDE.md", ".claude/CLAUDE.md"]) {
        await write(path.join(home, file), "# PKM: 01-Projects/Home\n");
      }
      const cwd = await mkdir(c.cwd(home));

      assertUnresolved(await resolve(cwd, { home }), "no-match", c.inGitRepo);
    });
  }

  const INVALID_ANNOTATIONS = [
    { name: "outside the vault", value: "../outside", problem: /outside the vault/ },
    { name: "a missing folder", value: "01-Projects/Missing", problem: /does not exist/ },
    { name: "the vault root", value: ".", problem: /vault root/ },
    { name: "a file instead of a folder", value: "01-Projects/Linked/_index.md", problem: /not a folder/ },
  ];
  for (const c of INVALID_ANNOTATIONS) {
    it(`an invalid annotation stops resolution, naming the file and the problem, even with a repos: match: ${c.name}`, async () => {
      await makeProject(vault, "Linked", "repos: [github.com/owner/repo]");
      await mkdir(path.join(tmp, "outside"));
      const repo = await makeRepo(path.join(tmp, "linked"), { origin: "https://github.com/owner/repo.git" });
      const file = path.join(repo, "CLAUDE.md");
      await write(file, `# PKM: ${c.value}\n`);

      const result = await resolve(repo);
      assertUnresolved(result, "invalid-annotation", true);
      assert.ok(result.reason.includes(canon(file)), result.reason);
      assert.match(result.reason, c.problem);
    });
  }

  const ANNOTATION_FORMATS = [
    { name: "a trailing slash", file: "CLAUDE.md", content: "# PKM: 01-Projects/MyApp/\n" },
    { name: "backslashes", file: "CLAUDE.md", content: "# PKM: 01-Projects\\MyApp\n" },
    { name: "CRLF line endings", file: "CLAUDE.md", content: "# Notes\r\n# PKM: 01-Projects/MyApp\r\nMore text\r\n" },
    { name: "a UTF-8 BOM", file: "CLAUDE.md", content: "\uFEFF# PKM: 01-Projects/MyApp\n" },
    { name: "an annotation in .claude/CLAUDE.md", file: ".claude/CLAUDE.md", content: "# PKM: 01-Projects/MyApp\n" },
  ];
  for (const c of ANNOTATION_FORMATS) {
    it(`annotation formats normalise to the same project: ${c.name}`, async () => {
      await makeProject(vault, "MyApp");
      const dir = await mkdir(path.join(tmp, "work"));
      await write(path.join(dir, c.file), c.content);

      assert.deepEqual(await resolve(dir), {
        projectPath: "01-Projects/MyApp",
        inGitRepo: false,
        via: "annotation",
        detail: canon(path.join(dir, c.file)),
      });
    });
  }

  it("from a repo subfolder, origin in one URL form matches a repos: entry in another form", async () => {
    await makeProject(vault, "Linked", "repos:\n  - https://github.com/Owner/Repo\n");
    const repo = await makeRepo(path.join(tmp, "checkout-dir"), { origin: "git@github.com:owner/repo.git" });
    const cwd = await mkdir(path.join(repo, "packages", "web"));

    assert.deepEqual(await resolve(cwd), {
      projectPath: "01-Projects/Linked",
      inGitRepo: true,
      via: "repos",
      detail: "github.com/owner/repo",
    });
  });

  const REMOTE_ORDER = [
    {
      name: "origin wins over an earlier-configured remote",
      remotes: {
        upstream: "https://github.com/team/zeta-repo.git",
        origin: "https://github.com/team/origin-repo.git",
      },
      expected: ["ViaOrigin", "github.com/team/origin-repo"],
    },
    {
      name: "without an origin match, the first matching remote in config order decides",
      remotes: {
        origin: "https://github.com/team/unlisted.git",
        zeta: "https://github.com/team/zeta-repo.git",
        alpha: "https://github.com/team/alpha-repo.git",
      },
      expected: ["ViaZeta", "github.com/team/zeta-repo"],
    },
  ];
  for (const c of REMOTE_ORDER) {
    it(`remotes are tried origin first, then in config order: ${c.name}`, async () => {
      await makeProject(vault, "ViaOrigin", "repos: [github.com/team/origin-repo]");
      await makeProject(vault, "ViaZeta", "repos: [github.com/team/zeta-repo]");
      await makeProject(vault, "ViaAlpha", "repos: [github.com/team/alpha-repo]");
      const repo = await makeRepo(path.join(tmp, "checkout"), c.remotes);

      assert.deepEqual(await resolve(repo), {
        projectPath: `01-Projects/${c.expected[0]}`,
        inGitRepo: true,
        via: "repos",
        detail: c.expected[1],
      });
    });
  }

  it("a remote listed by two projects gives ambiguous, naming both and the remote, with no folder-name fallback", async () => {
    await makeProject(vault, "First", "repos: [github.com/owner/shared]");
    await makeProject(vault, "Second", "repos:\n  - git@github.com:owner/shared.git\n");
    await makeProject(vault, "Shared-Checkout");
    const repo = await makeRepo(path.join(tmp, "shared-checkout"), { origin: "https://github.com/owner/shared" });

    const result = await resolve(repo);
    assertUnresolved(result, "ambiguous", true);
    for (const part of ["01-Projects/First", "01-Projects/Second", "github.com/owner/shared"]) {
      assert.ok(result.reason.includes(part), `${part} missing from: ${result.reason}`);
    }
  });

  const REMOTE = "github.com/owner/repo";
  const UNMATCHABLE_PROJECTS = [
    {
      name: "a dot-folder",
      make: (v) => fs.mkdir(path.join(v, "01-Projects", ".hidden"))
        .then(() => fs.writeFile(path.join(v, "01-Projects", ".hidden", "_index.md"), `---\nrepos: [${REMOTE}]\n---\n`)),
    },
    {
      name: "no _index.md",
      make: (v) => fs.mkdir(path.join(v, "01-Projects", "Bare")),
    },
    {
      name: "an _index.md without frontmatter",
      make: (v) => fs.mkdir(path.join(v, "01-Projects", "Plain"))
        .then(() => fs.writeFile(path.join(v, "01-Projects", "Plain", "_index.md"), `# Plain\n\nrepos: [${REMOTE}]\n`)),
    },
    {
      name: "repos: beyond the first 8 KB",
      make: (v) => makeProject(v, "Long", `summary: ${"x".repeat(8192)}\nrepos: [${REMOTE}]`),
    },
  ];
  for (const c of UNMATCHABLE_PROJECTS) {
    it(`projects that can't match are skipped without error: ${c.name}`, async () => {
      await makeProject(vault, "Good", `repos: [${REMOTE}]`);
      await c.make(vault);
      const repo = await makeRepo(path.join(tmp, "checkout"), { origin: `https://${REMOTE}.git` });

      assert.deepEqual(await resolve(repo), {
        projectPath: "01-Projects/Good",
        inGitRepo: true,
        via: "repos",
        detail: REMOTE,
      });
    });
  }

  it("a worktree falls back to the main checkout's folder name, case-insensitively", async () => {
    await makeProject(vault, "MyApp");
    await makeProject(vault, "Feature-X");
    const main = await makeRepo(path.join(tmp, "myapp"));
    const worktree = path.join(main, ".claude", "worktrees", "feature-x");
    git(main, "worktree", "add", "-b", "feature-x", worktree);

    assert.deepEqual(await resolve(worktree), {
      projectPath: "01-Projects/MyApp",
      inGitRepo: true,
      via: "folder",
      detail: "myapp",
    });
  });

  it("outside git, cwd's folder name matches case-insensitively", async () => {
    await makeProject(vault, "MyApp");
    const cwd = await mkdir(path.join(tmp, "MYAPP"));

    assert.deepEqual(await resolve(cwd), {
      projectPath: "01-Projects/MyApp",
      inGitRepo: false,
      via: "folder",
      detail: "MYAPP",
    });
  });

  const NO_MATCH = [
    { name: "inside git", inGitRepo: true, make: (dir) => makeRepo(dir, { origin: "https://github.com/owner/unlisted" }) },
    { name: "outside git", inGitRepo: false, make: (dir) => mkdir(dir) },
  ];
  for (const c of NO_MATCH) {
    it(`no match gives no-match with a null projectPath and the right inGitRepo: ${c.name}`, async () => {
      await makeProject(vault, "Other", "repos: [github.com/owner/other]");
      const cwd = await c.make(path.join(tmp, "unlinked"));

      assertUnresolved(await resolve(cwd), "no-match", c.inGitRepo);
    });
  }

  /** A repo whose remote and folder name each match a different project. */
  async function repoMatchingByRemoteAndFolder() {
    await makeProject(vault, "ByRemote", "repos: [github.com/owner/repo]");
    await makeProject(vault, "MyApp");
    return makeRepo(path.join(tmp, "myapp"), { origin: "https://github.com/owner/repo.git" });
  }

  const NOT_A_GIT_REPO = { projectPath: "01-Projects/MyApp", inGitRepo: false, via: "folder", detail: "myapp" };

  it("a missing git binary is treated as not a git repo", async () => {
    const repo = await repoMatchingByRemoteAndFolder();

    assert.deepEqual(await resolve(repo, { git: path.join(tmp, "no-such-git") }), NOT_A_GIT_REPO);
  });

  it("a hanging git is cut off at timeoutMs and treated as not a git repo", POSIX_ONLY, async () => {
    const repo = await repoMatchingByRemoteAndFolder();
    const hangingGit = path.join(tmp, "hanging-git");
    // exec, so the timeout's kill reaches sleep itself; an orphaned sleep would hold stdout open.
    await fs.writeFile(hangingGit, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });

    const started = Date.now();
    const result = await resolve(repo, { git: hangingGit, timeoutMs: 200 });
    const elapsed = Date.now() - started;

    assert.deepEqual(result, NOT_A_GIT_REPO);
    assert.ok(elapsed < 15_000, `resolution took ${elapsed} ms`);
  });

  it("a missing vault gives no-vault, naming VAULT_PATH", async () => {
    const missing = path.join(tmp, "no-such-vault");
    const cwd = await mkdir(path.join(tmp, "work"));

    const result = await resolveProject(cwd, missing, { home: path.join(tmp, "home") });
    assertUnresolved(result, "no-vault", false);
    assert.ok(result.reason.includes("VAULT_PATH"), result.reason);
    assert.ok(result.reason.includes(missing), result.reason);
  });

  const SYMLINKED_PARENT = [
    { name: "an annotation between cwd and the top level is found", annotated: "repo/a", expected: "01-Projects/Linked" },
    { name: "an annotation in the symlinked parent, above the top level, is ignored", annotated: "", expected: null },
  ];
  for (const c of SYMLINKED_PARENT) {
    it(`through a symlinked parent, the walk climbs to the top level and stops there: ${c.name}`, POSIX_ONLY, async () => {
      await makeProject(vault, "Linked");
      const realParent = await mkdir(path.join(tmp, "real-parent"));
      const repo = await makeRepo(path.join(realParent, "repo"));
      await mkdir(path.join(repo, "a", "b"));
      const link = path.join(tmp, "link");
      await fs.symlink(realParent, link);
      const file = path.join(realParent, c.annotated, "CLAUDE.md");
      await write(file, "# PKM: 01-Projects/Linked\n");

      const result = await resolve(path.join(link, "repo", "a", "b"));
      if (c.expected === null) {
        assertUnresolved(result, "no-match", true);
      } else {
        assert.deepEqual(result, { projectPath: c.expected, inGitRepo: true, via: "annotation", detail: canon(file) });
      }
    });
  }
});

describe("describeVia", () => {
  const home = os.homedir();
  const elsewhere = path.join(path.parse(home).root, "srv", "app", "CLAUDE.md");
  const sibling = path.join(`${home}-other`, "app", "CLAUDE.md");
  const CASES = [
    { name: "a repos: match", via: "repos", detail: "github.com/owner/repo", expected: "via repos: github.com/owner/repo" },
    { name: "a folder-name match", via: "folder", detail: "myapp", expected: "via folder name: myapp" },
    {
      name: "an annotation under home, shown as ~",
      via: "annotation",
      detail: path.join(home, "code", "app", "CLAUDE.md"),
      expected: `via # PKM in ${path.join("~", "code", "app", "CLAUDE.md")}`,
    },
    { name: "an annotation elsewhere", via: "annotation", detail: elsewhere, expected: `via # PKM in ${elsewhere}` },
    {
      name: "an annotation in a folder that only shares home's prefix",
      via: "annotation",
      detail: sibling,
      expected: `via # PKM in ${sibling}`,
    },
  ];
  for (const c of CASES) {
    it(`labels ${c.name}`, () => {
      assert.equal(
        describeVia({ projectPath: "01-Projects/MyApp", inGitRepo: true, via: c.via, detail: c.detail }),
        c.expected,
      );
    });
  }
});

describe("normalizeRemote", () => {
  const KEY = "github.com/owner/repo";
  const forms = [
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo.git/",
    "http://github.com/owner/repo.git",
    "https://user:secret@github.com/owner/repo.git",
    "https://token@github.com/owner/repo",
    "ssh://git@github.com/owner/repo.git",
    "ssh://git@github.com:2222/owner/repo.git",
    "ssh://github.com/owner/repo",
    "git://github.com/owner/repo.git",
    "git+ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "github.com:owner/repo",
    "github.com/owner/repo",
    "HTTPS://GitHub.com/Owner/Repo.git",
    "  https://github.com/owner/repo.git\n",
  ];
  for (const form of forms) {
    it(`maps ${JSON.stringify(form)} to the shared key without credentials`, () => {
      const out = normalizeRemote(form);
      assert.equal(out, KEY);
      assert.doesNotMatch(out, /secret|token|@/);
    });
  }

  it("keeps extra path segments and keeps different repos distinct", () => {
    assert.equal(normalizeRemote("git@gitlab.com:group/sub/repo.git"), "gitlab.com/group/sub/repo");
    assert.equal(normalizeRemote("https://gitlab.com:8443/group/sub/repo"), "gitlab.com/group/sub/repo");
    assert.notEqual(normalizeRemote("github.com/a/repo"), normalizeRemote("github.com/b/repo"));
    assert.notEqual(normalizeRemote("github.com/a/repo"), normalizeRemote("gitlab.com/a/repo"));
  });

  for (const input of [undefined, null, 42, {}, "", "   \n"]) {
    it(`returns "" for ${JSON.stringify(input)}`, () => {
      assert.equal(normalizeRemote(input), "");
    });
  }
});
