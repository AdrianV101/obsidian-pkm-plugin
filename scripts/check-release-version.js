#!/usr/bin/env node

// Release guard for .github/workflows/publish.yml: publishing is only allowed
// from a tag named v<version>, where package.json and .claude-plugin/plugin.json
// carry that same version. Runs before `npm ci`, so it may only use node: builtins.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Why this ref may not be published, or null when it may.
 * @param {{ refType: string|undefined, refName: string|undefined, packageVersion: string, pluginVersion: string }} input
 * @returns {string|null}
 */
export function checkReleaseVersion({ refType, refName, packageVersion, pluginVersion }) {
  if (refType !== "tag") {
    return `Publish must run on a tag ref, got ${refType || "no ref type"} "${refName ?? ""}".`;
  }
  if (packageVersion !== pluginVersion) {
    return `package.json version ${packageVersion} does not match .claude-plugin/plugin.json version ${pluginVersion}.`;
  }
  if (refName !== `v${packageVersion}`) {
    return `Tag "${refName}" does not match the package version: expected v${packageVersion}.`;
  }
  return null;
}

function readVersion(rel) {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), "utf-8")).version;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const packageVersion = readVersion("package.json");
  const error = checkReleaseVersion({
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
    packageVersion,
    pluginVersion: readVersion(".claude-plugin/plugin.json"),
  });
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Release version check passed: v${packageVersion}`);
  }
}
