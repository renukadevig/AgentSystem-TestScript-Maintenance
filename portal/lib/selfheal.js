/**
 * Self-heal a failing Cypress spec by driving the local Claude Code CLI.
 *
 * The portal backend spawns `claude -p "<prompt>"` inside the cloned repo. Claude
 * reads the repo's own agent skills (broken-test-triage, automation-rules, …),
 * runs the failing spec, fixes it following those rules, and re-runs until green
 * — OR reports a real product bug instead of forcing the test green. It does NOT
 * commit; a human reviews the diff in the UI and approves, then we commit + push.
 *
 * Auth: uses the machine's Claude Code subscription login (no API key). The
 * `claude` binary is resolved from config().claudeCliPath.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

const HEAL_TIMEOUT_MS = Number(process.env.HEAL_TIMEOUT_MS || 1800000); // 30 min

// Files that must never be staged in a self-heal commit (repo rule: never
// `git add -A` — harness artifacts, reports, screenshots must not land).
const ARTIFACT_RE =
  /(^|\/)(cypress\/(screenshots|videos|downloads)|cypress\/reports|reports|runner-results|node_modules|\.next|dist|build|coverage)(\/|$)/;

/** The self-heal instruction sent to Claude Code, run inside the cloned repo. */
export function buildHealPrompt({ spec, baseUrl, extraPrompt, failureContext, framework = "cypress", compareUrl = "" }) {
  const FW = framework === "playwright" ? "Playwright" : "Cypress";
  const runLine =
    framework === "playwright"
      ? `npx playwright test "${spec}"`
      : baseUrl
        ? `npx cypress run --spec "${spec}" --config baseUrl=${baseUrl},video=false`
        : `npx cypress run --spec "${spec}" --config video=false`;

  // Optional operator note, appended verbatim so the user can steer this run
  // (e.g. "the login modal moved", "focus on the payment step selectors").
  const extra = (extraPrompt || "").trim();
  const extraBlock = extra
    ? `\n\nADDITIONAL INSTRUCTIONS FROM THE OPERATOR (take these into account, but never commit/push and never force a real product bug green):\n${extra}`
    : "";

  // When CI already captured the failure (error messages / stack from the run
  // report), pass it in so the AI analyses first and fixes without spending a
  // reproduction run — verification still requires a real green run.
  const ci = (failureContext || "").trim();
  const step2 = ci
    ? `2. ANALYSE the failure from the CI report below — do NOT re-run the spec just to reproduce it; the error is already captured. Read the spec and every page object / custom command / intercept it touches, and map the reported error to root cause in the code. Only if the report detail below is insufficient to locate the cause may you fall back to running the spec once to observe it directly. Prepare ${FW} for the later verification run (install deps: yarn if yarn.lock exists, else npm; pick the correct config — for Cypress the repo may have per-surface configs like cypress.config.ts / pwa.config.ts; for Playwright use playwright.config.ts and its projects). Fallback run command:
   ${runLine}

FAILURE DETAIL FROM THE CI REPORT:
\`\`\`
${ci.slice(0, 6000)}
\`\`\``
    : `2. Run the failing spec and capture the real error. Use the repo's own way of running ${FW} (yarn/npm scripts and the correct config file for the surface being tested). If dependencies aren't installed, install them first (yarn if yarn.lock exists, else npm). A direct fallback command:
   ${runLine}`;

  return `You are self-healing a failing ${FW} test in THIS repository. Do NOT commit, push, or create git branches/PRs — a human reviews your changes and commits them separately. Your only job is to make the failing spec run correctly, or determine it's a real product bug.

Work in this order:

1. FIRST, read and internalise our automation and framework rules before changing anything:
   - Read AGENTS.md (agent entry point) and CLAUDE.md.
   - Load and follow the repo's maintenance skill for exactly this task: .agents/skills/maintenance/broken-test-triage/SKILL.md (+ its reference.md), and selector-drift-repair / flaky-test-management / spec-hygiene when relevant.
   - Load the standards they point to: .agents/skills/global/global-automation-rules/SKILL.md and the relevant product's .agents/skills/<product>/automation-rules/SKILL.md (+ app-architecture).
   - Also scan cypress/support/ (custom commands, page objects) and a couple of existing PASSING specs near the target to learn the established patterns: selector strategy, custom commands, wait/retry conventions, data setup, naming.
   Summarise the rules you'll follow in 3-5 bullets before editing.

${step2}

3. Diagnose the failure, then fix it STRICTLY following the framework rules from step 1:
   - Reuse existing custom commands / page objects / selector helpers — do not invent new patterns.
   - Follow the framework's wait/retry approach; do NOT add arbitrary fixed waits like cy.wait(ms)/page.waitForTimeout(ms) (use event-based waits: intercept aliases, expect polls, state assertions).
   - PO = selectors only, CC = actions + assertions; never put raw selectors in specs.
   - Change only what's needed to make the test run correctly.

4. Inspect the network log / API intercepts: for every cy.intercept used for mocking or asserting, compare it against what the app actually sends/receives. If a JSON key, nested object, or payload key in our mock or our assertion is wrong or stale, update it to match the real API shape.

5. Re-run the spec. Repeat fix -> re-run until it passes.

6. CRITICAL: if the failure is a genuine application/product bug (the app is broken, not the script), STOP — do NOT force the test green or weaken assertions. Report it as a bug with the evidence instead.

6b. MISSING-FEATURE CHECK — before declaring PRODUCT_BUG for an element/feature that is COMPLETELY ABSENT from the page (not merely renamed or moved): absence often means the feature was intentionally removed or replaced, which is an OBSOLETE TEST, not an app bug. Verify:${compareUrl ? `
   - Compare against the reference/production environment: ${compareUrl} — run the same DOM check there. Absent in BOTH environments ⇒ intentional removal ⇒ VERDICT: OBSOLETE_TEST.` : `
   - Look for replacement evidence in the DOM (a new widget occupying the same area, renamed feature testids) and for the feature's selectors across the repo's page objects. Clear replacement evidence ⇒ VERDICT: OBSOLETE_TEST.`}
   - Only if the feature exists in the reference environment but is broken/missing in the tested one is PRODUCT_BUG the right verdict.

7. When done, output a short summary with these labelled lines exactly:
   VERDICT: HEALED | PRODUCT_BUG | OBSOLETE_TEST | COULD_NOT_FIX
   RULES: <3-5 bullets of the rules you followed>
   CHANGES: <what you changed and why, per file>
   RESULT: <final pass/fail of the spec>

7b. If your VERDICT is OBSOLETE_TEST, ALSO output exactly these labels (neutral, forward-looking wording — describe the current product state and next step, no blame/apology language):
   OBSOLETE_REASON: <what changed in the product, e.g. "X filter replaced by Y widget (absent on staging and production)">
   OBSOLETE_RECOMMENDATION: <one line: retire/rewrite which spec, and what new coverage to add>

8. If (and only if) your VERDICT is PRODUCT_BUG, ALSO output this copy-paste-ready bug report with exactly these labels:
   BUG_SUMMARY: <one-line bug title, format: [Area] What is broken>
   BUG_STEPS:
   1. <user-level step, no test jargon>
   2. <step>
   3. <step>
   BUG_EXPECTED: <what should happen, one line>
   BUG_ACTUAL: <what actually happens, one line>
   BUG_EVIDENCE: <the strongest proof it's the app, e.g. URL param not cleared, API response, screenshot>

Target spec: ${spec}${baseUrl ? `\nBase URL: ${baseUrl}` : ""}${extraBlock}`;
}

/**
 * Spawn the Claude Code CLI headlessly to heal the spec. Streams progress to
 * onLog and resolves with Claude's final text output.
 */
export function runClaudeHeal({ projectDir, prompt, onLog, onChild, configDir }) {
  const cli = config().claudeCliPath;
  const env = { ...process.env };
  // Cypress/Electron and Next set NODE_OPTIONS flags the child rejects — strip it.
  delete env.NODE_OPTIONS;
  // Make sure node/npm/npx/yarn next to the CLI are reachable for the child,
  // since Claude will run Cypress itself.
  if (cli.includes("/")) env.PATH = `${path.dirname(cli)}:${env.PATH || ""}`;
  // Pick which logged-in account (config dir) this heal runs under. Blank keeps
  // the CLI's default login.
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      // Stream the run as JSON events so the portal can show live progress (which file Claude is
      // editing, when it runs Cypress, etc.) instead of sitting silent for minutes. `stream-json`
      // with `-p` requires `--verbose`.
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Edit,Write,Bash,Glob,Grep",
    ];
    let child;
    try {
      // stdin: "ignore" gives the child an immediate EOF on stdin (like `< /dev/null`)
      // so `claude -p` doesn't block 3s waiting for piped input and warn. The whole
      // task is passed via the -p argument; nothing is fed on stdin.
      child = spawn(cli, args, {
        cwd: projectDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(new Error(`Could not launch Claude CLI (${cli}): ${e.message}`));
    }
    onChild?.(child);
    let out = "";        // raw stdout (kept for usage-limit detection / fallback)
    let err = "";
    let lineBuf = "";    // partial-line buffer for stream-json parsing
    let finalResult = ""; // text from the terminal "result" event (carries VERDICT/RESULT)
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Claude self-heal timed out after ${HEAL_TIMEOUT_MS}ms`));
    }, HEAL_TIMEOUT_MS);

    // Parse the stream-json events line-by-line and surface live progress via onLog so the portal
    // shows what Claude is doing instead of a silent "analysing…" for minutes.
    child.stdout.on("data", (d) => {
      out += d;
      lineBuf += d;
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // non-JSON noise — ignore for progress (still captured in `out`)
        }
        if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
          for (const c of evt.message.content) {
            if (c.type === "text" && c.text && c.text.trim()) {
              onLog?.(c.text.trim().slice(0, 500));
            } else if (c.type === "tool_use") {
              const i = c.input || {};
              const detail = i.file_path
                ? ` ${i.file_path}`
                : i.command
                  ? ` $ ${String(i.command).replace(/\s+/g, " ").slice(0, 90)}`
                  : i.pattern
                    ? ` /${i.pattern}/`
                    : "";
              onLog?.(`🔧 ${c.name}${detail}`);
            }
          }
        } else if (evt.type === "result") {
          finalResult = (evt.result || finalResult || "").toString();
        }
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT")
        reject(
          new Error(
            `Claude CLI not found at "${cli}". Install it (npm i -g @anthropic-ai/claude-code) and set CLAUDE_CLI_PATH in .env.local.`
          )
        );
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Resolve the clean final-result text (from the stream-json "result" event) — it carries the
      // AI's VERDICT/RESULT lines the heal pipeline parses. Fall back to raw stdout if absent.
      if (code === 0) return resolve((finalResult.trim() || out.trim()));
      // Surface BOTH streams — the real error is often in stdout, while stderr may hold only a
      // benign warning. Showing just stderr hid the cause.
      const detail = [err.trim(), finalResult.trim(), out.trim()].filter(Boolean).join("\n---\n").slice(-1200);
      // The Claude subscription's usage/session limit is the common non-bug failure;
      // it exits 1 with the notice on stdout. Give a clear message instead of "exited 1".
      if (/hit your (session|usage) limit|usage limit reached|resets \d/i.test(detail)) {
        return reject(
          new Error(`Claude usage/session limit reached — self-heal can't run until it resets. ${detail}`)
        );
      }
      reject(new Error(`Claude exited ${code}: ${detail || "(no output)"}`));
    });
  });
}

/**
 * Prompt sent on loop attempts 2+ when Cypress still fails after a heal.
 * Gives the AI the exact failure output so it can make a targeted refix.
 */
export function buildRefixPrompt({ spec, baseUrl, cypressOutput, attempt, framework = "cypress" }) {
  const FW = framework === "playwright" ? "Playwright" : "Cypress";
  const runLine =
    framework === "playwright"
      ? `npx playwright test "${spec}"`
      : baseUrl
        ? `npx cypress run --spec "${spec}" --config baseUrl=${baseUrl},video=false`
        : `npx cypress run --spec "${spec}" --config video=false`;

  return `You previously attempted to fix the failing ${FW} spec but it is STILL failing (attempt ${attempt} of 3).

Here is the ${FW} output from the verification run:
\`\`\`
${cypressOutput.slice(0, 6000)}
\`\`\`

Target spec: ${spec}${baseUrl ? `\nBase URL: ${baseUrl}` : ""}

Re-read the failure carefully and fix it. Follow the same rules as before:
- Reuse existing custom commands / page objects / selector helpers.
- No arbitrary fixed waits (cy.wait(ms) / page.waitForTimeout(ms)) — use event-based waits / assertions.
- PO = selectors only, CC = actions + assertions; never put raw selectors in specs.
- Change only what's needed to make the test pass.
- If the failure is a genuine product bug, STOP and report it rather than forcing the test green.

Run the spec to verify your fix:
  ${runLine}

When done output a summary with exactly these labelled lines:
VERDICT: HEALED | PRODUCT_BUG | OBSOLETE_TEST | COULD_NOT_FIX
RULES: <3-5 bullets of the rules you followed>
CHANGES: <what you changed and why, per file>
RESULT: <final pass/fail of the spec>

If VERDICT is PRODUCT_BUG, also output:
BUG_SUMMARY: <one-line title>
BUG_STEPS:
1. <user-level step>
BUG_EXPECTED: <one line>
BUG_ACTUAL: <one line>
BUG_EVIDENCE: <one line>`;
}

/**
 * Reverify prompt — run AFTER a first-pass PRODUCT_BUG verdict, once the
 * pipeline has done ONE independent rerun of the spec. Asks the AI to look at
 * the fresh run output and decide between two possibilities:
 *
 *   PRODUCT_BUG      the app is genuinely broken — confirm it, don't touch the
 *                    test. (Same structured bug report as before.)
 *   FEATURE_CHANGED  it is NOT an app bug: a feature changed RECENTLY (renamed
 *                    selector, moved/renamed control, changed copy, altered API
 *                    shape/flow) and the test is asserting the OLD behaviour.
 *                    In this case, ADAPT THE TEST to the new behaviour so it
 *                    passes — but do NOT commit/push/PR; a human approves first.
 *
 * The distinction: OBSOLETE_TEST = the feature is gone (retire the test);
 * FEATURE_CHANGED = the feature still exists but behaves differently (update
 * the test to match).
 */
export function buildBugReverifyPrompt({ spec, baseUrl, cypressOutput, framework = "cypress", bugReport }) {
  const FW = framework === "playwright" ? "Playwright" : "Cypress";
  const runLine =
    framework === "playwright"
      ? `npx playwright test "${spec}"`
      : baseUrl
        ? `npx cypress run --spec "${spec}" --config baseUrl=${baseUrl},video=false`
        : `npx cypress run --spec "${spec}" --config video=false`;

  const prior = bugReport?.summary
    ? `\nYour first-pass reasoning called this a product bug:\n- Summary: ${bugReport.summary}\n- Expected: ${bugReport.expected || "-"}\n- Actual: ${bugReport.actual || "-"}\n- Evidence: ${bugReport.evidence || "-"}\n`
    : "";

  return `You flagged the failing ${FW} spec as a PRODUCT_BUG. Before we escalate that, the pipeline re-ran the spec ONCE independently. Re-examine that fresh run and decide, carefully, between two very different outcomes.
${prior}
Fresh reverify run output:
\`\`\`
${(cypressOutput || "").slice(0, 6000)}
\`\`\`

Target spec: ${spec}${baseUrl ? `\nBase URL: ${baseUrl}` : ""}

Decide between:

A) PRODUCT_BUG — the application is genuinely broken (a working feature returns
   wrong data, errors, or a broken UI state). The test is correct; the app is not.
   Do NOT modify the test. Confirm the bug.

B) FEATURE_CHANGED — this is NOT an app bug. A feature changed RECENTLY and the
   test is still asserting the OLD behaviour: a renamed/moved control or testid,
   changed on-screen copy, a new step in the flow, or a changed API request/
   response shape. The feature still EXISTS and works — the test is simply out of
   date. Confirm by inspecting the live DOM/network against what the spec expects,
   and by scanning the repo's page objects / custom commands for the current
   pattern. (If the feature is GONE entirely, that's OBSOLETE_TEST, not this.)

If your decision is B) FEATURE_CHANGED:
  - ADAPT THE TEST to the new behaviour, following the repo's rules (reuse page
    objects / custom commands, no arbitrary fixed waits, PO = selectors only).
  - Re-run to confirm it now passes:
      ${runLine}
  - Do NOT commit, push, or open a PR — a human approves the change first.

Output a summary with exactly these labelled lines:
VERDICT: PRODUCT_BUG | FEATURE_CHANGED
RESULT: <final pass/fail of the spec after your changes, or "not run" if PRODUCT_BUG>

If VERDICT is FEATURE_CHANGED, ALSO output exactly:
FEATURE_CHANGE_SUMMARY: <one line: what changed in the product, e.g. "Search CTA testid renamed search-btn → cta-search">
FEATURE_CHANGE_REASON: <one line: why this is a recent feature change and not an app bug — the evidence>
CHANGES: <what you changed in the test and why, per file>

If VERDICT is PRODUCT_BUG, ALSO output the copy-paste-ready bug report:
BUG_SUMMARY: <one-line title, format: [Area] What is broken>
BUG_STEPS:
1. <user-level step>
BUG_EXPECTED: <one line>
BUG_ACTUAL: <one line>
BUG_EVIDENCE: <one line>`;
}

/**
 * Spawn the Cursor CLI (agent) headlessly to heal the spec.
 * Uses `agent -p "..." --model <model> --output-format text --sandbox disabled`
 * so it can run Cypress, edit files, and read git output freely.
 */
export function runCursorHeal({ projectDir, prompt, onLog, onChild }) {
  const cfg = config();
  const cli = cfg.cursorCliPath;
  const model = cfg.cursorModel || "claude-4.6-sonnet-medium";
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (cli.includes("/")) env.PATH = `${path.dirname(cli)}:${env.PATH || ""}`;

  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--model", model,
      "--output-format", "text",
      "--sandbox", "disabled",
      "--trust",
    ];
    let child;
    try {
      child = spawn(cli, args, {
        cwd: projectDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(new Error(`Could not launch Cursor CLI (${cli}): ${e.message}`));
    }
    onChild?.(child);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Cursor self-heal timed out after ${HEAL_TIMEOUT_MS}ms`));
    }, HEAL_TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT")
        reject(new Error(
          `Cursor CLI not found at "${cli}". Install it: curl https://cursor.com/install -fsS | bash`
        ));
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const detail = [err.trim(), out.trim()].filter(Boolean).join("\n---\n").slice(-1200);
      if (/not logged in|login required|unauthorized/i.test(detail)) {
        return reject(new Error(`Cursor CLI is not logged in — run: agent login. ${detail}`));
      }
      reject(new Error(`Cursor agent exited ${code}: ${detail || "(no output)"}`));
    });
  });
}

function git(projectDir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: projectDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const clean = redact(stderr);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} exited ${code}: ${clean.slice(0, 600)}`));
    });
  });
}

function redact(text) {
  const token = config().githubToken;
  return token ? String(text).replaceAll(token, "***") : String(text);
}

/** What did the heal change? Modified tracked files, minus build/test artifacts. */
export async function captureDiff(projectDir) {
  const nameOut = await git(projectDir, ["diff", "--name-only"]);
  const changedFiles = nameOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !ARTIFACT_RE.test(f));
  let diff = "";
  if (changedFiles.length) {
    diff = await git(projectDir, ["diff", "--", ...changedFiles]);
  }
  return { changedFiles, diff: diff.slice(0, 80000) };
}

/**
 * Stage ONLY the reviewed files (never `git add -A`), commit, and push to the
 * same branch the heal ran on.
 */
export async function commitAndPush({ projectDir, changedFiles, message, branch, onLog }) {
  if (!changedFiles?.length) throw new Error("No changed files to commit.");
  onLog?.(`Staging ${changedFiles.length} file(s): ${changedFiles.join(", ")}`);
  await git(projectDir, ["add", "--", ...changedFiles]);
  await git(projectDir, [
    "-c",
    "user.email=qa-portal-selfheal@local",
    "-c",
    "user.name=QA Portal Self-heal",
    "commit",
    "-m",
    message,
  ]);
  const target = branch ? `HEAD:refs/heads/${branch}` : "HEAD";
  onLog?.(`Pushing to origin ${branch || "current branch"}…`);
  await git(projectDir, ["push", "origin", target]);
}

/**
 * Stage ONLY the reviewed files, commit them onto a FRESH branch, and push it
 * to origin. Used by the auto-fix flow so the fix lands on its own branch that
 * a PR can then be opened against — the original branch is left untouched.
 * Returns the branch name actually created.
 */
export async function commitToNewBranchAndPush({
  projectDir,
  changedFiles,
  message,
  newBranch,
  onLog,
}) {
  if (!changedFiles?.length) throw new Error("No changed files to commit.");
  onLog?.(`Creating branch ${newBranch} with ${changedFiles.length} file(s)…`);
  // Uncommitted working-tree edits carry over to the new branch on checkout.
  await git(projectDir, ["checkout", "-b", newBranch]);
  await git(projectDir, ["add", "--", ...changedFiles]);
  await git(projectDir, [
    "-c",
    "user.email=qa-portal-selfheal@local",
    "-c",
    "user.name=QA Portal Self-heal",
    "commit",
    "-m",
    message,
  ]);
  onLog?.(`Pushing ${newBranch} to origin…`);
  await git(projectDir, ["push", "origin", `HEAD:refs/heads/${newBranch}`]);
  return newBranch;
}
