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
