import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadMachineSettings, readMachineSettings, otherMachineWaitMs } from "../machine-settings.js";

const run = promisify(execFile);
const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "machine-settings-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("device id", () => {
  it("P3 is created once and returned later", () => {
    const dir = path.join(tmp(), "state");
    const first = loadMachineSettings(dir, {});
    assert.ok(first.deviceId.length >= 8);
    assert.equal(loadMachineSettings(dir, {}).deviceId, first.deviceId);
  });

  it("P3 replaces a corrupt id file", () => {
    const dir = tmp();
    const first = loadMachineSettings(dir, {});
    const file = fs.readdirSync(dir).map((f) => path.join(dir, f))[0];
    fs.writeFileSync(file, "\u0000garbage with spaces");
    const second = loadMachineSettings(dir, {});
    assert.notEqual(second.deviceId, first.deviceId);
    assert.equal(loadMachineSettings(dir, {}).deviceId, second.deviceId);
  });

  it("processes starting at the same moment agree on one id", async () => {
    const dir = path.join(tmp(), "state");
    const modUrl = new URL("../machine-settings.js", import.meta.url).href;
    const script = `import(${JSON.stringify(modUrl)}).then(m => console.log(m.loadMachineSettings(${JSON.stringify(dir)}, {}).deviceId))`;
    const outs = await Promise.all(
      Array.from({ length: 8 }, () => run(process.execPath, ["-e", script])),
    );
    const ids = new Set(outs.map((o) => o.stdout.trim()));
    assert.equal(ids.size, 1);
    assert.equal(loadMachineSettings(dir, {}).deviceId, [...ids][0]);
  });
});

describe("environment", () => {
  const dir = () => tmp();
  it("P4 defaults", () => {
    const s = loadMachineSettings(dir(), {});
    assert.equal(s.backstop, false);
    assert.equal(s.sharedCache, true);
  });

  for (const [value, expected] of [["1", true], ["true", true], ["0", false], ["yes", false], ["", false], ["TRUE", false]]) {
    it(`P4 VAULT_PKM_BACKSTOP=${JSON.stringify(value)} -> ${expected}`, () => {
      assert.equal(loadMachineSettings(dir(), { VAULT_PKM_BACKSTOP: value }).backstop, expected);
    });
  }

  for (const [value, expected] of [["off", false], ["0", false], ["false", false], ["on", true], ["1", true], ["", true], ["no", true]]) {
    it(`P4 VAULT_PKM_SHARED_CACHE=${JSON.stringify(value)} -> ${expected}`, () => {
      assert.equal(loadMachineSettings(dir(), { VAULT_PKM_SHARED_CACHE: value }).sharedCache, expected);
    });
  }
});

describe("otherMachineWaitMs", () => {
  it("P5", () => {
    assert.equal(otherMachineWaitMs({ backstop: true }), 300000);
    assert.equal(otherMachineWaitMs({ backstop: false }), 1800000);
  });
});

describe("readMachineSettings", () => {
  it("reads without creating anything, and sees an existing device id", () => {
    const dir = path.join(tmp(), "state");
    const before = readMachineSettings(dir, { VAULT_PKM_BACKSTOP: "1", VAULT_PKM_SHARED_CACHE: "off" });
    assert.deepEqual(before, { deviceId: null, backstop: true, sharedCache: false });
    assert.equal(fs.existsSync(dir), false);
    const created = loadMachineSettings(dir, {});
    assert.equal(readMachineSettings(dir, {}).deviceId, created.deviceId);
  });
});
