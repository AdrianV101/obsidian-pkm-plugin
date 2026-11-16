import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatUpgradeBlock, UPGRADE_BLOCK_MAX } from "../hooks/upgrade-block.js";

const PREFIX = "VAULT_PATH=/v npx -y 'obsidian-pkm@^9'";

function step(id, required, state, size = 0) {
  const pad = "x".repeat(size);
  return {
    id,
    required,
    target: null,
    state,
    summary: state === "done" ? "" : `Summary of ${id}${pad}.`,
    fix: state === "done" ? "" : `Fix ${id} with \`${PREFIX} migrate-devlog p\`.`,
    dismiss: `${PREFIX} upgrade dismiss ${id}`,
  };
}

function report({ steps, otherProjects = [], othersFix = "" }) {
  return { steps, otherProjects, othersFix: otherProjects.length ? othersFix || "Migrate them too." : "", dismissalError: null, errors: [] };
}

/** A step line as the block shows it: commands start with `obsidian-pkm`, the prefix given once in the header. */
const short = (text) => text.replaceAll(`${PREFIX} `, "obsidian-pkm ");
const stepLine = (label, s) => short(`- ${label}: ${s.summary} ${s.fix} Never: \`${s.dismiss}\``);

/** The block's header: every line before the first list line. */
function headerOf(block) {
  const lines = block.split("\n");
  return lines.slice(0, lines.findIndex((l) => l.startsWith("- ")));
}

describe("formatUpgradeBlock", () => {
  it("is empty when no step is left and no other project is listed", () => {
    const rows = [
      [],
      [step("devlog-template", true, "done"), step("claude-md-section", false, "done")],
      [step("devlog-template", true, "dismissed"), step("devlog-migration", true, "dismissed"), step("claude-md-section", false, "dismissed")],
      [step("devlog-template", true, "done"), step("devlog-migration", true, "dismissed")],
    ];
    for (const steps of rows) {
      assert.equal(formatUpgradeBlock(report({ steps }), { commandPrefix: PREFIX }), "", JSON.stringify(steps));
    }
  });

  it("lists the rules, then the required steps, the other projects and the optional steps, each with its commands", () => {
    const template = step("devlog-template", true, "left");
    const migration = step("devlog-migration", true, "left");
    const section = step("claude-md-section", false, "left");
    const block = formatUpgradeBlock(
      report({ steps: [template, migration, section], otherProjects: ["01-Projects/A", "01-Projects/B"], othersFix: `Same for each: \`${PREFIX} migrate-devlog <project path>\`.` }),
      { commandPrefix: PREFIX },
    );

    assert.ok(block.length <= UPGRADE_BLOCK_MAX, `${block.length} chars`);
    const header = headerOf(block);
    assert.equal(header[0], "### vault-pkm: upgrade steps left");
    const rules = header.join("\n");
    assert.match(rules, /first request/);
    assert.match(rules, /ask before/i);
    assert.match(rules, /not now/i);
    assert.match(rules, /never/i);
    assert.doesNotMatch(rules.replace(PREFIX, ""), /\d+\.\d+/);
    assert.ok(rules.includes(`\`${PREFIX} <args>\``), rules);
    assert.equal(block.split(PREFIX).length, 2, "the prefix appears once, in the header");
    assert.deepEqual(block.split("\n").slice(header.length), [
      stepLine("Required", template),
      stepLine("Required", migration),
      "- Also never migrated: 01-Projects/A, 01-Projects/B. Same for each: `obsidian-pkm migrate-devlog <project path>`.",
      stepLine("Optional", section),
    ]);
  });

  it("cuts to fit maxChars in a fixed order, never mid-line, and then points at doctor", () => {
    const template = step("devlog-template", true, "left", 60);
    const migration = step("devlog-migration", true, "left", 50);
    const sectionA = step("claude-md-section", false, "left", 40);
    const sectionB = step("claude-md-section", false, "left", 30);
    const others = Array.from({ length: 6 }, (_, i) => `01-Projects/Project-${i}`);
    const input = report({ steps: [template, migration, sectionA, sectionB], otherProjects: others, othersFix: "Same for each." });
    const full = formatUpgradeBlock(input, { commandPrefix: PREFIX, maxChars: 100000 });
    const header = headerOf(full);
    const doctorLine = "- Not every step fits here: `obsidian-pkm doctor` lists them all.";
    const countLine = "- Also never migrated: 6 other projects. Same for each.";
    const build = (...lines) => [...header, ...lines, doctorLine].join("\n");

    const stages = [
      build(stepLine("Required", template), stepLine("Required", migration), countLine, stepLine("Optional", sectionA), stepLine("Optional", sectionB)),
      build(stepLine("Required", template), stepLine("Required", migration), countLine, stepLine("Optional", sectionA)),
      build(stepLine("Required", template), stepLine("Required", migration), countLine),
      build(stepLine("Required", template), stepLine("Required", migration)),
      build(stepLine("Required", template)),
      build(),
    ];
    for (let i = 1; i < stages.length; i++) assert.ok(stages[i].length < stages[i - 1].length, "fixture stages must shrink");
    assert.ok(stages[0].length < full.length, "fixture: the count form must be shorter than the names");

    assert.equal(formatUpgradeBlock(input, { commandPrefix: PREFIX, maxChars: full.length }), full);
    for (const expected of stages) {
      for (const maxChars of [expected.length, expected.length + 3]) {
        const result = formatUpgradeBlock(input, { commandPrefix: PREFIX, maxChars });
        assert.ok(result.length <= maxChars);
        assert.equal(result, expected, `maxChars ${maxChars}`);
      }
    }
    assert.equal(formatUpgradeBlock(input, { commandPrefix: PREFIX, maxChars: stages.at(-1).length - 1 }), "");
  });
});
