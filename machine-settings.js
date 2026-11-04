import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEVICE_FILE = "device-id";
const VALID_ID = /^[0-9a-f-]{8,64}$/;

export const BACKSTOP_WAIT_MS = 5 * 60 * 1000;
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;

function readId(file) {
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    return VALID_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Link-based create is exclusive and the file appears complete, so racing
// processes converge on whichever id landed first.
function createId(file) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const id = crypto.randomUUID();
  fs.writeFileSync(tmp, id + "\n");
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return readId(file);
}

function loadDeviceId(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, DEVICE_FILE);
  const existing = readId(file);
  if (existing) return existing;
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  for (let i = 0; i < 5; i++) {
    const id = createId(file);
    if (id) return id;
    fs.rmSync(file, { force: true });
  }
  throw new Error(`Could not create a device id in ${stateDir}`);
}

function settingsFromEnv(env) {
  return {
    backstop: env.VAULT_PKM_BACKSTOP === "1" || env.VAULT_PKM_BACKSTOP === "true",
    sharedCache: !["off", "0", "false"].includes(env.VAULT_PKM_SHARED_CACHE),
  };
}

export function loadMachineSettings(stateDir, env = process.env) {
  return { deviceId: loadDeviceId(stateDir), ...settingsFromEnv(env) };
}

/** Like loadMachineSettings, but creates nothing: `deviceId` is null until a server has made one. */
export function readMachineSettings(stateDir, env = process.env) {
  return { deviceId: readId(path.join(stateDir, DEVICE_FILE)), ...settingsFromEnv(env) };
}

export function otherMachineWaitMs(settings) {
  return settings.backstop ? BACKSTOP_WAIT_MS : DEFAULT_WAIT_MS;
}
