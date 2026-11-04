import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLinksIndex } from "../links-index.js";
import { openLocalIndex } from "../local-index.js";
import { FileIndex } from "../vault-fs.js";
import {
  createLinkResolver, extractWikilinks, collectLinkedPaths, resolutionPaths, readLinkSource,
  findFilesLinkingTo, buildIncomingIndex, exploreNeighborhood,
} from "../graph.js";

// What the graph functions did before the links table: reread every note on every call.
const readNote = (vault, f) => fs.readFileSync(path.join(vault, f), "utf-8");
function oldIncoming(vault, allFiles, resolver) {
  const index = new Map();
  for (const file of allFiles) {
    for (const t of collectLinkedPaths(readNote(vault, file), resolver)) {
      if (t === file) continue;
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(file);
    }
  }
  return index;
}
function oldNeighborhood(vault, allFiles, resolver, startPath, maxDepth, direction) {
  const incoming = direction === "outgoing" ? null : oldIncoming(vault, allFiles, resolver);
  const visited = new Set();
  const order = [];
  let queue = [{ path: startPath, depth: 0, ambiguous: false }];
  while (queue.length > 0) {
    const next = [];
    for (const { path: p, depth, ambiguous } of queue) {
      if (visited.has(p)) continue;
      visited.add(p);
      order.push({ path: p, depth, ambiguous });
      if (depth >= maxDepth) continue;
      if (direction !== "incoming") {
        for (const link of extractWikilinks(readNote(vault, p))) {
          const r = resolver.resolve(link);
          for (const t of resolutionPaths(r)) if (!visited.has(t)) next.push({ path: t, depth: depth + 1, ambiguous: r.status === "ambiguous" });
        }
      }
      for (const s of incoming?.get(p) ?? []) if (!visited.has(s)) next.push({ path: s, depth: depth + 1, ambiguous: false });
    }
    queue = next;
  }
  return order;
}

describe("links table", () => {
  let tmp, vault, opened;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-links-"));
    vault = path.join(tmp, "vault");
    fs.mkdirSync(vault, { recursive: true });
    opened = [];
  });

  afterEach(() => {
    for (const li of opened) { try { li.close(); } catch { /* closed */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel, text, mtimeSec) => {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    if (mtimeSec) fs.utimesSync(abs, mtimeSec, mtimeSec);
  };

  async function make({ isHolder = true, dbPath = path.join(tmp, "index.db") } = {}) {
    const localIndex = openLocalIndex({ vaultPath: vault, dbPath });
    opened.push(localIndex);
    const fileIndex = await FileIndex.build(vault);
    const links = createLinksIndex(localIndex, { vaultPath: vault, fileIndex, isHolder });
    return { links, localIndex, fileIndex };
  }

  const rows = (li) => li.db.prepare("SELECT src, raw, target FROM links ORDER BY id").all();

  it("G1: the first refresh reads every note, a second reads none, and an edit reads exactly that note", async () => {
    write("a.md", "[[b]] [[c#sec]]");
    write("b.md", "[[a|alias]]");
    write("c.md", "nothing");
    const { links, localIndex } = await make();
    assert.deepEqual(await links.refresh(), { read: 3 });
    assert.deepEqual(await links.refresh(), { read: 0 });
    write("b.md", "[[c]] and [[a]]", 2000000000);
    assert.deepEqual(await links.refresh(), { read: 1 });
    assert.deepEqual(links.outgoing("b.md"), [{ raw: "c", target: "c" }, { raw: "a", target: "a" }]);
    assert.deepEqual(rows(localIndex).filter(r => r.src === "a.md"), [
      { src: "a.md", raw: "b", target: "b" },
      { src: "a.md", raw: "c#sec", target: "c" },
    ]);
    fs.rmSync(path.join(vault, "c.md"));
    assert.deepEqual(await links.refresh(), { read: 0 });
    assert.equal(localIndex.db.prepare("SELECT COUNT(*) AS n FROM link_files").get().n, 2);
  });

  it("a restarted process finds the stored rows current", async () => {
    write("a.md", "[[b]]");
    write("b.md", "x");
    const first = await make();
    await first.links.refresh();
    first.localIndex.close();
    const second = await make();
    assert.deepEqual(await second.links.refresh(), { read: 0 });
    assert.deepEqual(second.links.outgoing("a.md"), [{ raw: "b", target: "b" }]);
  });

  it("G2: links are stored as written and resolved at query time", async () => {
    write("a.md", "See [[Later Note]] and [[dup]].");
    write("x/dup.md", "x");
    const { links, fileIndex, localIndex } = await make();
    await links.refresh();
    const resolve = async () => {
      const files = await fileIndex.listFresh();
      return createLinkResolver(files);
    };
    assert.deepEqual(links.incoming("later note.md", await resolve()), []);
    write("sub/Later Note.md", "hi");
    write("y/dup.md", "y");
    assert.deepEqual(await links.refresh(), { read: 2 });
    const resolver = await resolve();
    assert.deepEqual(links.incoming("sub/Later Note.md", resolver), ["a.md"]);
    assert.deepEqual(links.incoming("x/dup.md", resolver), ["a.md"]);
    assert.deepEqual(links.incoming("y/dup.md", resolver), ["a.md"]);
    // the linking note was not read again
    assert.deepEqual(rows(localIndex).filter(r => r.src === "a.md").map(r => r.raw), ["Later Note", "dup"]);
  });

  it("G4: a reader with stale rows reads the changed notes for its answer and writes nothing", async () => {
    write("a.md", "[[b]]");
    write("b.md", "x");
    write("c.md", "y");
    const dbPath = path.join(tmp, "shared.db");
    const holder = await make({ isHolder: true, dbPath });
    await holder.links.refresh();
    const reader = await make({ isHolder: false, dbPath });
    const before = reader.localIndex.db.pragma("data_version", { simple: true });
    write("a.md", "[[c]] [[b]]", 2000000000);
    write("d.md", "[[a]]");
    fs.rmSync(path.join(vault, "b.md"));

    assert.deepEqual(await reader.links.refresh(), { read: 2 });
    assert.deepEqual(reader.links.outgoing("a.md"), [{ raw: "c", target: "c" }, { raw: "b", target: "b" }]);
    const resolver = createLinkResolver(await reader.fileIndex.listFresh());
    assert.deepEqual(reader.links.incoming("a.md", resolver), ["d.md"]);
    assert.deepEqual(reader.links.incoming("c.md", resolver), ["a.md"]);
    assert.equal(holder.localIndex.db.prepare("SELECT COUNT(*) AS n FROM link_files").get().n, 3);
    assert.equal(holder.localIndex.db.prepare("SELECT raw FROM links WHERE src = 'a.md'").all().length, 1);
    assert.equal(reader.localIndex.db.pragma("data_version", { simple: true }), before);

    // the change stays in this process's memory, so the next call does not read it again
    assert.deepEqual(await reader.links.refresh(), { read: 0 });
    assert.deepEqual(reader.links.outgoing("a.md").map(l => l.raw), ["c", "b"]);
    // the holder catches up on its next call
    assert.deepEqual(await holder.links.refresh(), { read: 2 });
    assert.deepEqual(await reader.links.refresh(), { read: 0 });
    assert.deepEqual(reader.links.outgoing("d.md"), [{ raw: "a", target: "a" }]);
  });

  it("G5: a note written straight to disk is picked up on the next call", async () => {
    write("a.md", "[[b]]");
    write("b.md", "x");
    const { links } = await make();
    await links.refresh();
    write("a.md", "[[b]] [[b]] plus text", 2100000000);
    await links.refresh();
    assert.equal(links.outgoing("a.md").length, 2);
    write("a.md", "[[a]] plus text", 2200000000);
    await links.refresh();
    assert.deepEqual(links.outgoing("a.md"), [{ raw: "a", target: "a" }]);
  });

  it("keeps fragments, aliases, escaped pipes and code exclusion exactly as extractWikilinks yields them", async () => {
    const body = "[[n#h]] [[n^blk|al]] [[a\\|b]] ![[img.png]] [[#only]] [[folder/N]]\n```\n[[ghost]]\n```\n`[[ghost2]]`\n";
    write("a.md", body);
    const { links } = await make();
    await links.refresh();
    assert.deepEqual(links.outgoing("a.md").map(l => l.raw), extractWikilinks(body));
    assert.deepEqual(links.outgoing("a.md").map(l => l.raw), ["n#h", "n^blk", "a", "img.png", "#only", "folder/N"]);
  });

  it("G3: every graph answer from the table equals the file-reading answer", async () => {
    write("hub.md", "---\ntype: note\ntags: [t]\n---\n[[a]] [[dup]] [[ghost]] [[hub]] [[c#h|x]]");
    write("a.md", "[[hub]] [[x/dup]] [[a]]");
    write("c.md", "```\n[[a]]\n```\n[[Z/Deep Note]]");
    write("x/dup.md", "[[a]]");
    write("y/dup.md", "[[hub]]");
    write("Z/Deep Note.md", "[[c]] [[NOTES/lone]]");
    write("notes/lone.md", "x");
    write("orphan.md", "x");
    write("café.md", "[[Café]]");
    const { links, fileIndex } = await make();
    await links.refresh();
    const allFiles = await fileIndex.listFresh();
    const resolver = createLinkResolver(allFiles);
    const oldIndex = oldIncoming(vault, allFiles, resolver);
    const toPlain = (m) => [...m].map(([k, v]) => [k, [...v]]);

    for (const f of allFiles) {
      assert.deepEqual(links.outgoing(f).map(l => l.raw), extractWikilinks(readNote(vault, f)), `outgoing ${f}`);
      assert.deepEqual((await findFilesLinkingTo(f, links, resolver)).map(r => r.file), [...(oldIndex.get(f) ?? [])], `incoming ${f}`);
    }
    assert.deepEqual(toPlain(await buildIncomingIndex(links, resolver)), toPlain(oldIndex));
    const fileMode = await readLinkSource(vault, allFiles);
    assert.deepEqual(toPlain(await buildIncomingIndex(fileMode, resolver)), toPlain(oldIndex));
    for (const direction of ["both", "outgoing", "incoming"]) {
      for (const startPath of allFiles) {
        const got = await exploreNeighborhood({ startPath, vaultPath: vault, links, resolver, depth: 3, direction, maxNodes: 1000 });
        const shown = [...got.depthGroups.values()].flat().map(n => ({ path: n.path, depth: n.depth, ambiguous: n.ambiguous }));
        assert.deepEqual(shown.sort((x, y) => x.depth - y.depth), oldNeighborhood(vault, allFiles, resolver, startPath, 3, direction).sort((x, y) => x.depth - y.depth), `${startPath} ${direction}`);
      }
    }
  });
});
