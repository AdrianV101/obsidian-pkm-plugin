// Pure release-guard logic for .github/workflows/publish.yml; see check-release-version.js.

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
