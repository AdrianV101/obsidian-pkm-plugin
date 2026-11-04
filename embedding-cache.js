import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export const CACHE_FOLDER = "06-System/vault-pkm/embeddings";

// Obsidian Sync Standard caps files at 5 MB.
const MAX_PACK_BYTES = 4_000_000;
const MAGIC = Buffer.from("VPKE");
const FORMAT_VERSION = 1;
const HASH_BYTES = 32;
const CHECKSUM_BYTES = 32;
// magic, version u16, dims u16, entry count u32, model length u16, device length u16
const FIXED_HEADER_BYTES = 4 + 2 + 2 + 4 + 2 + 2;

// The device id is everything before the last three dash-free segments, so ids
// may themselves contain dashes.
const PACK_NAME = /^([A-Za-z0-9_-]+)-\d+-\d+-[0-9a-f]+\.pack$/;
const DEVICE_ID = /^[A-Za-z0-9_-]+$/;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const m = mant | 0x800000;
    const shift = 14 - e;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // A carry out of the mantissa correctly bumps the exponent, up to infinity.
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return half;
}

function fromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function checksum(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function headerBytes(model, deviceId) {
  return FIXED_HEADER_BYTES + Buffer.byteLength(model) + Buffer.byteLength(deviceId);
}

function encodePack({ model, dims, deviceId, entries }) {
  const modelBuf = Buffer.from(model);
  const deviceBuf = Buffer.from(deviceId);
  const entryBytes = HASH_BYTES + dims * 2;
  const headLen = headerBytes(model, deviceId);
  const buf = Buffer.alloc(headLen + entries.length * entryBytes + CHECKSUM_BYTES);
  MAGIC.copy(buf, 0);
  buf.writeUInt16LE(FORMAT_VERSION, 4);
  buf.writeUInt16LE(dims, 6);
  buf.writeUInt32LE(entries.length, 8);
  buf.writeUInt16LE(modelBuf.length, 12);
  buf.writeUInt16LE(deviceBuf.length, 14);
  modelBuf.copy(buf, FIXED_HEADER_BYTES);
  deviceBuf.copy(buf, FIXED_HEADER_BYTES + modelBuf.length);
  let off = headLen;
  for (const { hash, vector } of entries) {
    Buffer.from(hash, "hex").copy(buf, off);
    off += HASH_BYTES;
    for (let i = 0; i < dims; i++, off += 2) buf.writeUInt16LE(toHalf(vector[i]), off);
  }
  checksum(buf.subarray(0, off)).copy(buf, off);
  return buf;
}

function decodePack(buf) {
  if (buf.length < FIXED_HEADER_BYTES + CHECKSUM_BYTES) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  if (buf.readUInt16LE(4) !== FORMAT_VERSION) return null;
  const dims = buf.readUInt16LE(6);
  const count = buf.readUInt32LE(8);
  const modelLen = buf.readUInt16LE(12);
  const deviceLen = buf.readUInt16LE(14);
  if (dims === 0) return null;
  const headLen = FIXED_HEADER_BYTES + modelLen + deviceLen;
  const entryBytes = HASH_BYTES + dims * 2;
  if (buf.length !== headLen + count * entryBytes + CHECKSUM_BYTES) return null;
  const body = buf.subarray(0, buf.length - CHECKSUM_BYTES);
  if (!checksum(body).equals(buf.subarray(buf.length - CHECKSUM_BYTES))) return null;
  const model = buf.toString("utf8", FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + modelLen);
  const deviceId = buf.toString("utf8", FIXED_HEADER_BYTES + modelLen, headLen);
  const entries = [];
  let off = headLen;
  for (let n = 0; n < count; n++) {
    const hash = buf.toString("hex", off, off + HASH_BYTES);
    off += HASH_BYTES;
    const vector = new Float32Array(dims);
    for (let i = 0; i < dims; i++, off += 2) vector[i] = fromHalf(buf.readUInt16LE(off));
    entries.push({ hash, vector });
  }
  return { model, dims, deviceId, entries };
}

export class PackWriter {
  /**
   * @param {{ cacheDirAbs: string, deviceId: string, model: string, dims: number }} opts
   */
  constructor({ cacheDirAbs, deviceId, model, dims }) {
    if (!DEVICE_ID.test(deviceId)) throw new Error(`Unusable device id: ${deviceId}`);
    this.cacheDirAbs = cacheDirAbs;
    this.deviceId = deviceId;
    this.model = model;
    this.dims = dims;
    this._groups = [[]];
    this._bytes = headerBytes(model, deviceId) + CHECKSUM_BYTES;
    this._entryBytes = HASH_BYTES + dims * 2;
  }

  /**
   * @param {string} hash hex chunk hash
   * @param {ArrayLike<number>} vector
   */
  add(hash, vector) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Pack hash must be 64 hex characters");
    if (vector.length !== this.dims) throw new Error(`Vector has ${vector.length} dims, expected ${this.dims}`);
    if (this._bytes + this._entryBytes >= MAX_PACK_BYTES) {
      this._groups.push([]);
      this._bytes = headerBytes(this.model, this.deviceId) + CHECKSUM_BYTES;
    }
    this._groups[this._groups.length - 1].push({ hash, vector });
    this._bytes += this._entryBytes;
  }

  /** Writes everything added so far; resolves to the last pack's file name, or null if nothing was added. */
  async flush() {
    const groups = this._groups.filter((g) => g.length > 0);
    this._groups = [[]];
    this._bytes = headerBytes(this.model, this.deviceId) + CHECKSUM_BYTES;
    let last = null;
    for (const entries of groups) {
      const buf = encodePack({ model: this.model, dims: this.dims, deviceId: this.deviceId, entries });
      const name = `${this.deviceId}-${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.pack`;
      await fs.mkdir(this.cacheDirAbs, { recursive: true });
      // The temp name never matches a pack name, so a half-written file is never listed.
      const tmp = path.join(this.cacheDirAbs, `${name}.tmp`);
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, path.join(this.cacheDirAbs, name));
      last = name;
    }
    return last;
  }
}

/**
 * @param {string} cacheDirAbs
 * @returns {Promise<Array<{ name: string, deviceId: string }>>}
 */
export async function listPacks(cacheDirAbs) {
  let names;
  try {
    names = await fs.readdir(cacheDirAbs);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = PACK_NAME.exec(name);
    if (m) out.push({ name, deviceId: m[1] });
  }
  return out;
}

/**
 * Returns null for anything that is not a complete pack of this format, so a
 * half-synced file is skipped now and read again once it is whole.
 * @param {string} absPath
 */
export async function readPack(absPath) {
  let buf;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return decodePack(buf);
}

/**
 * Rewrites this device's live entries into new packs, then deletes the old
 * packs. A crash between the two steps duplicates entries but loses none.
 * @param {{ cacheDirAbs: string, deviceId: string, isLive: (hash: string) => boolean }} opts
 */
export async function compactOwnPacks({ cacheDirAbs, deviceId, isLive }) {
  const own = (await listPacks(cacheDirAbs)).filter((p) => p.deviceId === deviceId);
  const readable = [];
  let dropped = 0;
  const live = new Map();
  for (const { name } of own) {
    const pack = await readPack(path.join(cacheDirAbs, name));
    if (!pack) continue;
    readable.push(name);
    for (const e of pack.entries) {
      if (!isLive(e.hash)) {
        dropped++;
        continue;
      }
      const key = `${pack.model}\0${pack.dims}`;
      if (!live.has(key)) live.set(key, { model: pack.model, dims: pack.dims, entries: new Map() });
      live.get(key).entries.set(e.hash, e.vector);
    }
  }
  let kept = 0;
  for (const g of live.values()) kept += g.entries.size;
  if (dropped === 0) return { kept, dropped };
  for (const g of live.values()) {
    const writer = new PackWriter({ cacheDirAbs, deviceId, model: g.model, dims: g.dims });
    for (const [hash, vector] of g.entries) writer.add(hash, vector);
    await writer.flush();
  }
  for (const name of readable) await fs.rm(path.join(cacheDirAbs, name), { force: true });
  return { kept, dropped };
}
