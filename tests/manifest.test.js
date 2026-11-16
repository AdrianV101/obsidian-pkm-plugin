import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createToolsList } from "../tools.js";
import { createHandlers } from "../handlers.js";
import { extractFrontmatter } from "../utils.js";
import { readPackageSpec } from "../upgrade-checks.js";

const ROOT = path.join(import.meta.dirname, "..");

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf-8"));
}

async function exists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Every string value nested anywhere inside `value`. */
function allStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

/** Every hook object (one with a `type`) under a parsed hooks.json. */
function hookEntries(hooksJson) {
  const hooks = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      if (typeof value.type === "string") hooks.push(value);
      else Object.values(value).forEach(walk);
    }
  };
  walk(hooksJson);
  return hooks;
}

const STATIC_FROM_RE = /^\s*(?:import|export)\b[^"'`;()]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Module specifiers imported or re-exported by `source`. */
function importSpecifiers(source) {
  const specs = [];
  for (const re of [STATIC_FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    for (const match of source.matchAll(re)) specs.push(match[1]);
  }
  return specs;
}

/**
 * Walks the static and dynamic imports from `entries`.
 * @returns {Promise<{ files: string[], violations: string[] }>} every module reached, and each
 *   specifier that is bare or does not resolve
 */
async function importClosure(entries) {
  const queue = [...entries];
  const seen = new Set();
  const violations = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(file, "utf-8");
    for (const spec of importSpecifiers(source)) {
      const where = `${path.relative(ROOT, file)}: "${spec}"`;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        violations.push(`${where} is a bare specifier`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      if (!(await exists(target))) violations.push(`${where} does not resolve to a file`);
      else if (/\.m?js$/.test(target)) queue.push(target);
    }
  }
  return { files: [...seen], violations };
}

describe("plugin manifest contracts", () => {
  it("package.json and .claude-plugin/plugin.json declare the same version", async () => {
    const pkg = await readJson("package.json");
    const plugin = await readJson(".claude-plugin/plugin.json");
    assert.equal(plugin.version, pkg.version);
  });

  it("plugin.json starts exactly the server version it ships with, so the code that runs is the code released", async () => {
    const pkg = await readJson("package.json");
    const plugin = await readJson(".claude-plugin/plugin.json");
    assert.deepEqual(plugin.mcpServers["vault-pkm"].args, ["-y", `obsidian-pkm@${pkg.version}`]);
  });

  it("the upgrade prompt reads the server's npm spec from plugin.json", async () => {
    const plugin = await readJson(".claude-plugin/plugin.json");
    const spec = plugin.mcpServers["vault-pkm"].args.find((arg) => /^obsidian-pkm(@\S+)?$/.test(arg));
    assert.ok(spec, "plugin.json starts no obsidian-pkm server");
    assert.equal(await readPackageSpec(), spec);
  });

  it("every ${CLAUDE_PLUGIN_ROOT} path in plugin.json and hooks/hooks.json exists", async () => {
    const refs = [];
    for (const manifest of [".claude-plugin/plugin.json", "hooks/hooks.json"]) {
      const json = await readJson(manifest);
      for (const str of allStrings(json)) {
        for (const match of str.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/g)) {
          refs.push({ manifest, rel: match[1] });
        }
      }
    }
    assert.ok(refs.length > 0, "expected at least one ${CLAUDE_PLUGIN_ROOT} reference");
    const missing = [];
    for (const { manifest, rel } of refs) {
      if (!(await exists(path.join(ROOT, rel)))) missing.push(`${manifest} -> ${rel}`);
    }
    assert.deepEqual(missing, []);
  });

  it("tools.js advertises exactly the tools that createHandlers implements", async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-manifest-"));
    try {
      const handlers = await createHandlers({
        vaultPath: vault,
        templateRegistry: new Map(),
        semanticIndex: null,
        activityLog: null,
        sessionId: "manifest-test",
      });
      const advertised = createToolsList("", [], true).map((t) => t.name).sort();
      assert.deepEqual(advertised, [...handlers.keys()].sort());
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it("every skill, agent and command file has frontmatter with its required string fields", async () => {
    const files = [];
    for (const dir of await fs.readdir(path.join(ROOT, "skills"))) {
      files.push({ rel: `skills/${dir}/SKILL.md`, required: ["name", "description"] });
    }
    for (const name of await fs.readdir(path.join(ROOT, "agents"))) {
      if (name.endsWith(".md")) files.push({ rel: `agents/${name}`, required: ["name", "description"] });
    }
    for (const name of await fs.readdir(path.join(ROOT, "commands"))) {
      if (name.endsWith(".md")) files.push({ rel: `commands/${name}`, required: ["description"] });
    }
    for (const kind of ["skills/", "agents/", "commands/"]) {
      assert.ok(files.some((f) => f.rel.startsWith(kind)), `no files found under ${kind}`);
    }

    const problems = [];
    for (const { rel, required } of files) {
      const fm = extractFrontmatter(await fs.readFile(path.join(ROOT, rel), "utf-8"));
      if (!fm || typeof fm !== "object") {
        problems.push(`${rel}: missing or unparseable frontmatter`);
        continue;
      }
      for (const key of required) {
        if (typeof fm[key] !== "string" || fm[key].trim() === "") problems.push(`${rel}: "${key}" must be a non-empty string`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("hooks and every module they import use only relative or node: specifiers", async () => {
    const hookDir = path.join(ROOT, "hooks");
    const hooks = (await fs.readdir(hookDir)).filter((f) => f.endsWith(".js")).map((f) => path.join(hookDir, f));
    assert.ok(hooks.length > 0, "no hook scripts found");
    assert.deepEqual((await importClosure(hooks)).violations, []);
  });

  describe("migrate-devlog runs without node_modules", () => {
    it("migrate-devlog.js and every module it imports use only relative or node: specifiers", async () => {
      const { files, violations } = await importClosure([path.join(ROOT, "migrate-devlog.js")]);
      assert.deepEqual(violations, []);
      assert.ok(files.length > 1, "expected the migration to import the devlog parser");
    });

    it("previews from a plugin-root copy holding only cli.js, package.json, the migration's modules and the hub template", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pkm manifest "));
      try {
        const pluginRoot = path.join(tmp, "plugin root");
        const vault = path.join(tmp, "my vault");
        const { files } = await importClosure([path.join(ROOT, "migrate-devlog.js")]);
        for (const rel of ["cli.js", "package.json", "templates/devlog.md", ...files.map((f) => path.relative(ROOT, f))]) {
          await fs.mkdir(path.dirname(path.join(pluginRoot, rel)), { recursive: true });
          await fs.copyFile(path.join(ROOT, rel), path.join(pluginRoot, rel));
        }
        const devlog = path.join(vault, "01-Projects", "Demo", "development", "devlog.md");
        await fs.mkdir(path.dirname(devlog), { recursive: true });
        await fs.writeFile(devlog, "# Development Log\n\n### 2026-10-27 09:14 First\n- a\n\n### 2026-10-26 10:00 Second\n- b\n");

        const result = spawnSync(process.execPath, [path.join(pluginRoot, "cli.js"), "migrate-devlog", "Demo"], {
          cwd: tmp,
          encoding: "utf-8",
          env: { ...process.env, VAULT_PATH: vault },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Cannot find (module|package)/);
        assert.match(result.stdout, /^Preview only; nothing was written\. Run with --apply to migrate\.$/m);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("every hook runs node on a file the plugin ships, named in args", () => {
    it("gives node as the command and only ${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js in args, with no shell text or other variable", async () => {
      const hooks = hookEntries(await readJson("hooks/hooks.json"));
      assert.ok(hooks.length > 0, "expected at least one hook");
      for (const hook of hooks) {
        assert.equal(hook.type, "command", JSON.stringify(hook));
        assert.equal(hook.command, "node", JSON.stringify(hook));
        assert.ok(Array.isArray(hook.args) && hook.args.length === 1, JSON.stringify(hook));
        assert.match(hook.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.js$/, JSON.stringify(hook));
      }
    });

    it("runs the SessionStart command with a space in both the plugin root and the vault path", { skip: process.platform === "win32" }, async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pkm manifest "));
      try {
        const pluginRoot = path.join(tmp, "plugin root");
        const vault = path.join(tmp, "my vault");
        await fs.mkdir(pluginRoot);
        await fs.mkdir(vault);
        await fs.cp(path.join(ROOT, "hooks"), path.join(pluginRoot, "hooks"), { recursive: true });
        // Dependency-free modules the hook imports from the plugin root.
        const { files } = await importClosure([path.join(ROOT, "hooks", "session-start.js")]);
        for (const rel of files.map((f) => path.relative(ROOT, f)).filter((rel) => !rel.startsWith(`hooks${path.sep}`))) {
          await fs.copyFile(path.join(ROOT, rel), path.join(pluginRoot, rel));
        }

        const [hook] = hookEntries((await readJson("hooks/hooks.json")).hooks.SessionStart);
        const args = hook.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot));

        // Run as Claude Code runs a hook given as command and args: no shell, the vault from the environment.
        const result = spawnSync(process.execPath, args, {
          input: JSON.stringify({ cwd: tmp, session_id: "manifest-test", transcript_path: path.join(tmp, "t.jsonl") }),
          encoding: "utf-8",
          // A home without .claude/settings.json, so the hook never reads the real one.
          env: { ...process.env, HOME: tmp, USERPROFILE: tmp, VAULT_PATH: vault },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Cannot find module/);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});
