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
  return { tools, body };
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
