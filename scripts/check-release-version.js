#!/usr/bin/env node

// Release guard for .github/workflows/publish.yml: publishing is only allowed
// from a tag named v<version>, where package.json and .claude-plugin/plugin.json
// carry that same version and plugin.json starts the server as obsidian-pkm@<version>. Runs before `npm ci`, so it may only use node: builtins.
// Deliberately has no "am I the entry point" guard: any way of loading this file
// performs the check, so the gate cannot silently pass.

import fs from "node:fs";
import path from "node:path";
import { checkReleaseVersion } from "./release-version.js";

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), "utf-8"));
}

const packageVersion = readJson("package.json").version;
const plugin = readJson(".claude-plugin/plugin.json");
const args = plugin.mcpServers?.["vault-pkm"]?.args;
const serverSpec = (Array.isArray(args) ? args : []).find((arg) => typeof arg === "string" && /^obsidian-pkm(@\S+)?$/.test(arg)) ?? null;
const error = checkReleaseVersion({
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  packageVersion,
  pluginVersion: plugin.version,
  serverSpec,
});
if (error) {
  console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Release version check passed: v${packageVersion}`);
}
