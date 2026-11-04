import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CACHE_FOLDER,
  PackWriter,
  listPacks,
  readPack,
  compactOwnPacks,
  inspectOwnPacks,
} from "../embedding-cache.js";

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pack-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const hashOf = (s) => crypto.createHash("sha256").update(s).digest("hex");

function unitVector(dims) {
  const v = new Float32Array(dims);
  let n = 0;
  for (let i = 0; i < dims; i++) {
    v[i] = Math.random() * 2 - 1;
    n += v[i] * v[i];
  }
  n = Math.sqrt(n);
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

async function writePack(deviceId, items, dims = 8, model = "m") {
  const w = new PackWriter({ cacheDirAbs: dir, deviceId, model, dims });
  for (const [h, v] of items) w.add(h, v);
  return w.flush();
}

describe("embedding packs", () => {
  it("exposes the cache folder", () => {
    assert.equal(CACHE_FOLDER, "06-System/vault-pkm/embeddings");
  });

  it("K1: round trips hashes, header fields and vectors within float16 precision", async () => {
    const dims = 256;
    const items = Array.from({ length: 20 }, (_, i) => [hashOf(`c${i}`), unitVector(dims)]);
    const name = await writePack("dev-a", items, dims, "text-embedding-3-small");
    const pack = await readPack(path.join(dir, name));
    assert.equal(pack.model, "text-embedding-3-small");
    assert.equal(pack.dims, dims);
    assert.equal(pack.deviceId, "dev-a");
    assert.deepEqual(pack.entries.map((e) => e.hash), items.map(([h]) => h));
    const query = unitVector(dims);
    for (let i = 0; i < items.length; i++) {
      const got = pack.entries[i].vector;
      assert.ok(got instanceof Float32Array);
      assert.ok(Math.abs(dot(query, got) - dot(query, items[i][1])) < 0.001);
      for (let j = 0; j < dims; j++) assert.ok(Math.abs(got[j] - items[i][1][j]) < 1e-3);
    }
  });

  it("K1: float16 handles zero, tiny, large and negative values", async () => {
    const v = new Float32Array([0, -0.5, 1, 65504, 1e-6, -3.25, 1e9, 6e-8]);
    const name = await writePack("d", [[hashOf("x"), v]], 8);
    const got = (await readPack(path.join(dir, name))).entries[0].vector;
    assert.equal(got[0], 0);
    assert.equal(got[1], -0.5);
    assert.equal(got[2], 1);
    assert.equal(got[3], 65504);
    assert.equal(got[5], -3.25);
    assert.equal(got[6], Infinity);
    assert.ok(Math.abs(got[4] - 1e-6) < 1e-7);
  });

  it("K2: rotates before 4,000,000 bytes and every pack is under that size", async () => {
    const dims = 1536;
    const w = new PackWriter({ cacheDirAbs: dir, deviceId: "dev-a", model: "m", dims });
    const v = unitVector(dims);
    for (let i = 0; i < 2500; i++) w.add(hashOf(`h${i}`), v);
    await w.flush();
    const packs = await listPacks(dir);
    assert.ok(packs.length >= 2);
    let total = 0;
    for (const p of packs) {
      const st = await fs.stat(path.join(dir, p.name));
      assert.ok(st.size < 4_000_000, `${p.name} is ${st.size}`);
      total += (await readPack(path.join(dir, p.name))).entries.length;
    }
    assert.equal(total, 2500);
  });

  it("flush with nothing added writes nothing", async () => {
    const w = new PackWriter({ cacheDirAbs: dir, deviceId: "d", model: "m", dims: 4 });
    assert.equal(await w.flush(), null);
    assert.deepEqual(await fs.readdir(dir), []);
  });

  it("K3: names are unique per writer and the temp name is not listed", async () => {
    const v = unitVector(8);
    const names = new Set();
    for (const id of ["dev-a", "dev-a", "dev-b"]) names.add(await writePack(id, [[hashOf(id), v]]));
    assert.equal(names.size, 3);
    const w = new PackWriter({ cacheDirAbs: dir, deviceId: "dev-c", model: "m", dims: 8 });
    w.add(hashOf("z"), v);
    await w.flush();
    assert.equal((await listPacks(dir)).length, 4);
    await fs.writeFile(path.join(dir, "dev-x-1-2-ab.pack.tmp"), "partial");
    await fs.writeFile(path.join(dir, ".dev-x-1-2-ab.pack"), "partial");
    assert.equal((await listPacks(dir)).length, 4);
  });

  it("K4: returns null for truncated, corrupt, unknown-version and empty files", async () => {
    const name = await writePack("dev-a", [[hashOf("a"), unitVector(8)], [hashOf("b"), unitVector(8)]]);
    const full = await fs.readFile(path.join(dir, name));
    const check = async (buf) => {
      const p = path.join(dir, "probe.bin");
      await fs.writeFile(p, buf);
      return readPack(p);
    };
    assert.ok(await check(full));
    assert.equal(await check(full.subarray(0, full.length - 5)), null);
    assert.equal(await check(full.subarray(0, 10)), null);
    assert.equal(await check(Buffer.alloc(0)), null);
    const badMagic = Buffer.from(full);
    badMagic[0] ^= 0xff;
    assert.equal(await check(badMagic), null);
    const badVersion = Buffer.from(full);
    badVersion.writeUInt16LE(99, 4);
    assert.equal(await check(badVersion), null);
    const flipped = Buffer.from(full);
    flipped[flipped.length - 40] ^= 0x01;
    assert.equal(await check(flipped), null);
    assert.equal(await check(Buffer.concat([full, Buffer.from([0])])), null);
    assert.equal(await readPack(path.join(dir, "missing.pack")), null);
  });

  it("K5: lists only pack files with their device ids, including ids containing dashes", async () => {
    const v = unitVector(8);
    const a = await writePack("0b6e7c1a-1111-4222-8333-944455556666", [[hashOf("a"), v]]);
    const b = await writePack("laptop", [[hashOf("b"), v]]);
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    await fs.writeFile(path.join(dir, "weird.pack"), "x");
    const listed = await listPacks(dir);
    assert.deepEqual(
      listed.sort((x, y) => x.name.localeCompare(y.name)),
      [
        { name: a, deviceId: "0b6e7c1a-1111-4222-8333-944455556666" },
        { name: b, deviceId: "laptop" },
      ].sort((x, y) => x.name.localeCompare(y.name)),
    );
    assert.deepEqual(await listPacks(path.join(dir, "nope")), []);
  });

  it("rejects device ids that cannot round-trip through a file name", () => {
    assert.throws(() => new PackWriter({ cacheDirAbs: dir, deviceId: "a/b", model: "m", dims: 4 }));
    assert.throws(() => new PackWriter({ cacheDirAbs: dir, deviceId: "", model: "m", dims: 4 }));
  });

  it("K6: compaction keeps only live entries of this device and leaves other devices alone", async () => {
    const v = unitVector(8);
    const mine1 = await writePack("me", [[hashOf("a"), v], [hashOf("b"), v]]);
    const mine2 = await writePack("me", [[hashOf("c"), v], [hashOf("d"), v]]);
    const theirs = await writePack("other", [[hashOf("a"), v], [hashOf("zzz"), v]]);
    const theirsBytes = await fs.readFile(path.join(dir, theirs));
    const live = new Set([hashOf("a"), hashOf("c")]);
    const res = await compactOwnPacks({ cacheDirAbs: dir, deviceId: "me", isLive: (h) => live.has(h) });
    assert.deepEqual(res, { kept: 2, dropped: 2 });
    const names = (await listPacks(dir)).map((p) => p.name);
    assert.ok(!names.includes(mine1) && !names.includes(mine2));
    assert.ok(names.includes(theirs));
    assert.deepEqual(await fs.readFile(path.join(dir, theirs)), theirsBytes);
    const own = (await listPacks(dir)).filter((p) => p.deviceId === "me");
    const hashes = [];
    for (const p of own) hashes.push(...(await readPack(path.join(dir, p.name))).entries.map((e) => e.hash));
    assert.deepEqual(hashes.sort(), [hashOf("a"), hashOf("c")].sort());
  });

  it("K6: with no dead entries nothing is written or deleted", async () => {
    const v = unitVector(8);
    const mine = await writePack("me", [[hashOf("a"), v]]);
    const before = await fs.readdir(dir);
    const res = await compactOwnPacks({ cacheDirAbs: dir, deviceId: "me", isLive: () => true });
    assert.deepEqual(res, { kept: 1, dropped: 0 });
    assert.deepEqual(await fs.readdir(dir), before);
    assert.ok(before.includes(mine));
  });

  it("compaction leaves an unreadable own pack in place and survives a missing folder", async () => {
    const v = unitVector(8);
    await writePack("me", [[hashOf("a"), v], [hashOf("b"), v]]);
    const bad = "me-1-2-abc.pack";
    await fs.writeFile(path.join(dir, bad), "half-synced");
    const res = await compactOwnPacks({ cacheDirAbs: dir, deviceId: "me", isLive: (h) => h === hashOf("a") });
    assert.deepEqual(res, { kept: 1, dropped: 1 });
    assert.ok((await fs.readdir(dir)).includes(bad));
    assert.deepEqual(
      await compactOwnPacks({ cacheDirAbs: path.join(dir, "nope"), deviceId: "me", isLive: () => true }),
      { kept: 0, dropped: 0 },
    );
  });

  it("compaction leaves packs younger than olderThanMs alone", async () => {
    const v = unitVector(8);
    const young = await writePack("me", [[hashOf("a"), v], [hashOf("b"), v]]);
    const old = await writePack("me", [[hashOf("c"), v], [hashOf("d"), v]]);
    const hourAgo = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(path.join(dir, old), hourAgo, hourAgo);
    const res = await compactOwnPacks({
      cacheDirAbs: dir, deviceId: "me", isLive: () => false, olderThanMs: 3600_000,
    });
    assert.deepEqual(res, { kept: 0, dropped: 2 });
    const names = (await listPacks(dir)).map((p) => p.name);
    assert.ok(names.includes(young));
    assert.ok(!names.includes(old));
  });

  it("merge rewrites many small packs into one even when nothing is dead", async () => {
    const v = unitVector(8);
    for (const k of ["a", "b", "c"]) await writePack("me", [[hashOf(k), v]]);
    const theirs = await writePack("other", [[hashOf("z"), v]]);
    const res = await compactOwnPacks({ cacheDirAbs: dir, deviceId: "me", isLive: () => true, merge: true });
    assert.deepEqual(res, { kept: 3, dropped: 0 });
    const own = (await listPacks(dir)).filter((p) => p.deviceId === "me");
    assert.equal(own.length, 1);
    assert.equal((await readPack(path.join(dir, own[0].name))).entries.length, 3);
    assert.ok((await listPacks(dir)).some((p) => p.name === theirs));
  });

  it("inspectOwnPacks counts own packs, entries and dead entries without writing", async () => {
    const v = unitVector(8);
    await writePack("me", [[hashOf("a"), v], [hashOf("b"), v]]);
    await writePack("me", [[hashOf("c"), v]]);
    await writePack("other", [[hashOf("z"), v]]);
    const before = await fs.readdir(dir);
    const res = await inspectOwnPacks({ cacheDirAbs: dir, deviceId: "me", isLive: (h) => h === hashOf("a") });
    assert.deepEqual(res, { packs: 2, entries: 3, dead: 2 });
    assert.deepEqual(await fs.readdir(dir), before);
  });
});
