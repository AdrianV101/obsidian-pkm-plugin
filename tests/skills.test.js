import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { extractFrontmatter } from "../utils.js";

async function loadSkill(name) {
  const file = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
  const content = await fs.readFile(file, "utf-8");
  const frontmatter = extractFrontmatter(content) ?? {};
  const body = content.slice(content.indexOf("\n---", 3) + 4);
  return { frontmatter, body, content };
}

describe("skill wording and triggering", () => {
  it("pkm-write's description covers creating notes only, not edits, appends or frontmatter", async () => {
    const { frontmatter } = await loadSkill("pkm-write");
    const desc = String(frontmatter.description);
    assert.match(desc, /creating a new note/i);
    assert.doesNotMatch(desc, /\bedit|append|frontmatter|vault_edit|modif/i);
  });

  it("pkm-session-end's description sends callers to pkm-capture and its dispatch rule precedes Step 1", async () => {
    const { frontmatter, body } = await loadSkill("pkm-session-end");
    assert.match(String(frontmatter.description), /dispatch the pkm-capture agent in the background/);
    const dispatch = body.search(/not (the )?pkm-capture/i);
    const step1 = body.indexOf("## Step 1");
    assert.ok(dispatch >= 0, "body must state the dispatch rule");
    assert.ok(step1 > dispatch, "dispatch rule must come before Step 1");
  });

  it("pkm-session-end takes its capture boundary from the new-activity file, not transcript discovery or timestamps", async () => {
    const { body } = await loadSkill("pkm-session-end");
    assert.match(body, /New activity/);
    assert.doesNotMatch(body, /transcript discovery|first capture or|session-context message|previous devlog entry/i);
  });

  const projectConsumers = ["add-task", "triage-tasks", "pkm-write"];
  for (const name of projectConsumers) {
    it(`${name} takes the project from the session context and never parses a # PKM: line`, async () => {
      const { body } = await loadSkill(name);
      assert.match(body, /PKM Project Context/);
      assert.doesNotMatch(body, /# PKM:/);
    });
  }

  it("tackle-task names no other plugin's skills or personal workflows", async () => {
    const { body } = await loadSkill("tackle-task");
    assert.doesNotMatch(body, /superpowers:|Small Tasks|Significant Features workflow/);
  });

  it("add-task confirms semantic hits at 0.5 or above and has no 0.7 or 0.8 threshold", async () => {
    const { body } = await loadSkill("add-task");
    assert.match(body, /0\.5/);
    assert.doesNotMatch(body, /0\.7|0\.8/);
  });

  for (const name of ["pkm-write", "pkm-session-end"]) {
    it(`${name} adds only ADR links to _index.md`, async () => {
      const { body } = await loadSkill(name);
      assert.match(body, /Architecture Decisions/);
      assert.match(body, /no other links/i);
      assert.doesNotMatch(body, /key links/i);
    });
  }
});

describe("project linking", () => {
  const read = (rel) => fs.readFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf-8");

  it("the project-index template starts with an empty repos list", async () => {
    const frontmatter = extractFrontmatter(await read("templates/project-index.md")) ?? {};
    assert.deepEqual(frontmatter.repos, []);
  });

  it("init-project links through repos: or CLAUDE.local.md, never edits CLAUDE.md and writes no link rule", async () => {
    const content = await read("commands/init-project.md");
    const frontmatter = extractFrontmatter(content) ?? {};
    const tools = [].concat(frontmatter["allowed-tools"]).join(",");
    assert.match(tools, /vault_read/);
    assert.match(tools, /vault_update_frontmatter/);
    assert.match(content, /repos:/);
    assert.match(content, /CLAUDE\.local\.md/);
    assert.match(content, /Never edit `CLAUDE\.md`/);
    assert.doesNotMatch(content, /obsidian:\/\/|Referring to vault files|pkm-capture/);
  });

  it("the sample CLAUDE.md is short, shows the optional # PKM: line and carries no vault rules", async () => {
    const content = await read("sample-project/CLAUDE.md");
    assert.ok(content.trimEnd().split("\n").length <= 15);
    assert.match(content, /^# PKM: 01-Projects\/\S+/m);
    assert.doesNotMatch(content, /## PKM Integration|obsidian:\/\/|pkm-capture/);
  });
});
