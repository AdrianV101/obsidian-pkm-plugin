// The session-start block that tells Claude which upgrade steps are left.
// Hooks run without node_modules: relative and node: imports only.

export const UPGRADE_BLOCK_MAX = 1200;

const HEADER = [
  "### vault-pkm: upgrade steps left",
  "After the user's first request, mention these once, briefly. Ask before running anything. " +
    '"Not now": drop it for this session. "Never": run that step\'s Never command.',
];

/** @param {string} label @returns {(step: import("../upgrade-checks.js").UpgradeStep) => string} */
const stepLine = (label) => (step) => `- ${label}: ${step.summary} ${step.fix} Never: \`${step.dismiss}\``;

/**
 * @param {import("../upgrade-checks.js").UpgradeReport} report
 * @param {{ doctorCommand: string, maxChars?: number }} options
 * @returns {string} "" when nothing is left
 */
export function formatUpgradeBlock(report, { doctorCommand, maxChars = UPGRADE_BLOCK_MAX }) {
  const left = report.steps.filter((s) => s.state === "left");
  const required = left.filter((s) => s.required).map(stepLine("Required"));
  const optional = left.filter((s) => !s.required).map(stepLine("Optional"));
  const others = report.otherProjects;
  if (required.length === 0 && optional.length === 0 && others.length === 0) return "";

  const named = others.length > 0 ? `- Also never migrated: ${others.join(", ")}. ${report.othersFix}` : null;
  const counted = others.length > 0
    ? `- Also never migrated: ${others.length} other project${others.length === 1 ? "" : "s"}. ${report.othersFix}`
    : null;
  const doctorLine = `- Not every step fits here: \`${doctorCommand}\` lists them all.`;
  /** @param {string[]} req @param {string|null} othersLine @param {string[]} opt @param {boolean} cut */
  const build = (req, othersLine, opt, cut) =>
    [...HEADER, ...req, ...(othersLine ? [othersLine] : []), ...opt, ...(cut ? [doctorLine] : [])].join("\n");

  // Cuts in order of what Claude can best do without: other projects' names, optional
  // steps (last first), the other projects altogether, then required steps (last first).
  const candidates = [build(required, named, optional, false)];
  for (let keep = optional.length; keep >= 0; keep--) candidates.push(build(required, counted, optional.slice(0, keep), true));
  for (let keep = required.length; keep >= 0; keep--) candidates.push(build(required.slice(0, keep), null, [], true));
  return candidates.find((block) => block.length <= maxChars) ?? "";
}
