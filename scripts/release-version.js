// Pure release-guard logic for .github/workflows/publish.yml; see check-release-version.js.

/**
 * Why this ref may not be published, or null when it may.
 * @param {{ refType: string|undefined, refName: string|undefined, packageVersion: string, pluginVersion: string,
 *   serverSpec: string|null }} input serverSpec: the obsidian-pkm package plugin.json starts, as written
 * @returns {string|null}
 */
export function checkReleaseVersion({ refType, refName, packageVersion, pluginVersion, serverSpec }) {
  if (refType !== "tag") {
    return `Publish must run on a tag ref, got ${refType || "no ref type"} "${refName ?? ""}".`;
  }
  if (packageVersion !== pluginVersion) {
    return `package.json version ${packageVersion} does not match .claude-plugin/plugin.json version ${pluginVersion}.`;
  }
  if (refName !== `v${packageVersion}`) {
    return `Tag "${refName}" does not match the package version: expected v${packageVersion}.`;
  }
  // An exact pin, so the server the plugin installs is the one this tag publishes.
  if (serverSpec !== `obsidian-pkm@${packageVersion}`) {
    return `.claude-plugin/plugin.json must start the server as obsidian-pkm@${packageVersion}, not ${serverSpec ?? "nothing"}.`;
  }
  return null;
}
