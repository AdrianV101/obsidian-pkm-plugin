import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractWikilinks,
  createLinkResolver,
  collectLinkedPaths,
  formatNeighborhood,
} from "../graph.js";
import { buildBasenameMap } from "../helpers.js";

describe("extractWikilinks", () => {
  it("extracts simple wikilinks", () => {
    const content = "See [[note-a]] and [[note-b]] for details.";
    const links = extractWikilinks(content);
    assert.deepEqual(links, ["note-a", "note-b"]);
  });

  it("extracts aliased wikilinks (keeps target, not alias)", () => {
    const content = "See [[real-note|display text]] here.";
    const links = extractWikilinks(content);
    assert.deepEqual(links, ["real-note"]);
  });

  it("extracts links with headings", () => {
    const content = "See [[note#section]] here.";
    const links = extractWikilinks(content);
    assert.deepEqual(links, ["note#section"]);
  });

  it("extracts links with paths", () => {
    const content = "See [[folder/subfolder/note]] here.";
    const links = extractWikilinks(content);
    assert.deepEqual(links, ["folder/subfolder/note"]);
  });

  it("returns empty array for no links", () => {
    assert.deepEqual(extractWikilinks("No links here"), []);
  });

  it("handles multiple links on one line", () => {
    const content = "[[a]] [[b]] [[c]]";
    assert.deepEqual(extractWikilinks(content), ["a", "b", "c"]);
  });

  it("handles link with alias and heading", () => {
    const content = "[[note#heading|display]]";
    const links = extractWikilinks(content);
    assert.deepEqual(links, ["note#heading"]);
  });
});

describe("buildBasenameMap (used by graph)", () => {
  it("maps basenames to file paths", () => {
    const files = ["01-Projects/note.md", "02-Areas/note.md", "03-Resources/other.md"];
    const map = buildBasenameMap(files).basenameMap;

    assert.deepEqual(map.get("note"), ["01-Projects/note.md", "02-Areas/note.md"]);
    assert.deepEqual(map.get("other"), ["03-Resources/other.md"]);
  });

  it("uses lowercase basenames", () => {
    const files = ["MyNote.md"];
    const map = buildBasenameMap(files).basenameMap;
    assert.ok(map.has("mynote"));
    assert.ok(!map.has("MyNote"));
  });

  it("handles empty file list", () => {
    const map = buildBasenameMap([]).basenameMap;
    assert.equal(map.size, 0);
  });
});

describe("extractWikilinks code masking and escapes", () => {
  it("ignores wikilinks inside fenced code blocks and inline code spans", () => {
    const shapes = [
      "```\n[[ghost]]\n```",
      "~~~md\n[[ghost]]\n~~~",
      "````\n```\n[[ghost]]\n```\n````",
      "Inline `[[ghost]]` span",
      "Double ``[[ghost]] with ` tick`` span",
    ];
    for (const code of shapes) {
      const content = `Before [[real]]\n${code}\nAfter [[also-real]]`;
      assert.deepEqual(extractWikilinks(content), ["real", "also-real"], JSON.stringify(code));
    }
  });

  it("treats \\| inside a link as the alias separator", () => {
    assert.deepEqual(extractWikilinks("| [[a\\|b]] | [[c#h\\|d]] |"), ["a", "c#h"]);
  });

  it("extracts embeds like ordinary links", () => {
    assert.deepEqual(extractWikilinks("![[diagram.png]] and ![[note#Section|300]]"), ["diagram.png", "note#Section"]);
  });
});

describe("createLinkResolver", () => {
  const files = [
    "01-Projects/note-a.md",
    "02-Areas/note-a.md",
    "03-Resources/unique.md",
    "folder/subfolder/deep.md",
    "root-note.md",
    "elsewhere/root-note.md",
    "a/x/n.md",
    "b/x/n.md",
  ];
  const resolver = createLinkResolver(files);

  it("resolves an exact vault path with or without .md, case-insensitively", () => {
    for (const target of ["01-Projects/note-a", "01-Projects/note-a.md", "01-projects/NOTE-A"]) {
      assert.deepEqual(resolver.resolve(target), { status: "resolved", path: "01-Projects/note-a.md" }, target);
    }
  });

  it("resolves a bare name by basename, case-insensitively", () => {
    for (const target of ["unique", "Unique", "UNIQUE.md"]) {
      assert.deepEqual(resolver.resolve(target), { status: "resolved", path: "03-Resources/unique.md" }, target);
    }
  });

  it("prefers a root-level note whose path equals the bare name over same-basename notes elsewhere", () => {
    assert.deepEqual(resolver.resolve("root-note"), { status: "resolved", path: "root-note.md" });
  });

  it("reports a bare name shared by several notes as ambiguous with every candidate", () => {
    assert.deepEqual(resolver.resolve("note-a"), {
      status: "ambiguous",
      candidates: ["01-Projects/note-a.md", "02-Areas/note-a.md"],
    });
  });

  it("resolves a target containing / by segment-aligned path suffix", () => {
    for (const target of ["subfolder/deep", "Subfolder/Deep.md"]) {
      assert.deepEqual(resolver.resolve(target), { status: "resolved", path: "folder/subfolder/deep.md" }, target);
    }
    assert.deepEqual(resolver.resolve("older/deep"), { status: "broken" });
  });

  it("never falls back to the basename for a target containing /", () => {
    assert.deepEqual(resolver.resolve("wrong-folder/unique"), { status: "broken" });
  });

  it("reports a path suffix shared by several notes as ambiguous", () => {
    assert.deepEqual(resolver.resolve("x/n"), { status: "ambiguous", candidates: ["a/x/n.md", "b/x/n.md"] });
  });

  it("resolves heading and block references to the note itself", () => {
    for (const target of ["unique#section", "unique#^block-id", "unique^block-id", "03-Resources/unique#Heading One"]) {
      assert.deepEqual(resolver.resolve(target), { status: "resolved", path: "03-Resources/unique.md" }, target);
    }
  });

  it("reports targets with no note part as broken", () => {
    for (const target of ["#just-heading", "^block", "", "   "]) {
      assert.deepEqual(resolver.resolve(target), { status: "broken" }, JSON.stringify(target));
    }
  });

  it("reports targets that match no note as broken", () => {
    for (const target of ["nonexistent", "diagram.png", "01-Projects/missing"]) {
      assert.deepEqual(resolver.resolve(target), { status: "broken" }, target);
    }
  });
});

describe("createLinkResolver unicode normalisation", () => {
  const nfd = "caf\u0065\u0301";
  const nfc = "caf\u00e9";
  it("matches NFC links to NFD files and NFD links to NFC files, returning the on-disk spelling", () => {
    const onNfd = createLinkResolver([`notes/${nfd}.md`, `x/${nfd}.md`]);
    assert.deepEqual(onNfd.resolve(`notes/${nfc}`), { status: "resolved", path: `notes/${nfd}.md` });
    assert.deepEqual(onNfd.resolve(`${nfc}`).status, "ambiguous");
    const onNfc = createLinkResolver([`notes/${nfc}.md`]);
    assert.deepEqual(onNfc.resolve(nfd), { status: "resolved", path: `notes/${nfc}.md` });
    assert.deepEqual(onNfc.resolve(`notes/${nfd}`), { status: "resolved", path: `notes/${nfc}.md` });
  });
});

describe("extractWikilinks multi-line", () => {
  it("does not treat a bracket pair spanning lines as a link", () => {
    assert.deepEqual(extractWikilinks("[[a\nb]] and [[c]]"), ["c"]);
  });
});

describe("collectLinkedPaths", () => {
  it("returns every note the content's links may point to, skipping code and broken links", () => {
    const resolver = createLinkResolver(["a/one.md", "b/two.md", "c/two.md", "d/three.md"]);
    const content = "[[one]] [[two]] [[missing]]\n```\n[[three]]\n```\n`[[d/three]]`";
    assert.deepEqual([...collectLinkedPaths(content, resolver)].sort(), ["a/one.md", "b/two.md", "c/two.md"]);
  });
});

describe("formatNeighborhood", () => {
  it("formats a simple neighborhood", () => {
    const depthGroups = new Map();
    depthGroups.set(0, [
      { path: "center.md", depth: 0, ambiguous: false, metadata: { type: "note", status: null, tags: [] } },
    ]);
    depthGroups.set(1, [
      { path: "neighbor.md", depth: 1, ambiguous: false, metadata: { type: "research", status: "active", tags: ["dev"] } },
    ]);

    const result = formatNeighborhood(
      { depthGroups, totalNodes: 2 },
      { startPath: "center.md", depth: 1, direction: "both" }
    );

    assert.ok(result.includes("center.md"));
    assert.ok(result.includes("neighbor.md"));
    assert.ok(result.includes("2 nodes"));
    assert.ok(result.includes("type: research"));
    assert.ok(result.includes("tags: dev"));
  });

  it("marks ambiguous nodes", () => {
    const depthGroups = new Map();
    depthGroups.set(0, [
      { path: "start.md", depth: 0, ambiguous: false, metadata: { type: null, status: null, tags: [] } },
    ]);
    depthGroups.set(1, [
      { path: "ambig.md", depth: 1, ambiguous: true, metadata: { type: null, status: null, tags: [] } },
    ]);

    const result = formatNeighborhood(
      { depthGroups, totalNodes: 2 },
      { startPath: "start.md", depth: 1, direction: "outgoing" }
    );

    assert.ok(result.includes("[ambiguous]"));
  });

  it("labels depth 0 as Center", () => {
    const depthGroups = new Map();
    depthGroups.set(0, [
      { path: "start.md", depth: 0, ambiguous: false, metadata: { type: null, status: null, tags: [] } },
    ]);

    const result = formatNeighborhood(
      { depthGroups, totalNodes: 1 },
      { startPath: "start.md", depth: 1, direction: "both" }
    );

    assert.ok(result.includes("Center"));
  });
});

describe("formatNeighborhood omitted nodes", () => {
  it("prints a '+N not shown' line only when nodes were omitted", () => {
    const depthGroups = new Map([[0, [{ path: "start.md", depth: 0, ambiguous: false, metadata: { type: null, status: null, tags: [] } }]]]);
    for (const [omittedNodes, expected] of [[11, true], [0, false], [undefined, false]]) {
      const text = formatNeighborhood(
        { depthGroups, totalNodes: 1 + (omittedNodes || 0), omittedNodes },
        { startPath: "start.md", depth: 2, direction: "both" }
      );
      assert.equal(text.includes("+11 not shown"), expected, `omittedNodes ${omittedNodes}`);
      assert.equal(/not shown/.test(text), expected, `omittedNodes ${omittedNodes}`);
    }
  });
});
