import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { resolveProject } from "../hooks/resolve-project.js";
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

  it("pkm-session-end's boundary includes an earlier activity file named in the prompt", async () => {
    const { body } = await loadSkill("pkm-session-end");
    const step2 = body.slice(body.indexOf("## Step 2"), body.indexOf("## Step 3"));
    assert.match(step2, /earlier activity file[^.]*(prompt|names)|(prompt|names)[^.]*earlier activity file/i);
    assert.match(step2, /earlier activity file[^.]*boundary|boundary[^.]*earlier activity file/i);
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
  const stepOf = (body, from, to) => body.slice(body.indexOf(from), body.indexOf(to));

  it("pkm-session-end Step 1 writes per-session notes: the three Devlog forms, creation, lookup, one section, titles and the hub", async () => {
    const { body } = await loadSkill("pkm-session-end");
    const step1 = stepOf(body, "## Step 1", "## Step 2");
    assert.match(step1, /Devlog: <[^>]+> \(add a section\)|\(add a section\)/);
    assert.match(step1, /Devlog: new note/);
    assert.match(step1, /Devlog: unavailable/);
    assert.match(step1, /template: "devlog-session"/);
    assert.match(step1, /project: "<Project>"/);
    assert.match(step1, /session: "<[^>]*id[^>]*>"/);
    assert.match(step1, /vault_query\(\{[^}]*development\/devlog[^}]*custom_fields: \{ session:/);
    assert.match(step1, /## YYYY-MM-DD HH:mm <[^>]*heading>/);
    for (const h of ["### Summary", "### Decisions", "### Blockers", "### Next steps"]) {
      assert.ok(step1.includes(h), `missing ${h}`);
    }
    assert.match(step1, /3 to 6 words/);
    assert.match(step1, /never rename/i);
    assert.match(step1, /already exists|taken/i);
    assert.match(step1, /devlog_folder/);
    assert.doesNotMatch(step1, /heading: "## Sessions"/);
    assert.doesNotMatch(step1, /Heading not found/);
    assert.match(step1, /never (append|write)[^.]*devlog\.md/i);
  });

  it("pkm-session-end Step 3d backlinks to the session note's section heading, not the hub", async () => {
    const { body } = await loadSkill("pkm-session-end");
    const step3d = stepOf(body, "### 3d", "## Step 4");
    assert.match(step3d, /\[\[<project>\/development\/devlog\/<[^>]+>#YYYY-MM-DD HH:mm <[^>]*heading>\]\]/);
    assert.doesNotMatch(step3d, /development\/devlog#/);
  });

  it("pkm-write sends devlog entries to the session's own note, not a Sessions heading", async () => {
    const { body } = await loadSkill("pkm-write");
    const line = body.split("\n").find((l) => l.startsWith("- **Devlog entries**")) ?? "";
    assert.match(line, /development\/devlog\//);
    assert.match(line, /never appended to|never append/i);
    assert.doesNotMatch(body, /## Sessions/);
  });

});

describe("project linking", () => {
  const read = (rel) => fs.readFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf-8");
  const step = (content, n) => content.slice(content.indexOf(`## Step ${n}`), content.indexOf(`## Step ${n + 1}`));

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

  it("init-project works out how a linked folder was linked and offers a relink", async () => {
    const content = await read("commands/init-project.md");
    const step1 = content.slice(content.indexOf("## Step 1"), content.indexOf("## Step 2"));
    assert.match(step1, /CLAUDE\.local\.md.*\.claude\/CLAUDE\.md/s);
    assert.match(step1, /repos:/);
    assert.match(step1, /folder name/i);
    assert.match(step1, /relink/i);
    assert.match(step1, /wins over/i);
  });

  it("init-project always checks for a # PKM: line, explains that it overrides repos:, checks its folder and repairs it only in CLAUDE.local.md", async () => {
    const step1 = step(await read("commands/init-project.md"), 1);
    const annotationCheck = step1.indexOf("# PKM:");
    assert.ok(annotationCheck >= 0, "Step 1 must look for a # PKM: line");
    assert.ok(annotationCheck < step1.indexOf("PKM Project Context"), "the annotation check must not wait for a context header");
    assert.match(step1, /whether or not[^.]*header/i);
    assert.match(step1, /top level/i);
    assert.match(step1, /main checkout/i);
    assert.match(step1, /overrides[^.]*repos:/i);
    assert.match(step1, /existing vault folder/i);
    assert.match(step1, /(fix|remove)[^.]*CLAUDE\.local\.md|CLAUDE\.local\.md[^.]*(fix|remove)/i);
    assert.match(step1, /edit it themselves/i);
    assert.match(step1, /<!--[^.]*(inactive|ignored|does not count)/i);
    assert.match(step1, /multi-line comment[^.]*counts/i);
  });

  it("init-project asks the user to confirm the suggested project in every case", async () => {
    const step3 = step(await read("commands/init-project.md"), 3);
    assert.match(step3, /always[^.]*confirm/i);
    assert.doesNotMatch(step3, /outside git[^.]*confirm/i);
  });

  it("init-project removes the remote from every other project that lists it before adding it, and requires that on a relink", async () => {
    const content = await read("commands/init-project.md");
    const tools = [].concat((extractFrontmatter(content) ?? {})["allowed-tools"]).join(",");
    const step4 = step(content, 4);
    const removal = step4.search(/every other project/i);
    assert.ok(removal >= 0, "Step 4 must look for other projects listing the remote");
    assert.ok(removal < step4.search(/plus the normalised remote/i), "removal must come before the remote is added");
    assert.match(step4, /vault_list/);
    assert.match(step4, /vault_peek|vault_read/);
    assert.match(step4, /_index\.md/);
    assert.match(step4, /every project/i);
    assert.doesNotMatch(step4, /vault_search/);
    for (const tool of step4.match(/vault_[a-z_]+/g)) assert.match(tools, new RegExp(`${tool}(,|$)`), `${tool} must be in allowed-tools`);
    assert.match(step4, /vault_update_frontmatter/);
    assert.match(step4, /other entries/i);
    assert.match(step4, /relink[^.]*required/i);
  });

  it("init-project reads remote URLs without ever printing their credentials", async () => {
    const step2 = step(await read("commands/init-project.md"), 2);
    assert.doesNotMatch(step2, /git remote -v/);
    assert.match(step2, /origin/);
  });

  it("init-project writes a CLAUDE.local.md line in the main checkout, not in a linked worktree", async () => {
    const step5 = step(await read("commands/init-project.md"), 5);
    assert.match(step5, /CLAUDE\.local\.md[^.]*main checkout/i);
    assert.match(step5, /worktree/i);
  });

  it("init-project suggests the project from the main checkout's folder name, not the worktree's", async () => {
    const content = await read("commands/init-project.md");
    const step3 = content.slice(content.indexOf("## Step 3"), content.indexOf("## Step 4"));
    assert.match(step3, /--git-common-dir/);
    assert.match(step3, /--show-toplevel/);
    assert.match(step3, /worktree/i);
  });

  it("init-project compares normalised forms when checking for an existing repos entry and keeps original text", async () => {
    const content = await read("commands/init-project.md");
    const step4 = content.slice(content.indexOf("## Step 4"), content.indexOf("## Step 5"));
    assert.match(step4, /normalis\w+ (form|each existing)/i);
    assert.match(step4, /original text/i);
  });

  it("the sample CLAUDE.md is short, shows the optional # PKM: line and carries no vault rules", async () => {
    const content = await read("sample-project/CLAUDE.md");
    assert.ok(content.trimEnd().split("\n").length <= 15);
    assert.match(content, /# PKM: 01-Projects\/\S+/);
    assert.doesNotMatch(content, /## PKM Integration|obsidian:\/\/|pkm-capture/);
  });

  it("a copied, unedited sample CLAUDE.md does not act as a # PKM: annotation", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sample-claude-"));
    try {
      const vault = path.join(tmp, "vault");
      const repo = path.join(tmp, "repo");
      await fs.mkdir(path.join(vault, "01-Projects"), { recursive: true });
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, "CLAUDE.md"), await read("sample-project/CLAUDE.md"));
      const resolution = await resolveProject(repo, vault, { home: path.join(tmp, "home") });
      assert.notEqual(resolution.code, "invalid-annotation", resolution.reason);
      assert.notEqual(resolution.via, "annotation");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
