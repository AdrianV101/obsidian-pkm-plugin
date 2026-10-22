// Rules for every session that has this server connected. Subagents don't
// receive server instructions, so skills/pkm-write/SKILL.md keeps a copy of the
// routing table; tests/instructions.test.js keeps the two equal.

export const ROUTING_ROWS = [
  { content: "Architecture decision", location: "`<project>/development/decisions/ADR-NNN-<title>.md`", template: "`adr`" },
  { content: "Research finding", location: "`<project>/research/<title>.md`", template: "`research-note`" },
  { content: "Bug investigation", location: "`<project>/development/debug/<title>.md`", template: "`troubleshooting-log`" },
  { content: "Design doc", location: "`<project>/development/designs/<title>.md`", template: "`research-note`" },
  { content: "Implementation plan", location: "`<project>/development/plans/<title>.md`", template: "`research-note`" },
  { content: "Task", location: "`<project>/tasks/<title>.md` (no project: `00-Inbox/`)", template: "`task`" },
  { content: "Meeting", location: "`<project>/planning/<title>.md`", template: "`meeting-notes`" },
  { content: "Reusable knowledge", location: "`03-Resources/Development/<title>.md`", template: "`permanent-note`" },
  { content: "Literature", location: "`03-Resources/<title>.md`", template: "`literature-note`" },
];

function routingTable() {
  return [
    "| Content | Location | Template |",
    "|---|---|---|",
    ...ROUTING_ROWS.map((r) => `| ${r.content} | ${r.location} | ${r.template} |`),
  ].join("\n");
}

export function buildServerInstructions({ vaultName }) {
  const name = encodeURIComponent(vaultName);
  return `vault-pkm rules

1. Links. Mention vault notes as [path.md](obsidian://open?vault=${name}&file=<path>) with "/" as %2F and spaces as %20, and drop .md from file= but keep it in the link text. Keep links that tools already emit.

2. New notes. Always use vault_write with a template; never create a note without frontmatter. Use the pkm-write skill for new notes (duplicate check, location, links). Search before creating.

3. Where notes go. <project> is the session's resolved project; a project's CLAUDE.md may override a location.

${routingTable()}

4. Capture. pkm-capture runs automatically when a PR is created. Dispatch it in the background after significant work blocks or before ending. Don't run pkm-session-end in the main conversation and don't edit the devlog by hand.

5. Agents and context. vault-explorer researches what the vault knows; link-auditor checks links after many note changes. The project's context is loaded at session start, so don't read _index.md, the devlog or tasks manually.
`;
}
