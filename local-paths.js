import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = "vault-pkm";

function realOrResolved(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // The vault may not exist yet; fall back to the lexical path.
    return abs;
  }
}

export function vaultKey(vaultPath) {
  let real = realOrResolved(vaultPath);
  // Case-insensitive filesystems: spellings of one folder must share a key.
  if (process.platform === "win32" || process.platform === "darwin") real = real.toLowerCase();
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
}

function defaultEnv() {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
}

function resolveRoots(env) {
  const e = { ...defaultEnv(), ...env };
  if (e.platform === "win32") {
    const base = e.LOCALAPPDATA || path.win32.join(e.homedir, "AppData", "Local");
    return { p: path.win32, cache: path.win32.join(base, APP, "Cache"), state: path.win32.join(base, APP) };
  }
  if (e.platform === "darwin") {
    return {
      p: path.posix,
      cache: path.posix.join(e.homedir, "Library", "Caches", APP),
      state: path.posix.join(e.homedir, "Library", "Application Support", APP),
    };
  }
  return {
    p: path.posix,
    cache: path.posix.join(e.XDG_CACHE_HOME || path.posix.join(e.homedir, ".cache"), APP),
    state: path.posix.join(e.XDG_STATE_HOME || path.posix.join(e.homedir, ".local", "state"), APP),
  };
}

export function cacheDir(vaultPath, env = {}) {
  const r = resolveRoots(env);
  return r.p.join(r.cache, vaultKey(vaultPath));
}

export function stateDir(vaultPath, env = {}) {
  const r = resolveRoots(env);
  return r.p.join(r.state, vaultKey(vaultPath));
}
