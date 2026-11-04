import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HousekeeperLease } from "../lease.js";

let stateDir;
let clock;
const leases = [];
const make = (opts = {}) => {
  const l = new HousekeeperLease({ stateDir, now: () => clock.t, heartbeatMs: 10, staleMs: 1000, ...opts });
  leases.push(l);
  return l;
};
const until = async (cond, ms = 100) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  return cond();
};

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lease-"));
  clock = { t: 1_000_000 };
});
afterEach(async () => {
  await Promise.all(leases.splice(0).map((l) => l.release()));
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("HousekeeperLease", () => {
  it("L1: the first tryAcquire wins and a second lease on the same folder loses", async () => {
    const a = make();
    const b = make();
    assert.equal(await a.tryAcquire(), true);
    assert.equal(a.isHolder, true);
    assert.equal(await b.tryAcquire(), false);
    assert.equal(b.isHolder, false);
  });

  it("L2: two leases racing give exactly one holder, 50 times", async () => {
    for (let i = 0; i < 50; i++) {
      const dir = await fs.mkdtemp(path.join(stateDir, "race-"));
      const a = new HousekeeperLease({ stateDir: dir, now: () => clock.t });
      const b = new HousekeeperLease({ stateDir: dir, now: () => clock.t });
      leases.push(a, b);
      const results = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(Number(a.isHolder) + Number(b.isHolder), 1);
    }
  });

  it("L3: after release a reader's next retry acquires and runs onAcquired", async () => {
    const a = make();
    const b = make();
    await a.tryAcquire();
    await b.tryAcquire();
    let acquired = 0;
    b.onAcquired(() => { acquired++; });
    await a.release();
    assert.equal(a.isHolder, false);
    assert.ok(await until(() => acquired === 1), "reader did not take over");
    assert.equal(b.isHolder, true);
  });

  it("L4: a holder that stops heartbeating is taken over and then sees it lost the lease", async () => {
    const a = make({ heartbeatMs: 10_000 }); // its own timer never fires during the test
    const b = make();
    await a.tryAcquire();
    let lost = 0;
    a.onLost(() => { lost++; });
    clock.t += 5000;
    assert.equal(await b.tryAcquire(), true);
    assert.equal(b.isHolder, true);
    await a.heartbeat();
    assert.equal(a.isHolder, false);
    assert.equal(lost, 1);
    assert.equal(b.isHolder, true);
  });

  it("a live holder's heartbeat keeps the lock fresh against a later reader", async () => {
    const a = make();
    const b = make();
    await a.tryAcquire();
    clock.t += 900;
    await a.heartbeat();
    clock.t += 900;
    assert.equal(await b.tryAcquire(), false);
    assert.equal(a.isHolder, true);
  });

  it("simultaneous takeover of a stale lock has exactly one winner, 50 times", async () => {
    for (let i = 0; i < 50; i++) {
      const dir = await fs.mkdtemp(path.join(stateDir, "take-"));
      const opts = { stateDir: dir, now: () => clock.t, staleMs: 1000 };
      const old = new HousekeeperLease({ ...opts, heartbeatMs: 10_000 });
      await old.tryAcquire();
      clock.t += 5000;
      const rivals = [new HousekeeperLease(opts), new HousekeeperLease(opts), new HousekeeperLease(opts)];
      leases.push(old, ...rivals);
      const results = await Promise.all(rivals.map((r) => r.tryAcquire()));
      assert.equal(results.filter(Boolean).length, 1);
    }
  });

  it("release removes the lock only when this lease owns it", async () => {
    const a = make({ heartbeatMs: 10_000 });
    const b = make();
    await a.tryAcquire();
    clock.t += 5000;
    await b.tryAcquire();
    await a.release();
    const c = make();
    assert.equal(await c.tryAcquire(), false, "old holder's release removed the new holder's lock");
    await b.release();
    assert.equal(await c.tryAcquire(), true);
  });

  it("recovers from a corrupt lock file and a crashed takeover guard", async () => {
    await fs.writeFile(path.join(stateDir, "housekeeper.lock"), "not json");
    await fs.writeFile(path.join(stateDir, "housekeeper.takeover.lock"), String(clock.t - 5000));
    assert.equal(await make().tryAcquire(), true);
  });

  it("release stops its timers", async () => {
    const a = make();
    await a.tryAcquire();
    await a.release();
    assert.equal(a.isHolder, false);
    await new Promise((r) => setTimeout(r, 30));
    const files = await fs.readdir(stateDir);
    assert.deepEqual(files, []);
  });
});
