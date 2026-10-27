import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { extractFrontmatter } from "../utils.js";
import { createToolsList } from "../tools.js";

// Claude Code names a plugin-bundled MCP tool mcp__plugin_<plugin>_<server>__<tool>
// (code.claude.com/docs/en/mcp, "Plugin MCP tool names"); plugin and server are both "vault-pkm".
const MCP_PREFIX = "mcp__plugin_vault-pkm_vault-pkm__";
const READ_VAULT_TOOLS = [
  "vault_read", "vault_peek", "vault_search", "vault_semantic_search", "vault_query",
  "vault_list", "vault_recent", "vault_links", "vault_neighborhood", "vault_link_health",
  "vault_suggest_links", "vault_tags",
];
// vault_activity is write-capable: action "clear" deletes log rows.
const WRITE_VAULT_TOOLS = [
  "vault_write", "vault_append", "vault_edit", "vault_update_frontmatter",
  "vault_add_links", "vault_move", "vault_trash", "vault_activity",
];
const WRITE_BUILTINS = ["Write", "Edit", "Bash"];
const SERVER_WIDE = ["mcp__*", "mcp__plugin_vault-pkm_vault-pkm", `${MCP_PREFIX}*`];

// agent -> the write-capable vault tools its documented job needs
const AGENTS = { "vault-explorer": [], "link-auditor": ["vault_add_links"] };

async function loadAgent(name) {
  const file = fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url));
  const content = await fs.readFile(file, "utf-8");
  const frontmatter = extractFrontmatter(content);
  const body = content.slice(content.indexOf("\n---", 3) + 4);
  const raw = frontmatter?.tools;
  const tools = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(",").map((t) => t.trim()).filter(Boolean) : null;
  return { tools, body, frontmatter: frontmatter ?? {} };
}

describe("read-mostly agents", () => {
  for (const [name, allowed] of Object.entries(AGENTS)) {
    const forbidden = WRITE_VAULT_TOOLS.filter((w) => !allowed.includes(w));

    it(`${name} grants no write-capable tool beyond its documented allowance`, async () => {
      const { tools } = await loadAgent(name);
      assert.ok(tools && tools.length > 0, `${name} must declare tools: (without it the agent inherits every tool)`);
      for (const tool of tools) {
        assert.ok(!WRITE_BUILTINS.includes(tool), `${name} grants ${tool}`);
        assert.ok(!SERVER_WIDE.includes(tool), `${name} grants the whole MCP server via ${tool}`);
        assert.ok(!forbidden.some((w) => tool === w || tool.endsWith(`__${w}`)), `${name} grants ${tool}`);
      }
      for (const w of allowed) {
        assert.ok(tools.includes(MCP_PREFIX + w), `${name} is missing ${MCP_PREFIX}${w}`);
      }
    });

    it(`${name} grants every read-only vault tool under its plugin MCP name, plus Read, Grep and Glob`, async () => {
      const { tools } = await loadAgent(name);
      const served = createToolsList("", [], true).map((t) => t.name);
      for (const tool of READ_VAULT_TOOLS) {
        assert.ok(served.includes(tool), `${tool} is not served by tools.js`);
        assert.ok(tools?.includes(MCP_PREFIX + tool), `${name} is missing ${MCP_PREFIX}${tool}`);
      }
      for (const tool of ["Read", "Grep", "Glob"]) {
        assert.ok(tools?.includes(tool), `${name} is missing ${tool}`);
      }
    });

    it(`${name}'s instructions name no write-capable vault tool it lacks`, async () => {
      const { body } = await loadAgent(name);
      for (const tool of forbidden) {
        assert.ok(!body.includes(tool), `${name} instructions mention ${tool}`);
      }
    });
  }
});

describe("agent memory", () => {
  const memoryAgents = { "pkm-capture": "user", "vault-explorer": undefined, "link-auditor": undefined };

  for (const [name, memory] of Object.entries(memoryAgents)) {
    it(`${name} ${memory ? `keeps ${memory}-scope memory` : "declares no memory and its text never mentions it"}`, async () => {
      const { frontmatter, body } = await loadAgent(name);
      assert.equal(frontmatter.memory, memory);
      const text = `${frontmatter.description}\n${body}`;
      assert.equal(/memory/i.test(text), Boolean(memory));
    });
  }

  it("pkm-capture saves only durable lessons labelled by project and keeps MEMORY.md under 60 lines", async () => {
    const { body } = await loadAgent("pkm-capture");
    assert.match(body, /label[^\n]*project/i);
    assert.match(body, /never[^\n]*per-run/i);
    assert.match(body, /MEMORY\.md[^\n]*under 60 lines/);
  });
});

describe("vault-explorer triggering", () => {
  it("is never suggested as a step before creating notes", async () => {
    const { frontmatter, body } = await loadAgent("vault-explorer");
    const text = `${frontmatter.description}\n${body}`;
    assert.doesNotMatch(text, /before (creating|writing|you create|you write)|note creation|new notes|prevents duplicates/i);
  });
});

describe("pkm-capture", () => {
  it("keeps Write and Edit disallowed and preloads exactly pkm-session-end and pkm-write", async () => {
    const { frontmatter } = await loadAgent("pkm-capture");
    const disallowed = String(frontmatter.disallowedTools).split(",").map((t) => t.trim());
    assert.deepEqual(disallowed, ["Write", "Edit"]);
    assert.deepEqual([...frontmatter.skills].sort(), ["pkm-session-end", "pkm-write"]);
  });

  it("defines exactly the four status lines, in order", async () => {
    const { body } = await loadAgent("pkm-capture");
    const defined = body.split("\n").filter((l) => l.startsWith("- `Status: ")).map((l) => l.match(/^- `([^`]+)`/)[1]);
    assert.deepEqual(defined, ["Status: captured", "Status: nothing new", "Status: no project", "Status: failed - <reason>"]);
    assert.doesNotMatch(body, /retr(y|ied)/i);
  });

  it("carries no transcript discovery and no first-versus-subsequent handoff", async () => {
    const { frontmatter, body } = await loadAgent("pkm-capture");
    const text = `${frontmatter.description}\n${body}`;
    for (const needle of ["ls -t", ".jsonl", "CLAUDE_CONFIG_DIR", "transcript_path"]) {
      assert.ok(!text.includes(needle), `mentions ${needle}`);
    }
    assert.doesNotMatch(text, /first capture|subsequent capture|previous (devlog )?entry/i);
  });

  const step0Of = (body) => body.slice(body.indexOf("**Step 0"), body.indexOf("**Supplementary sources**"));
  const lineWith = (text, needle) => text.split("\n").find((l) => l.includes(needle)) ?? "";

  it("explains the Devlog line in its three forms in Step 0", async () => {
    const { body } = await loadAgent("pkm-capture");
    const step0 = step0Of(body);
    assert.match(step0, /Devlog: <[^>]+> \(add a section\)/);
    assert.match(step0, /Devlog: new note/);
    assert.match(step0, /Devlog: unavailable/);
    assert.match(step0, /pkm-session-end Step 1/);
  });

  it("has a failed capture name the path of its activity file, so the main conversation can pass it on", async () => {
    const { body } = await loadAgent("pkm-capture");
    const failed = lineWith(body, "- `Status: failed - <reason>`");
    assert.match(failed, /activity file/i);
    assert.match(failed, /path/i);
  });

  it("tells the dispatcher to pass on the activity file a failed capture named", async () => {
    const { frontmatter } = await loadAgent("pkm-capture");
    assert.match(frontmatter.description, /failed capture[^.]*activity file|activity file[^.]*failed capture/i);
  });

  it("reads an earlier activity file named in the prompt, and captures from it or a focus note when there is no new activity", async () => {
    const step0 = step0Of((await loadAgent("pkm-capture")).body);
    assert.match(step0, /earlier activity file[^\n]*read|read[^\n]*earlier activity file/i);
    const none = lineWith(step0, "`New activity: none since the last capture`");
    for (const needle of [/focus note/, /earlier activity file/i, /Status: captured/, /Status: nothing new/]) {
      assert.match(none, needle);
    }
  });

  it("ends a no-project run that wrote requested inbox tasks with Status: captured", async () => {
    const step0 = step0Of((await loadAgent("pkm-capture")).body);
    const noProject = lineWith(step0, "`Project: none");
    assert.match(noProject, /inbox/i);
    assert.match(noProject, /Status: captured/);
  });

  it("reads the capture context first and falls back to vault_activity and git", async () => {
    const { body } = await loadAgent("pkm-capture");
    assert.match(body, /Step 0[^\n]*capture context/i);
    for (const needle of ["vault-pkm capture context", "Project: none", "none since the last capture", "unavailable", "vault_activity", "git log"]) {
      assert.ok(body.includes(needle), `body is missing ${needle}`);
    }
  });
});
