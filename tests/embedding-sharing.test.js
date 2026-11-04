import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { SemanticIndex } from "../embeddings.js";
import { openLocalIndex } from "../local-index.js";
import { loadMachineSettings, BACKSTOP_WAIT_MS, DEFAULT_WAIT_MS } from "../machine-settings.js";
import { CACHE_FOLDER, PackWriter, listPacks, compactOwnPacks } from "../embedding-cache.js";
import { chunkNote } from "../chunker.js";
import {
  DIMS, fakeEmbedding, installFakeOpenAI, makeVault, manyNotes, holderLease, errorResponse,
} from "./fake-openai.js";

const HOUR = 3600_000;

let root;
let fake;
let vault;
let machines;
let errors;
let realError;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-sharing-"));
  fake = installFakeOpenAI();
  vault = null;
  machines = [];
  errors = [];
  realError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
});

afterEach(async () => {
  console.error = realError;
  for (const m of machines) await m.index.shutdown().catch(() => {});
  fake.restore();
  await fs.rm(root, { recursive: true, force: true });
  if (vault) await fs.rm(vault, { recursive: true, force: true });
});

const lease = (holder) => (holder ? holderLease() : {
  isHolder: false, onAcquired() {}, onLost() {}, async tryAcquire() { return false; }, async release() {},
});

function fakeWatch() {
  const watchers = [];
  const watch = (_dir, _opts, listener) => {
    const w = new EventEmitter();
    w.listener = listener;
    w.close = () => {};
    watchers.push(w);
    return w;
  };
  return { watch, emit: (filename) => watchers.at(-1).listener("rename", filename) };
}

/**
 * One machine is a state folder, a cache folder and a clock. Two instances built on the same
 * `name` stand for two sessions on that machine; only the first may hold the lease.
 */
function machine(name, { holder = true, env = {}, clock = { t: Date.now() }, extra = {} } = {}) {
  const stateDir = path.join(root, `${name}-state`);
  const dbPath = path.join(root, `${name}-cache`, "index.db");
  const settings = loadMachineSettings(stateDir, env);
  const localIndex = openLocalIndex({ vaultPath: vault, dbPath });
  const w = fakeWatch();
  const compactCalls = [];
  const index = new SemanticIndex({
    vaultPath: vault,
    openaiApiKey: "test-key",
    localIndex,
    lease: lease(holder),
    statsPath: path.join(stateDir, "semantic-stats.json"),
    settings,
    cacheDirAbs: path.join(vault, CACHE_FOLDER),
    now: () => clock.t,
    sleep: async () => {},
    watch: w.watch,
    debounceMs: 0,
    tickMs: 0,
    compact: async (opts) => { compactCalls.push(opts); return compactOwnPacks(opts); },
    ...extra,
  });
  const m = { name, index, settings, clock, emit: w.emit, localIndex, compactCalls, stateDir };
  machines.push(m);
  return m;
}

async function start(m) {
  await m.index.initialize();
  await m.index.whenSynced();
  await m.index.whenIdle();
  return m;
}

const GRACE_MS = 60_000;

/** Lets a change nobody here wrote wait out the same-machine grace, then runs the holder's tick. */
async function afterGrace(m) {
  m.clock.t += GRACE_MS;
  await m.index._tick();
  await m.index.whenIdle();
}

const cacheDirAbs = () => path.join(vault, CACHE_FOLDER);
const packEvent = (name) => `${CACHE_FOLDER}/${name}`;
const rows = (m, table) => m.localIndex.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const storedPaths = (m) => m.localIndex.db.prepare("SELECT path FROM files ORDER BY path").all().map(r => r.path);
const sentTexts = () => fake.calls.flat();

/** Packs from another device holding the vectors of every chunk of the given notes. */
async function foreignPack(deviceId, notes) {
  const w = new PackWriter({ cacheDirAbs: cacheDirAbs(), deviceId, model: "text-embedding-3-small", dims: DIMS });
  for (const [rel, content] of Object.entries(notes)) {
    for (const c of chunkNote(content, rel)) w.add(c.hash, fakeEmbedding(c.text));
  }
  return w.flush();
}

const note = (body) => `---\ntype: note\n---\n${body}\n`;

describe("shared embedding cache", () => {
  it("W1: looks a chunk up in the loaded packs before calling OpenAI", async () => {
    const content = note("A note whose vector another machine already paid for.");
    vault = await makeVault({ "n/a.md": content });
    await foreignPack("dev-other", { "n/a.md": content });
    const m = await start(machine("one"));
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(storedPaths(m), ["n/a.md"]);
    assert.equal(rows(m, "chunks"), 1);
  });

  it("W8: an empty local index with a full set of packs reaches full coverage with zero API calls", async () => {
    const files = manyNotes(12);
    vault = await makeVault(files);
    await foreignPack("dev-a", Object.fromEntries(Object.entries(files).slice(0, 6)));
    await foreignPack("dev-b", Object.fromEntries(Object.entries(files).slice(6)));
    const m = await start(machine("one"));
    assert.equal(fake.calls.length, 0);
    assert.equal(storedPaths(m).length, 12);
    assert.equal(m.index.health().staleFiles, 0);
  });

  it("W2: a tool write embeds at once in a process that is not the holder and writes only a pack", async () => {
    vault = await makeVault({ "n/seed.md": note("seed") });
    const holder = await start(machine("one"));
    const reader = await start(machine("one", { holder: false }));
    const before = fake.calls.length;
    const content = note("Written by a tool in a session that is not the housekeeper.");
    await fs.writeFile(path.join(vault, "n/new.md"), content);
    reader.index.notifyChanged("n/new.md");
    await reader.index.whenIdle();

    assert.equal(fake.calls.length, before + 1);
    assert.deepEqual(sentTexts().filter(t => t.includes("Written by a tool")).length, 1);
    const own = (await listPacks(cacheDirAbs())).filter(p => p.deviceId === reader.settings.deviceId);
    assert.ok(own.length >= 1);
    assert.ok(!storedPaths(reader).includes("n/new.md"), "a non-holder never writes the index");
    assert.equal(rows(reader, "pack_vectors"), 0);

    // The holder's own watcher also sees the note change: the pack is used, nothing more is sent.
    holder.emit("n/new.md");
    holder.emit(packEvent(own.at(-1).name));
    await holder.index.whenIdle();
    assert.equal(fake.calls.length, before + 1);
    assert.ok(storedPaths(holder).includes("n/new.md"));

    // A second machine importing that pack sends nothing for the same note.
    const second = await start(machine("two"));
    assert.equal(fake.calls.length, before + 1);
    assert.ok(storedPaths(second).includes("n/new.md"));
  });

  it("W2: a tool write in the holder embeds at once, stores the note and flushes a pack", async () => {
    vault = await makeVault({});
    const m = await start(machine("one"));
    await fs.writeFile(path.join(vault, "a.md"), note("Holder written note body."));
    m.index.notifyChanged("a.md");
    await m.index.whenIdle();
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(storedPaths(m), ["a.md"]);
    assert.equal((await listPacks(cacheDirAbs())).length, 1);
  });

  it("a non-holder with the shared cache off does nothing", async () => {
    vault = await makeVault({});
    await start(machine("one"));
    const reader = await start(machine("one", { holder: false, env: { VAULT_PKM_SHARED_CACHE: "off" } }));
    await fs.writeFile(path.join(vault, "a.md"), note("Body."));
    reader.index.notifyChanged("a.md");
    await reader.index.whenIdle();
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await listPacks(cacheDirAbs()), []);
  });

  it("a non-holder skips chunks the index already holds", async () => {
    const content = note("Already indexed by the housekeeper.");
    vault = await makeVault({ "a.md": content });
    const holder = await start(machine("one"));
    await afterGrace(holder);
    const before = fake.calls.length;
    const packs = await listPacks(cacheDirAbs());
    const reader = await start(machine("one", { holder: false }));
    reader.index.notifyChanged("a.md");
    await reader.index.whenIdle();
    assert.equal(fake.calls.length, before);
    assert.deepEqual(await listPacks(cacheDirAbs()), packs);
  });

  const waits = [
    { name: "backstop machine", env: { VAULT_PKM_BACKSTOP: "1" }, ms: BACKSTOP_WAIT_MS },
    { name: "other machines", env: {}, ms: DEFAULT_WAIT_MS },
  ];
  for (const w of waits) {
    it(`W3: a change not written here waits ${w.ms} ms on a ${w.name}, then is sent`, async () => {
      vault = await makeVault({ "a.md": note("seed") });
      await foreignPack("dev-other", { "a.md": note("seed") });
      const m = await start(machine("one", { env: w.env }));
      const t0 = m.clock.t;
      const before = fake.calls.length;
      await fs.writeFile(path.join(vault, "a.md"), note("Edited by hand in Obsidian."));
      await m.index.reindexFile("a.md");
      assert.equal(fake.calls.length, before);
      assert.equal(m.index.health().chunksWaiting, 1);
      assert.equal(m.index.health().oldestWaitSince, new Date(t0).toISOString());
      assert.equal(m.index.health().staleFiles, 1);

      m.clock.t = t0 + w.ms - 1;
      await m.index._tick();
      assert.equal(fake.calls.length, before);

      m.clock.t = t0 + w.ms;
      await m.index._tick();
      assert.equal(fake.calls.length, before + 1);
      assert.ok(sentTexts().at(-1).includes("Edited by hand"));
      assert.equal(m.index.health().chunksWaiting, 0);
      assert.equal(m.index.health().staleFiles, 0);
      assert.deepEqual(storedPaths(m), ["a.md"]);
      assert.ok((await listPacks(cacheDirAbs())).some(p => p.deviceId === m.settings.deviceId));
    });
  }

  it("a hand edit with no other device's pack is sent after the grace and not before", async () => {
    vault = await makeVault({ "a.md": note("seed") });
    const m = await start(machine("one"));
    await afterGrace(m);
    const before = fake.calls.length;
    const t0 = m.clock.t;
    await fs.writeFile(path.join(vault, "a.md"), note("Edited with nobody else around."));
    await m.index.reindexFile("a.md");
    assert.equal(fake.calls.length, before);
    m.clock.t = t0 + GRACE_MS - 1;
    await m.index._tick();
    assert.equal(fake.calls.length, before);
    m.clock.t = t0 + GRACE_MS;
    await m.index._tick();
    assert.equal(fake.calls.length, before + 1);
    assert.deepEqual(storedPaths(m), ["a.md"]);
  });

  it("with the shared cache off a change is sent at once", async () => {
    vault = await makeVault({ "a.md": note("seed") });
    const m = await start(machine("one", { env: { VAULT_PKM_SHARED_CACHE: "off" } }));
    assert.equal(fake.calls.length, 1);
    await fs.writeFile(path.join(vault, "a.md"), note("Edited, cache off."));
    await m.index.reindexFile("a.md");
    assert.equal(fake.calls.length, 2);
  });

  for (const order of ["holder event first", "tool write first"]) {
    it(`a non-holder tool write that the holder also sees is sent once (${order})`, async () => {
      vault = await makeVault({});
      const holder = await start(machine("one"));
      const reader = await start(machine("one", { holder: false }));
      const body = "Written by a tool while the housekeeper watches the file.";
      await fs.writeFile(path.join(vault, "a.md"), note(body));
      const sendTool = async () => { reader.index.notifyChanged("a.md"); await reader.index.whenIdle(); };
      const seeEvent = async () => { holder.emit("a.md"); await holder.index.whenIdle(); };
      if (order === "tool write first") { await sendTool(); await seeEvent(); } else { await seeEvent(); await sendTool(); }
      const pack = (await listPacks(cacheDirAbs())).at(-1).name;
      holder.emit(packEvent(pack));
      await holder.index.whenIdle();
      await afterGrace(holder);
      assert.equal(sentTexts().filter(t => t.includes(body)).length, 1);
      assert.deepEqual(storedPaths(holder), ["a.md"]);
    });
  }

  it("W4: a pack carrying the waiting chunks that arrives during the wait means nothing is sent", async () => {
    vault = await makeVault({ "a.md": note("seed") });
    await foreignPack("dev-other", { "a.md": note("seed") });
    const m = await start(machine("one"));
    const t0 = m.clock.t;
    const before = fake.calls.length;
    const edited = note("Edited elsewhere and synced here.");
    await fs.writeFile(path.join(vault, "a.md"), edited);
    await m.index.reindexFile("a.md");
    assert.equal(m.index.health().chunksWaiting, 1);

    const name = await foreignPack("dev-other", { "a.md": edited });
    m.emit(packEvent(name));
    await m.index.whenIdle();
    assert.equal(m.index.health().chunksWaiting, 0);
    assert.equal(m.index.health().staleFiles, 0);

    m.clock.t = t0 + 2 * HOUR;
    await m.index._tick();
    assert.equal(fake.calls.length, before);
  });

  it("a pack found by the tick, without a watcher event, resolves waiting notes", async () => {
    vault = await makeVault({ "a.md": note("seed") });
    await foreignPack("dev-other", { "a.md": note("seed") });
    const m = await start(machine("one"));
    const before = fake.calls.length;
    const edited = note("Synced while the watcher missed the pack.");
    await fs.writeFile(path.join(vault, "a.md"), edited);
    await m.index.reindexFile("a.md");
    await foreignPack("dev-other", { "a.md": edited });
    await m.index._tick();
    assert.equal(fake.calls.length, before);
    assert.equal(m.index.health().staleFiles, 0);
  });

  it("a note with several chunks is stored when all resolve, sends only what is missing, and stays searchable meanwhile", async () => {
    const part = (word) => `${word} `.repeat(Math.ceil(3000 / (word.length + 1)));
    const old = note(`## One\n${part("alpha")}\n## Two\n${part("beta")}`);
    vault = await makeVault({ "big.md": old });
    await foreignPack("dev-other", { "big.md": old });
    const m = await start(machine("one"));
    assert.equal(chunkNote(old, "big.md").length, 2);

    const edited = note(`## One\n${part("alpha")}\n## Two\n${part("gamma")}\n`);
    const [keep, fresh] = chunkNote(edited, "big.md");
    assert.equal(chunkNote(edited, "big.md").length, 2);
    await fs.writeFile(path.join(vault, "big.md"), edited);
    const before = fake.calls.length;
    await m.index.reindexFile("big.md");
    // The first section is unchanged, so only the second chunk waits and the old rows stay.
    assert.equal(fake.calls.length, before);
    assert.equal(m.index.health().chunksWaiting, 1);
    const oldHashes = m.localIndex.db.prepare("SELECT chunk_hash FROM chunks ORDER BY chunk_index").all().map(r => r.chunk_hash);
    assert.deepEqual(oldHashes, chunkNote(old, "big.md").map(c => c.hash));

    m.clock.t += DEFAULT_WAIT_MS;
    await m.index._tick();
    assert.equal(fake.calls.length, before + 1);
    assert.deepEqual(fake.calls.at(-1), [fresh.text]);
    assert.notEqual(fake.calls.at(-1)[0], keep.text);
    const newHashes = m.localIndex.db.prepare("SELECT chunk_hash FROM chunks ORDER BY chunk_index").all().map(r => r.chunk_hash);
    assert.deepEqual(newHashes, [keep.hash, fresh.hash]);
  });

  it("W5: pack files in the cache folder go to pack import, never to note reindexing", async () => {
    vault = await makeVault({});
    const m = await start(machine("one"));
    let reconciled = 0;
    let reindexed = 0;
    m.index._reconcileSubtree = async () => { reconciled++; };
    const reindexFile = m.index.reindexFile.bind(m.index);
    m.index.reindexFile = (...a) => { reindexed++; return reindexFile(...a); };

    const name = await foreignPack("dev-other", { "x.md": note("Some other machine's note.") });
    m.emit(packEvent(name));
    m.emit(`${packEvent(name)}.tmp`);
    m.emit(CACHE_FOLDER);
    await m.index.whenIdle();
    assert.equal(reconciled, 0);
    assert.equal(reindexed, 0);
    assert.equal(rows(m, "pack_vectors"), 1);
    assert.ok(m.localIndex.db.prepare("SELECT name FROM imported_packs").all().some(r => r.name === name));
  });

  it("W6: a pack that fails to read is retried on the next event and imported once valid, logging once", async () => {
    vault = await makeVault({});
    const m = await start(machine("one"));
    const good = await foreignPack("dev-other", { "x.md": note("Content of the pack.") });
    const file = path.join(cacheDirAbs(), good);
    const whole = await fs.readFile(file);
    await fs.writeFile(file, whole.subarray(0, whole.length - 40));

    m.emit(packEvent(good));
    await m.index.whenIdle();
    m.emit(packEvent(good));
    await m.index.whenIdle();
    await m.index._tick();
    assert.equal(rows(m, "imported_packs"), 0);
    assert.equal(rows(m, "pack_vectors"), 0);
    assert.equal(errors.filter(e => e.includes(good)).length, 1);

    await fs.writeFile(file, whole);
    m.emit(packEvent(good));
    await m.index.whenIdle();
    assert.equal(rows(m, "imported_packs"), 1);
    assert.equal(rows(m, "pack_vectors"), 1);
  });

  it("a pack of another model is recorded as imported and ignored", async () => {
    vault = await makeVault({});
    const m = await start(machine("one"));
    const w = new PackWriter({ cacheDirAbs: cacheDirAbs(), deviceId: "dev-other", model: "other-model", dims: 4 });
    w.add("a".repeat(64), [1, 2, 3, 4]);
    await w.flush();
    await m.index._tick();
    assert.equal(rows(m, "pack_vectors"), 0);
    assert.equal(rows(m, "imported_packs"), 1);
  });

  it("W7: with the shared cache off no packs are read or written and embedding stays local", async () => {
    const content = note("A note another machine has a pack for.");
    vault = await makeVault({ "a.md": content });
    const theirs = await foreignPack("dev-other", { "a.md": content });
    const before = await fs.readdir(cacheDirAbs());
    const m = await start(machine("one", { env: { VAULT_PKM_SHARED_CACHE: "off" } }));
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(storedPaths(m), ["a.md"]);

    await fs.writeFile(path.join(vault, "b.md"), note("Written by a tool."));
    m.index.notifyChanged("b.md");
    await m.index.whenIdle();
    await fs.writeFile(path.join(vault, "b.md"), note("Edited by hand."));
    await m.index.reindexFile("b.md");
    m.emit(packEvent(theirs));
    await m.index._tick();
    await m.index.whenIdle();

    assert.equal(fake.calls.length, 3);
    assert.deepEqual(await fs.readdir(cacheDirAbs()), before);
    assert.equal(rows(m, "imported_packs"), 0);
    assert.equal(m.index.health().sharedCache, false);
  });

  it("imports packs while embedding is disabled", async () => {
    vault = await makeVault({ "a.md": note("seed") });
    await foreignPack("dev-other", { "a.md": note("seed") });
    const m = await start(machine("one"));
    m.index._disabled = { reason: "quota", since: "2026-01-01T00:00:00.000Z" };
    const edited = note("Edited while embedding is switched off.");
    await fs.writeFile(path.join(vault, "a.md"), edited);
    await m.index.reindexFile("a.md").catch(() => {});
    const name = await foreignPack("dev-other", { "a.md": edited });
    m.emit(packEvent(name));
    await m.index.whenIdle();
    assert.equal(m.index.health().staleFiles, 0);
    assert.equal(fake.calls.length, 0);
  });

  it("a failing embedding request leaves the chunk waiting and the note stale", async () => {
    vault = await makeVault({});
    const m = await start(machine("one"));
    fake.handler = () => errorResponse(500, "boom");
    await fs.writeFile(path.join(vault, "a.md"), note("Body."));
    m.index.notifyChanged("a.md");
    await m.index.whenIdle();
    assert.equal(m.index.health().staleFiles, 1);
    assert.deepEqual(storedPaths(m), []);
  });

  it("a failed pack write is logged and never fails the tool call", async () => {
    vault = await makeVault({});
    await fs.mkdir(path.join(vault, "06-System"), { recursive: true });
    await fs.writeFile(path.join(vault, "06-System", "vault-pkm"), "a file where the folder should be");
    const m = await start(machine("one"));
    await fs.writeFile(path.join(vault, "a.md"), note("Body."));
    m.index.notifyChanged("a.md");
    await m.index.whenIdle();
    assert.deepEqual(storedPaths(m), ["a.md"]);
    assert.ok(errors.some(e => /pack/i.test(e)), errors.join("\n"));
  });

  it("vectors embedded outside tool writes are flushed to a pack by shutdown", async () => {
    vault = await makeVault({ "a.md": note("Embedded by the startup catch-up.") });
    const m = machine("one");
    await start(m);
    m.clock.t += GRACE_MS;
    await m.index.reindexFile("a.md");
    await m.index.shutdown();
    const own = (await listPacks(cacheDirAbs())).filter(p => p.deviceId === m.settings.deviceId);
    assert.ok(own.length >= 1);
  });

  it("W9: when most of this device's entries are dead the holder compacts once and other devices' packs survive", async () => {
    vault = await makeVault({ "n/a.md": note("v0 a"), "n/b.md": note("v0 b"), "n/c.md": note("v0 c") });
    const m = await start(machine("one"));
    await afterGrace(m);
    const theirs = await foreignPack("dev-other", { "q.md": note("Their own note.") });
    const theirsBytes = await fs.readFile(path.join(cacheDirAbs(), theirs));
    for (const v of [1, 2]) {
      for (const k of ["a", "b", "c"]) {
        await fs.writeFile(path.join(vault, `n/${k}.md`), note(`v${v} ${k}`));
        m.index.notifyChanged(`n/${k}.md`);
        await m.index.whenIdle();
      }
    }
    // Nine entries of this device, three live.
    m.clock.t += 2 * HOUR;
    await m.index._tick();
    assert.equal(m.compactCalls.length, 1);
    await m.index._tick();
    m.clock.t += HOUR;
    await m.index._tick();
    assert.equal(m.compactCalls.length, 1);

    const second = await start(machine("two"));
    assert.equal(storedPaths(second).filter(p => p.startsWith("n/")).length, 3);
    assert.equal(fake.calls.length, 3 + 6, "only the first machine ever paid");
    assert.deepEqual(await fs.readFile(path.join(cacheDirAbs(), theirs)), theirsBytes);
  });

  it("compaction leaves packs younger than an hour alone", async () => {
    vault = await makeVault({ "a.md": note("v0") });
    const m = await start(machine("one"));
    for (const v of [1, 2, 3]) {
      await fs.writeFile(path.join(vault, "a.md"), note(`v${v}`));
      m.index.notifyChanged("a.md");
      await m.index.whenIdle();
    }
    const before = (await listPacks(cacheDirAbs())).map(p => p.name).sort();
    await m.index._tick();
    assert.deepEqual((await listPacks(cacheDirAbs())).map(p => p.name).sort(), before);
  });

  it("merges more than 100 small packs even when none are dead", async () => {
    const files = manyNotes(101);
    vault = await makeVault({});
    const m = await start(machine("one"));
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
      await fs.writeFile(path.join(vault, rel), content);
      m.index.notifyChanged(rel);
      await m.index.whenIdle();
    }
    assert.equal((await listPacks(cacheDirAbs())).length, 101);
    m.clock.t += 2 * HOUR;
    await m.index._tick();
    assert.equal(m.compactCalls.length, 1);
    assert.equal((await listPacks(cacheDirAbs())).length, 1);
    const second = await start(machine("two"));
    assert.equal(storedPaths(second).length, 101);
    assert.equal(fake.calls.length, 101);
  });

  it("never compacts while the index has not caught up with the vault", async () => {
    vault = await makeVault({ "a.md": note("Cannot be embedded right now.") });
    fake.handler = () => errorResponse(401, "bad key");
    const m = machine("one");
    m.index._disabled = { reason: "bad key", since: "2026-01-01T00:00:00.000Z" };
    const w = new PackWriter({ cacheDirAbs: cacheDirAbs(), deviceId: m.settings.deviceId, model: "text-embedding-3-small", dims: DIMS });
    w.add("b".repeat(64), fakeEmbedding("x"));
    await w.flush();
    await start(m);
    assert.equal(m.index.health().staleFiles, 1);
    m.clock.t += 2 * HOUR;
    await m.index._tick();
    assert.equal(m.compactCalls.length, 0);
    assert.equal((await listPacks(cacheDirAbs())).length, 1);
  });
});
