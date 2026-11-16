import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dirname, "..", "hooks", "capture-reminder.js");
const PR_URL = "https://github.com/AdrianV101/obsidian-pkm-plugin/pull/42";
const TRANSCRIPT = "/home/u/.claude/projects/-home-u-repo/sess-123.jsonl";
const SESSION_ID = "sess-123";
const GH_ARGS = ["pr", "view", PR_URL, "--json", "additions,deletions"];
const tempDirs = [];

const sizeJson = (additions, deletions) => JSON.stringify({ additions, deletions });
const modelOf = (out) => out.hookSpecificOutput.additionalContext.match(/with model "(\w+)"/)?.[1];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-gh-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A fake `gh`, alone in its own directory, that logs every call's arguments.
 * It answers only `gh pr view <PR_URL> --json additions,deletions`, with
 * `stdout` and `exitCode`, and fails any other call. With `hang` it prints
 * `stdout` and never exits. A POSIX script, so it can't run on Windows.
 */
async function fakeGh({ stdout = "", exitCode = 0, hang = false } = {}) {
  const dir = await tempDir();
  const log = path.join(dir, "calls.log");
  await writeFile(log, "");
  const gh = path.join(dir, "gh");
  await writeFile(gh, [
    `#!${process.execPath}`,
    "const fs = require(\"node:fs\");",
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
    `if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(GH_ARGS))}) { process.stderr.write("unexpected arguments\\n"); process.exit(1); }`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    hang ? "setInterval(() => {}, 1000);" : `process.exitCode = ${exitCode};`,
  ].join("\n"));
  await chmod(gh, 0o755);
  const calls = async () => (await readFile(log, "utf-8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { dir, calls };
}

/** The test process's environment with PATH set to `dir` alone, so the real gh is never reached. */
function envWithPath(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  return { ...env, PATH: dir };
}

const smallPrGh = fakeGh({ stdout: sizeJson(10, 5) });

/** Pipe `stdin` into the hook script and collect its output. */
function runHook(stdin, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"], env });
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
  const gh = await fakeGh({ stdout: sizeJson(10, 5) });
  const { stdout, code } = await runHook(stdin, envWithPath(gh.dir));
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.deepEqual(await gh.calls(), [], "gh must not run when no reminder is due");
}

async function expectReminder(stdin, env) {
  const { stdout, code } = await runHook(stdin, env ?? envWithPath((await smallPrGh).dir));
  assert.equal(code, 0);
  assert.notEqual(stdout, "", "expected a reminder on stdout");
  return JSON.parse(stdout);
}

describe("capture-reminder hook", { concurrency: true }, () => {
  after(() => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

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

  it("emits PostToolUse additionalContext with the exact reminder sentence for the PR URL", async () => {
    const out = await expectReminder(JSON.stringify(bashEvent("gh pr create --fill")));
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      `A pull request was just created (${PR_URL}). Dispatch the pkm-capture agent in the background now with model "sonnet", and include the PR URL in its prompt.`,
    );
  });

  describe("names opus when the PR changes more than 1,000 lines and sonnet otherwise", { concurrency: true, skip: process.platform === "win32" && "the fake gh is a POSIX script" }, () => {
    const cases = [[0, 0, "sonnet"], [600, 400, "sonnet"], [1000, 1, "opus"], [0, 1001, "opus"], [5000, 200, "opus"]];
    for (const [additions, deletions, model] of cases) {
      it(`+${additions} -${deletions} → ${model}`, async () => {
        const gh = await fakeGh({ stdout: sizeJson(additions, deletions) });
        const out = await expectReminder(JSON.stringify(bashEvent("gh pr create --fill")), envWithPath(gh.dir));
        assert.equal(modelOf(out), model);
      });
    }
  });

  describe("still fires, with sonnet, when the PR size can't be read", { concurrency: true }, () => {
    const large = sizeJson(5000, 200);
    const cases = {
      "gh exits non-zero": { stdout: large, exitCode: 1 },
      "gh prints something other than JSON": { stdout: "not json" },
      "a count is missing": { stdout: JSON.stringify({ additions: 5000 }) },
      "the counts are not numbers": { stdout: JSON.stringify({ additions: "5000", deletions: "200" }) },
      "gh hangs past the lookup timeout": { stdout: large, hang: true },
      "gh is not on PATH": null,
    };
    for (const [name, gh] of Object.entries(cases)) {
      it(name, async () => {
        const dir = gh ? (await fakeGh(gh)).dir : await tempDir();
        const started = Date.now();
        const out = await expectReminder(JSON.stringify(bashEvent("gh pr create --fill")), envWithPath(dir));
        assert.equal(modelOf(out), "sonnet");
        assert.ok(Date.now() - started < 9000, "the hook must finish inside Claude Code's 10 s hook timeout");
      });
    }
  });

  it("stays silent when the PR is created inside a subagent", async () => {
    const event = bashEvent("gh pr create --fill");
    event.agent_id = "agent-abc123";
    event.agent_type = "general-purpose";
    await expectSilent(JSON.stringify(event));
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
