import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import { buildServerInstructions, ROUTING_ROWS } from "../instructions.js";
import { createToolsList } from "../tools.js";
import { makeVault } from "./fake-openai.js";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "cli.js");

function parseTable(text, headerCells) {
  const lines = text.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => {
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    return cells.length === headerCells.length && cells.every((c, i) => c === headerCells[i]);
  });
  assert.ok(start >= 0, `no table with header ${headerCells.join(" | ")}`);
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim().replaceAll("`", "")));
  }
  return rows;
}

describe("buildServerInstructions", () => {
  it("stays under 3,000 characters even for a long vault name with spaces", () => {
    const text = buildServerInstructions({ vaultName: "My Very Long Personal Knowledge Vault Name ".repeat(3).trim() });
    assert.ok(text.length < 3000, `length ${text.length}`);
  });

  it("says the index and recent devlog sessions load at session start, and no longer mentions tasks loading", () => {
    const text = buildServerInstructions({ vaultName: "PKM" });
    assert.ok(text.includes("index and recent devlog sessions are loaded at session start"), text);
    assert.ok(!/devlog or tasks/.test(text));
  });

  it("embeds the vault name URL-encoded in the link rule", () => {
    const text = buildServerInstructions({ vaultName: "My Vault/2026" });
    assert.ok(text.includes("vault=My%20Vault%2F2026"), text);
    assert.ok(!text.includes("vault=My Vault"));
  });

  it("states the five rules in order: links, new notes, where notes go, capture, agents and context", () => {
    const text = buildServerInstructions({ vaultName: "PKM" });
    const markers = [
      "obsidian://open?vault=PKM",
      "vault_write",
      "| Content | Location | Template |",
      "pkm-capture",
      "vault-explorer",
    ];
    const positions = markers.map((m) => text.indexOf(m));
    positions.forEach((p, i) => assert.ok(p >= 0, `missing ${markers[i]}`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  });
});

describe("routing table", () => {
  it("has the same rows in the same order in the instructions and in pkm-write", async () => {
    const header = ["Content", "Location", "Template"];
    const fromInstructions = parseTable(buildServerInstructions({ vaultName: "PKM" }), header);
    const skill = await fs.readFile(path.join(ROOT, "skills", "pkm-write", "SKILL.md"), "utf8");
    const fromSkill = parseTable(skill, header);
    assert.equal(fromInstructions.length, 9);
    assert.deepEqual(fromSkill, fromInstructions);
    assert.deepEqual(fromInstructions, ROUTING_ROWS.map((r) => [r.content, r.location, r.template].map((c) => c.replaceAll("`", ""))));
  });
});

describe("semantic score scale", () => {
  it("is stated in the vault_semantic_search description and repeated in no skill", async () => {
    const tool = createToolsList("", [], true).find((t) => t.name === "vault_semantic_search");
    assert.match(tool.description, /text-embedding-3-large/);
    assert.match(tool.description, /0\.55/);
    assert.match(tool.description, /0\.7/);
    assert.ok(/^[\x20-\x7e]*$/.test(tool.description), "description must be ASCII");

    for (const skill of await fs.readdir(path.join(ROOT, "skills"))) {
      const text = await fs.readFile(path.join(ROOT, "skills", skill, "SKILL.md"), "utf8");
      assert.ok(!/text-embedding-3-large|compresses hard/.test(text), `${skill} repeats the score scale`);
    }
  });
});

describe("running server", () => {
  let vault;
  let child;
  let initialize;

  before(async () => {
    vault = await makeVault({ "a.md": "Alpha body." });
    child = spawn(process.execPath, [CLI], {
      env: { PATH: process.env.PATH, HOME: vault, VAULT_PATH: vault },
      stdio: ["pipe", "pipe", "pipe"],
    });
    initialize = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no initialize response")), 10000);
      let buffered = "";
      child.stdout.on("data", (d) => {
        buffered += d;
        for (const line of buffered.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) { clearTimeout(timer); resolve(msg); }
          } catch { /* partial line */ }
        }
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n");
    });
  });

  after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
    await fs.rm(vault, { recursive: true, force: true });
  });

  it("returns the instructions at initialize with the vault folder name in the link rule", () => {
    const { instructions } = initialize.result;
    assert.equal(typeof instructions, "string");
    assert.ok(instructions.includes(`vault=${encodeURIComponent(path.basename(vault))}`), instructions);
  });
});
