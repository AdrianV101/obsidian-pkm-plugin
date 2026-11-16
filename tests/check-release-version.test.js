import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { checkReleaseVersion } from "../scripts/release-version.js";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "check-release-version.js");

describe("checkReleaseVersion", () => {
  it("accepts a tag ref named v<version> when package.json and plugin.json agree", () => {
    assert.equal(
      checkReleaseVersion({ refType: "tag", refName: "v3.11.0", packageVersion: "3.11.0", pluginVersion: "3.11.0" }),
      null
    );
  });

  it("rejects any ref that is not a tag", () => {
    for (const refType of ["branch", "", undefined]) {
      const error = checkReleaseVersion({ refType, refName: "master", packageVersion: "3.11.0", pluginVersion: "3.11.0" });
      assert.match(error ?? "", /must run on a tag/, `refType ${JSON.stringify(refType)}`);
    }
  });

  it("rejects a tag that is not exactly v<package.json version>", () => {
    for (const refName of ["3.11.0", "v3.11.1", "v3.11.0-rc.1", "release-3.11.0", "V3.11.0"]) {
      const error = checkReleaseVersion({ refType: "tag", refName, packageVersion: "3.11.0", pluginVersion: "3.11.0" });
      assert.match(error ?? "", /expected v3\.11\.0/, refName);
    }
  });

  it("rejects mismatched package.json and plugin.json versions even when the tag matches one of them", () => {
    for (const [packageVersion, pluginVersion] of [["3.11.0", "3.10.1"], ["3.10.1", "3.11.0"]]) {
      const error = checkReleaseVersion({ refType: "tag", refName: "v3.11.0", packageVersion, pluginVersion });
      assert.match(error ?? "", /does not match \.claude-plugin\/plugin\.json/, `${packageVersion} vs ${pluginVersion}`);
    }
  });
});

describe("check-release-version CLI", () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pkm-release-"));
    await fs.mkdir(path.join(dir, ".claude-plugin"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "3.11.0" }));
    await fs.writeFile(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "3.11.0" }));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function run(env, args = [SCRIPT]) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: dir,
        env: { PATH: process.env.PATH, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    });
  }

  it("checks the working directory's manifests against GITHUB_REF_TYPE/GITHUB_REF_NAME: exit 0 on a match, exit 1 with the reason on stderr otherwise", async () => {
    const pass = await run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v3.11.0" });
    assert.equal(pass.code, 0, pass.stderr);
    assert.match(pass.stdout, /v3\.11\.0/);

    const failure = await run({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "master" });
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /must run on a tag/);
  });

  it("never exits silently with 0: even when loaded rather than run as the entry point, a mismatch fails and a match prints the pass line", async () => {
    // A file URL, not a path: import() reads "D:\..." as a URL with the scheme "d:" on Windows.
    const loader = ["-e", `import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`];
    const failure = await run({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "master" }, loader);
    assert.equal(failure.code, 1, "mismatch must not pass");
    assert.match(failure.stderr, /must run on a tag/);

    const pass = await run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v3.11.0" }, loader);
    assert.equal(pass.code, 0, pass.stderr);
    assert.match(pass.stdout, /Release version check passed: v3\.11\.0/);
  });
});
