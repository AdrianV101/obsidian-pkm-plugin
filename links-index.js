import fs from "node:fs/promises";
import path from "node:path";
import { extractLinkParts, buildResolvedIndex } from "./graph.js";

const STAT_BATCH = 64;

/**
 * The wikilinks of every note, kept in the local index's `links` table and refreshed from each
 * note's mtime and size before an answer. Links are stored as written and resolved by the caller's
 * resolver, so creating or removing a note never makes stored rows wrong.
 *
 * Only the lease holder writes the table. Any other process keeps the notes it found changed in
 * memory, and reads them again only when they change again.
 *
 * @param {import("./local-index.js").LocalIndex} localIndex
 * @param {Object} opts
 * @param {string} opts.vaultPath - absolute vault root
 * @param {{ listFresh(): Promise<string[]> }} opts.fileIndex
 * @param {boolean | (() => boolean)} opts.isHolder - whether this process may write the table
 * @returns {import("./graph.js").LinkSource & { refresh(): Promise<{ read: number }>, incoming(target: string, resolver: { resolve(target: string): import("./graph.js").LinkResolution }): string[] }}
 */
export function createLinksIndex(localIndex, { vaultPath, fileIndex, isHolder }) {
  const { db } = localIndex;
  const holds = () => (typeof isHolder === "function" ? isHolder() : !!isHolder);

  const selectFiles = db.prepare("SELECT src, mtime_ms, size FROM link_files");
  const selectOutgoing = db.prepare("SELECT raw, target FROM links WHERE src = ? ORDER BY id");
  const selectAll = db.prepare("SELECT src, target FROM links ORDER BY id");
  const deleteLinks = db.prepare("DELETE FROM links WHERE src = ?");
  const deleteFile = db.prepare("DELETE FROM link_files WHERE src = ?");
  const insertLink = db.prepare("INSERT INTO links (src, raw, target) VALUES (?, ?, ?)");
  const putFile = db.prepare("INSERT OR REPLACE INTO link_files (src, mtime_ms, size) VALUES (?, ?, ?)");

  /** Notes this process read because the table was behind and it may not write. */
  const memory = new Map(); // src -> { mtimeMs, size, parts }
  /** @type {{ rank: Map<string, number>, overlay: Map<string, Array<{ raw: string, target: string }>>, grouped: Map<string, string[]>|null }} */
  let state = { rank: new Map(), overlay: new Map(), grouped: null };
  let tail = Promise.resolve();

  async function statAll(files) {
    const stats = new Map();
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      await Promise.all(files.slice(i, i + STAT_BATCH).map(async (file) => {
        try {
          const st = await fs.stat(path.join(vaultPath, file));
          stats.set(file, { mtimeMs: st.mtimeMs, size: st.size });
        } catch (e) {
          if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; // gone since the listing
        }
      }));
    }
    return stats;
  }

  async function readParts(file) {
    try {
      return extractLinkParts(await fs.readFile(path.join(vaultPath, file), "utf-8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async function refreshNow() {
    const listed = await fileIndex.listFresh();
    const stats = await statAll(listed);
    const files = listed.filter(f => stats.has(f));
    const known = new Map(selectFiles.all().map(r => [r.src, r]));
    const stale = files.filter((f) => {
      const row = known.get(f);
      const st = stats.get(f);
      return !row || row.mtime_ms !== st.mtimeMs || row.size !== st.size;
    });

    const writer = holds();
    const reads = new Map(); // src -> parts | null
    let read = 0;
    for (let i = 0; i < stale.length; i += STAT_BATCH) {
      await Promise.all(stale.slice(i, i + STAT_BATCH).map(async (file) => {
        const st = stats.get(file);
        const kept = writer ? undefined : memory.get(file);
        if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) {
          reads.set(file, kept.parts);
          return;
        }
        read++;
        reads.set(file, await readParts(file));
      }));
    }

    const overlay = new Map();
    let wrote = false;
    if (writer) {
      const live = new Set(files);
      try {
        db.transaction(() => {
          for (const src of known.keys()) {
            if (live.has(src)) continue;
            deleteLinks.run(src);
            deleteFile.run(src);
          }
          for (const [file, parts] of reads) {
            deleteLinks.run(file);
            if (!parts) { deleteFile.run(file); continue; }
            for (const p of parts) insertLink.run(file, p.raw, p.target);
            const st = stats.get(file);
            putFile.run(file, st.mtimeMs, st.size);
          }
        }).immediate();
        wrote = true;
      } catch (e) {
        console.error(`Links table: could not update (using direct reads for this call): ${e.message}`);
      }
    }
    memory.clear();
    if (!wrote) {
      for (const [file, parts] of reads) {
        if (!parts) continue;
        const st = stats.get(file);
        memory.set(file, { mtimeMs: st.mtimeMs, size: st.size, parts });
        overlay.set(file, parts);
      }
    }
    // A note that vanished between statting and reading has no links to offer.
    const rank = new Map(files.filter(f => reads.get(f) !== null).map((f, i) => [f, i]));
    state = { rank, overlay, grouped: null };
    return { read };
  }

  function group() {
    if (state.grouped) return state.grouped;
    const byFile = new Map();
    for (const row of selectAll.all()) {
      if (!state.rank.has(row.src) || state.overlay.has(row.src)) continue;
      if (!byFile.has(row.src)) byFile.set(row.src, []);
      byFile.get(row.src).push(row.target);
    }
    for (const [file, parts] of state.overlay) byFile.set(file, parts.map(p => p.target));
    const ordered = new Map();
    for (const file of [...byFile.keys()].sort((a, b) => state.rank.get(a) - state.rank.get(b))) ordered.set(file, byFile.get(file));
    state.grouped = ordered;
    return ordered;
  }

  return {
    /**
     * Bring the links in line with the notes on disk, reading only notes whose mtime or size differ.
     * @returns {Promise<{ read: number }>} how many notes were read
     */
    refresh() {
      const run = tail.then(refreshNow);
      tail = run.then(() => {}, () => {});
      return run;
    },

    has: (src) => state.rank.has(src),

    /** @returns {Array<{ raw: string, target: string }>} the note's links in document order */
    outgoing(src) {
      if (!state.rank.has(src)) return [];
      return state.overlay.get(src) ?? selectOutgoing.all(src);
    },

    incomingIndex: (resolver) => buildResolvedIndex(group(), resolver),

    /**
     * @param {string} target - vault-relative note path
     * @param {{ resolve(target: string): import("./graph.js").LinkResolution }} resolver
     * @returns {string[]} notes whose links may resolve to it, in note-list order
     */
    incoming(target, resolver) {
      return [...(buildResolvedIndex(group(), resolver).get(target) ?? [])];
    },
  };
}
