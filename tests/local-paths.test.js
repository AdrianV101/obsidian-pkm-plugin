import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vaultKey, cacheDir, stateDir } from "../local-paths.js";

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "local-paths-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("cacheDir and stateDir", () => {
  const vault = tmp();
  const key = vaultKey(vault);
  const cases = [
    {
      name: "darwin",
      env: { platform: "darwin", homedir: "/Users/x" },
      cache: `/Users/x/Library/Caches/vault-pkm/${key}`,
      state: `/Users/x/Library/Application Support/vault-pkm/${key}`,
    },
    {
      name: "linux with XDG",
      env: { platform: "linux", homedir: "/home/x", XDG_CACHE_HOME: "/xc", XDG_STATE_HOME: "/xs" },
      cache: `/xc/vault-pkm/${key}`,
      state: `/xs/vault-pkm/${key}`,
    },
    {
      name: "linux defaults",
      env: { platform: "linux", homedir: "/home/x" },
      cache: `/home/x/.cache/vault-pkm/${key}`,
      state: `/home/x/.local/state/vault-pkm/${key}`,
    },
    {
      name: "win32",
      env: { platform: "win32", homedir: "C:\\Users\\x", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
      cache: `C:\\Users\\x\\AppData\\Local\\vault-pkm\\Cache\\${key}`,
      state: `C:\\Users\\x\\AppData\\Local\\vault-pkm\\${key}`,
    },
  ];
  for (const c of cases) {
    it(`P1 ${c.name}`, () => {
      assert.equal(cacheDir(vault, c.env), c.cache);
      assert.equal(stateDir(vault, c.env), c.state);
    });
  }
});

describe("vaultKey", () => {
  it("P2 is stable, symlink- and separator-insensitive, and distinct per vault", () => {
    const a = tmp();
    const b = tmp();
    const link = path.join(tmp(), "link");
    fs.symlinkSync(a, link, "dir");
    assert.equal(vaultKey(a), vaultKey(a));
    assert.equal(vaultKey(a), vaultKey(link));
    assert.equal(vaultKey(a), vaultKey(a + path.sep));
    assert.notEqual(vaultKey(a), vaultKey(b));
  });

  it("does not throw for a vault that does not exist yet", () => {
    const missing = path.join(tmp(), "nope");
    assert.equal(vaultKey(missing), vaultKey(missing));
    assert.match(vaultKey(missing), /^[0-9a-f]+$/);
  });
});
