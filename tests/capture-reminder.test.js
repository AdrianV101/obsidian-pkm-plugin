import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const SCRIPT = path.join(import.meta.dirname, "..", "hooks", "capture-reminder.js");
const PR_URL = "https://github.com/AdrianV101/obsidian-pkm-plugin/pull/42";
const TRANSCRIPT = "/home/u/.claude/projects/-home-u-repo/sess-123.jsonl";
const SESSION_ID = "sess-123";

/** Pipe `stdin` into the hook script and collect its output. */
function runHook(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(stdin);
  });
}

/** A PostToolUse payload for the Bash tool, shaped like the hooks reference. */
function bashEvent(command, toolResponse = { stdout: `${PR_URL}\n`, stderr: "", interrupted: false, isImage: false }) {
  return {
    session_id: SESSION_ID,
    transcript_path: TRANSCRIPT,
    cwd: "/home/u/repo",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "Open the pull request" },
    tool_response: toolResponse,
    tool_use_id: "toolu_01ABC",
  };
}

async function expectSilent(stdin) {
  const { stdout, code } = await runHook(stdin);
  assert.equal(code, 0);
  assert.equal(stdout, "");
}

async function expectReminder(stdin) {
  const { stdout, code } = await runHook(stdin);
  assert.equal(code, 0);
  assert.notEqual(stdout, "", "expected a reminder on stdout");
  return JSON.parse(stdout);
}

describe("capture-reminder hook", { concurrency: true }, () => {
  describe("fires for real gh pr create invocations", { concurrency: true }, () => {
    const commands = [
      "gh pr create",
      "gh pr create --draft --title \"feat: x\" --body \"y\"",
      "git push -u origin feat && gh pr create --draft --fill",
      "npm test; gh pr create --fill",
      "git push -u origin feat\ngh pr create --fill",
      "gh pr create --fill 2>&1 | tail -1",
      "git push && \\\n  gh pr create --fill",
      "gh pr create \\\n  --draft --title x",
      "GH_HOST=x gh pr create --fill",
      "cd repo && GH_HOST=x A=1 gh pr create --fill",
      "GH_TOKEN=\"$(gh auth token --user AdrianV101)\" gh pr create --draft --fill",
      "GH_TOKEN=$(gh auth token --user AdrianV101) gh pr create --draft --fill",
      "URL=$(gh pr create --fill) && echo \"$URL\"",
      "URL=\"$(gh pr create --draft --fill)\"; echo \"$URL\"",
      "$(gh pr create --fill)",
      "/opt/homebrew/bin/gh pr create --fill",
      "GH_HOST=x /usr/local/bin/gh pr create --draft",
      "gh pr create --draft --title \"fix: a; b && c | d\" --body \"$(cat <<'EOF'\n## Summary\nIt's done.\nEOF\n)\"",
    ];
    for (const command of commands) {
      it(JSON.stringify(command), async () => {
        await expectReminder(JSON.stringify(bashEvent(command)));
      });
    }
  });

  describe("stays silent for commands that only mention gh pr create or run another gh pr subcommand", { concurrency: true }, () => {
    const commands = [
      "grep \"gh pr create\" hooks/README.md",
      "echo gh pr create",
      "echo \"next: gh pr create --draft\"",
      "git commit -m \"docs: explain the gh pr create flow\"",
      "URL=$(gh pr view 42 --json url) && echo \"$URL\"",
      "/opt/homebrew/bin/gh pr list",
      "/opt/homebrew/bin/ghx pr create",
      "gh pr view 42 --json url",
      "gh pr list --author @me",
    ];
    for (const command of commands) {
      it(JSON.stringify(command), async () => {
        await expectSilent(JSON.stringify(bashEvent(command)));
      });
    }
  });

  describe("stays silent when the Bash stdout carries no pull request URL", { concurrency: true }, () => {
    const responses = {
      "empty stdout": { stdout: "", stderr: "", interrupted: false, isImage: false },
      "URL only on stderr (PR already exists)": {
        stdout: "",
        stderr: "a pull request for branch \"feat\" into branch \"next\" already exists:\nhttps://github.com/o/r/pull/12\n",
        interrupted: false,
        isImage: false,
      },
      "git push compare link (pull/new/<branch>)": {
        stdout: "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:   https://github.com/o/r/pull/new/feat\n",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
      "issue URL": { stdout: "https://github.com/o/r/issues/5\n", stderr: "", interrupted: false, isImage: false },
      "missing tool_response": undefined,
    };
    for (const [name, response] of Object.entries(responses)) {
      it(name, async () => {
        const event = bashEvent("gh pr create --fill", response);
        if (response === undefined) delete event.tool_response;
        await expectSilent(JSON.stringify(event));
      });
    }
  });

  describe("reads the PR URL from stdout, output, or a plain-string response", { concurrency: true }, () => {
    const responses = {
      "stdout field": { stdout: `Creating pull request for feat into next\n\n${PR_URL}\n`, stderr: "" },
      "output field": { output: `${PR_URL}\n` },
      "plain string": `${PR_URL}\n`,
    };
    for (const [name, response] of Object.entries(responses)) {
      it(name, async () => {
        const out = await expectReminder(JSON.stringify(bashEvent("gh pr create --fill", response)));
        assert.ok(out.hookSpecificOutput.additionalContext.includes(PR_URL));
      });
    }
  });

  it("emits PostToolUse additionalContext naming the PR URL, transcript_path and session_id and asking for a background pkm-capture", async () => {
    const out = await expectReminder(JSON.stringify(bashEvent("gh pr create --fill")));
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.equal(typeof ctx, "string");
    assert.ok(ctx.includes("pkm-capture"), ctx);
    assert.ok(ctx.includes("background"), ctx);
    assert.ok(ctx.includes(`PR: ${PR_URL}`), ctx);
    assert.ok(ctx.includes(`transcript_path: ${TRANSCRIPT}`), ctx);
    assert.ok(ctx.includes(`session_id: ${SESSION_ID}`), ctx);
  });

  it("leaves out transcript_path and session_id when the hook input lacks them", async () => {
    const event = bashEvent("gh pr create --fill");
    delete event.transcript_path;
    delete event.session_id;
    const ctx = (await expectReminder(JSON.stringify(event))).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(`PR: ${PR_URL}`), ctx);
    assert.ok(!ctx.includes("transcript_path"), ctx);
    assert.ok(!ctx.includes("session_id"), ctx);
    assert.ok(!ctx.includes("undefined"), ctx);
  });

  it("ignores non-Bash tool events even when their input and response look like a PR creation", async () => {
    const event = bashEvent("gh pr create --fill");
    event.tool_name = "mcp__github__create_pull_request";
    await expectSilent(JSON.stringify(event));
  });

  describe("exits 0 with no output on malformed or non-object stdin", { concurrency: true }, () => {
    for (const stdin of ["", "not json", "{\"tool_name\":", "null", "42", "[]"]) {
      it(JSON.stringify(stdin), async () => {
        await expectSilent(stdin);
      });
    }
  });
});
