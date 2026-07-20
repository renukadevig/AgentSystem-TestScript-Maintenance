/**
 * Self-heal pipeline — the AGENT LOOP of the system.
 *
 * Given a goal ("make this failing spec pass, honestly"), it iterates
 * PLAN → ACT → OBSERVE → DECIDE up to MAX_HEAL_LOOPS times:
 *
 *   PLAN     build a heal prompt from the CI report's real errors
 *            (attempt 1) or a refix prompt from the pipeline's own
 *            verification output (attempts 2+) — the plan changes each
 *            round based on what was observed.
 *   ACT      the local AI CLI (Claude Code / Cursor) edits the spec.
 *   OBSERVE  an INDEPENDENT Cypress/Playwright rerun of the spec — the
 *            AI's own "HEALED" claim is never trusted on its word.
 *   DECIDE   green → capture diff, open a draft PR, done.
 *            red → feed the real failure output back and RETRY.
 *            PRODUCT_BUG / OBSOLETE_TEST → stop; report, never force green.
 *            loops exhausted → honest COULD_NOT_FIX.
 *
 * The diff is captured for human review — committing happens later, only on
 * approval (or automatically as a DRAFT PR when openPr is set).
 */
import { emit, trackChild } from "./jobs.js";
import { parseRepo, cloneRepo, getDefaultBranch, openPullRequest } from "./github.js";
import { runCypress, runPlaywright } from "./cypressRunner.js";
import { notifySlackPrOpened } from "./dispatch.js";
import {
  buildHealPrompt,
  buildRefixPrompt,
  buildBugReverifyPrompt,
  runClaudeHeal,
  runCursorHeal,
  captureDiff,
  commitToNewBranchAndPush,
} from "./selfheal.js";
import { claudeConfigDirFor, config } from "./config.js";

const MAX_HEAL_LOOPS = Number(process.env.MAX_HEAL_LOOPS || 3);

export async function runHealPipeline(job) {
  const log = (m) => emit(job, m);
  const onChild = (c) => trackChild(job, c);
  job.status = "running";

  try {
    const { repoUrl, branch, spec, baseUrl, extraPrompt, account, cliType, openPr, draftPr = true, failureContext, framework = "cypress", compareUrl = "" } = job.input;
    const parsed = parseRepo(repoUrl);
    if (!parsed) throw new Error(`Could not parse a GitHub repo from: ${repoUrl}`);
    if (!spec) throw new Error("A spec path is required to self-heal.");

    const dir = await cloneRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      jobId: job.id,
      onLog: log,
      onChild,
    });
    job.projectDir = dir; // needed later by the commit endpoint

    const useCursor = cliType === "cursor";
    const cliLabel = useCursor
      ? `Cursor CLI (${config().cursorModel})`
      : "Claude Code";

    job.cliUsed = useCursor
      ? `Cursor CLI (${config().cursorModel})`
      : `Claude Code${account ? ` (${account})` : ""}`;

    log(`Invoking ${cliLabel} to self-heal ${spec}. This can take several minutes…`);
    if (extraPrompt?.trim()) log(`Including operator instructions in the heal prompt.`);

    // Resolve Claude config dir once
    let configDir = "";
    if (!useCursor) {
      configDir = claudeConfigDirFor(account);
      if (account) {
        log(
          configDir
            ? `Using the "${account}" Claude account for this heal.`
            : `Requested "${account}" account, but no config dir is set — using default login.`
        );
      }
    }

    async function runAi(prompt) {
      return useCursor
        ? runCursorHeal({ projectDir: dir, prompt, onLog: log, onChild })
        : runClaudeHeal({ projectDir: dir, prompt, onLog: log, onChild, configDir });
    }

    job.healLoops = []; // [{ attempt, verdict, cypressPassed, summary }]
    let lastOutput = "";
    let cypressOutput = "";

    // ═══ THE AGENT LOOP: PLAN → ACT → OBSERVE → DECIDE, replanning each
    // attempt from what the previous one actually observed. ═══
    for (let attempt = 1; attempt <= MAX_HEAL_LOOPS; attempt++) {
      if (job._stopped) break;
      log(`─── Heal loop ${attempt} / ${MAX_HEAL_LOOPS} ───`);

      // ── PLAN + ACT: build the (re)fix prompt, AI edits the script ────────
      const prompt =
        attempt === 1
          ? buildHealPrompt({ spec, baseUrl, extraPrompt, failureContext, framework, compareUrl })
          : buildRefixPrompt({ spec, baseUrl, cypressOutput, attempt, framework });

      log(`${cliLabel}: analysing and fixing the spec…`);
      lastOutput = await runAi(prompt);

      const vm = lastOutput.match(/VERDICT:\s*(HEALED|PRODUCT_BUG|OBSOLETE_TEST|COULD_NOT_FIX)/i);
      const aiVerdict = vm ? vm[1].toUpperCase() : "UNKNOWN";
      const rm = lastOutput.match(/RESULT:\s*(.+)/i);
      if (rm) log(`${cliLabel} reported result: ${rm[1].trim()}`);

      // ── DECIDE (stop + escalate): the tested feature was removed/replaced
      // in the product (verified vs the reference env when provided). No app
      // bug, no PR — the spec itself needs retiring/rewriting.
      if (aiVerdict === "OBSOLETE_TEST") {
        const grabO = (re) => (lastOutput.match(re) || [])[1]?.trim() || "";
        job.obsoleteReport = {
          reason: grabO(/OBSOLETE_REASON:\s*(.+)/),
          recommendation: grabO(/OBSOLETE_RECOMMENDATION:\s*(.+)/),
        };
        log(`${cliLabel} verdict: OBSOLETE_TEST — the tested feature was removed/replaced in the product. Spec needs retiring/updating.`);
        job.healLoops.push({ attempt, verdict: "OBSOLETE_TEST", cypressPassed: false });
        job.verdict = "OBSOLETE_TEST";
        break;
      }

      // ── DECIDE (stop + escalate): a real product bug — report it with a
      // structured bug report; assertions are never weakened to force green.
      if (aiVerdict === "PRODUCT_BUG") {
        // Parse the structured bug report (copy-paste-ready for a tracker).
        const grab = (re) => (lastOutput.match(re) || [])[1]?.trim() || "";
        const stepsBlock = (lastOutput.match(/BUG_STEPS:\s*\n([\s\S]*?)(?=BUG_EXPECTED:)/) || [])[1] || "";
        const steps = stepsBlock
          .split("\n")
          .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
          .filter(Boolean);
        const bugReport = {
          summary: grab(/BUG_SUMMARY:\s*(.+)/),
          steps,
          expected: grab(/BUG_EXPECTED:\s*(.+)/),
          actual: grab(/BUG_ACTUAL:\s*(.+)/),
          evidence: grab(/BUG_EVIDENCE:\s*(.+)/),
        };
        if (bugReport.summary || bugReport.steps.length) job.bugReport = bugReport;

        // ── OBSERVE (reverify before escalating): a PRODUCT_BUG is a serious
        // call, so never stop on the AI's word alone. Rerun the spec ONCE
        // independently, then re-ask whether this is truly an app bug or
        // actually a RECENT FEATURE CHANGE the test must adapt to.
        // Mid-flight signal so a Slack/UI poller can surface the reverify step
        // live (before the job finishes) rather than only its outcome.
        job.reverifyingBug = true;
        log(
          `${cliLabel} verdict: PRODUCT_BUG. It seems like a product bug — running the ${framework} runner once to reverify and share the findings with you…`
        );
        let reSummary = null;
        try {
          const runner = framework === "playwright" ? runPlaywright : runCypress;
          const ver = await runner({
            projectDir: dir,
            specs: [spec],
            baseUrl,
            failureScreenshots: false,
            onLog: log,
            onChild,
          });
          reSummary = ver.summary;
        } catch (e) {
          if (job._stopped) break;
          log(`Reverify run could not execute (${e.message}).`);
        }
        if (job._stopped) break;
        job.bugReverify = reSummary
          ? {
              totalPassed: reSummary.totalPassed ?? 0,
              totalFailed: reSummary.totalFailed ?? 0,
              loadError: reSummary.loadError || "",
              failures: reSummary.failures || [],
            }
          : null;

        // DECIDE: re-classify with the AI given the fresh run output — is this a
        // genuine app bug, or a recent feature change the test is lagging behind?
        const reOutput =
          reSummary?.failures?.map((f) => `✗ ${f.title}\n${f.error}`).join("\n\n") ||
          reSummary?.logTail ||
          lastOutput.slice(-2000);
        log(`Reverify complete — re-checking whether this is a real product bug or a recent feature change…`);
        lastOutput = await runAi(
          buildBugReverifyPrompt({ spec, baseUrl, cypressOutput: reOutput, framework, bugReport })
        );
        const rv = lastOutput.match(/VERDICT:\s*(PRODUCT_BUG|FEATURE_CHANGED)/i);
        const reVerdict = rv ? rv[1].toUpperCase() : "PRODUCT_BUG";

        if (reVerdict === "FEATURE_CHANGED") {
          // Not an app bug after all — a recent feature change. The AI has
          // adapted the test in the working tree; hold the diff for the human's
          // "Agree to apply for feature change" approval (no auto-PR here).
          const grabF = (re) => (lastOutput.match(re) || [])[1]?.trim() || "";
          job.featureChange = {
            summary: grabF(/FEATURE_CHANGE_SUMMARY:\s*(.+)/),
            reason: grabF(/FEATURE_CHANGE_REASON:\s*(.+)/),
          };
          job.bugReport = null; // it wasn't a bug after all
          job.healLoops.push({ attempt, verdict: "FEATURE_CHANGED", cypressPassed: false });
          job.verdict = "FEATURE_CHANGED";
          log(
            `Reverify finding: NOT a product bug — a recent feature change caused this` +
              (job.featureChange.summary ? ` (${job.featureChange.summary})` : "") +
              `. Proposed test update is ready — approve to apply and open a PR.`
          );
          break;
        }

        // Confirmed: still a product bug after an independent rerun.
        log(`Reverify finding: confirmed PRODUCT_BUG — this is a real app bug, not a test issue. Stopping.`);
        job.healLoops.push({ attempt, verdict: "PRODUCT_BUG", cypressPassed: false });
        job.verdict = "PRODUCT_BUG";
        break;
      }

      // ── OBSERVE + VERIFY: NEVER trust the AI's HEALED verdict on its word —
      // verify with an independent pipeline-side Cypress run of the same spec.
      // (The AI's sandbox has failed to reach the app before while still
      // reporting HEALED.)
      if (aiVerdict === "HEALED") {
        log(`${cliLabel} reports HEALED on attempt ${attempt} — verifying with a pipeline-side ${framework} run…`);
        let summary = null;
        try {
          const runner = framework === "playwright" ? runPlaywright : runCypress;
          const ver = await runner({
            projectDir: dir,
            specs: [spec],
            baseUrl,
            failureScreenshots: false,
            onLog: log,
            onChild,
          });
          summary = ver.summary;
        } catch (e) {
          if (job._stopped) break;
          log(`Verification run could not execute (${e.message}).`);
        }

        const green =
          summary && !summary.loadError && (summary.totalFailed ?? 1) === 0 && (summary.totalPassed ?? 0) > 0;

        if (green) {
          // ── DECIDE (goal achieved): independently verified green.
          job.verified = true;
          job.healLoops.push({ attempt, verdict: "HEALED", cypressPassed: true, cypressSummary: summary });
          job.verdict = "HEALED";
          log(`✅ Verified on attempt ${attempt} — pipeline Cypress run is green (${summary.totalPassed} passed).`);
          break;
        }

        if (summary?.loadError) {
          // App unreachable from the pipeline (VPN/gated env) — we can't
          // independently verify. Accept the AI's verdict but say so loudly.
          job.verified = false;
          job.verifyNote = `pipeline could not reach the app (${summary.loadError}) — verdict rests on the CLI's own run`;
          job.healLoops.push({ attempt, verdict: "HEALED", cypressPassed: false, cypressSummary: summary });
          job.verdict = "HEALED";
          log(`⚠ ${job.verifyNote}.`);
          break;
        }

        // ── RETRY / REPLAN: fix didn't actually pass — loop back with the
        // REAL Cypress output so the next plan starts from observed truth.
        job.healLoops.push({ attempt, verdict: "HEALED_UNVERIFIED", cypressPassed: false, cypressSummary: summary });
        cypressOutput =
          summary?.failures?.map((f) => `✗ ${f.title}\n${f.error}`).join("\n\n") ||
          summary?.logTail ||
          lastOutput.slice(-2000);
        if (attempt < MAX_HEAL_LOOPS) {
          log(`✖ Verification failed (${summary?.totalFailed ?? "?"} still failing) — refix loop ${attempt + 1}…`);
        } else {
          log(`Reached max loops (${MAX_HEAL_LOOPS}) with verification still failing.`);
          job.verdict = "COULD_NOT_FIX";
        }
        continue;
      }

      // ── RETRY / REPLAN: not HEALED and not PRODUCT_BUG — feed the AI's own
      // report back on the next attempt.
      job.healLoops.push({ attempt, verdict: aiVerdict, cypressPassed: false });
      cypressOutput = lastOutput.slice(-2000);

      if (attempt < MAX_HEAL_LOOPS) {
        log(
          `⚠ Verdict ${aiVerdict} after attempt ${attempt} — sending its report back to ${cliLabel} for refix…`
        );
      } else {
        log(
          `Reached max loops (${MAX_HEAL_LOOPS}). Capturing best diff for manual review.`
        );
        job.verdict = ["HEALED", "PRODUCT_BUG", "COULD_NOT_FIX"].includes(aiVerdict)
          ? aiVerdict
          : "COULD_NOT_FIX";
      }
    }

    job.healSummary = lastOutput;
    if (!job.verdict) job.verdict = "UNKNOWN";

    const { changedFiles, diff } = await captureDiff(dir);
    job.changedFiles = changedFiles;
    job.diff = diff;

    const loopSummary = job.healLoops
      .map((l) => `#${l.attempt} ${l.cypressPassed ? "✅" : "❌"} ${l.verdict}`)
      .join(" → ");

    // ── Auto-open a PR for the fix (one-click flow) ──────────────────────
    // Only when asked, the spec was actually HEALED, and there is a diff to
    // ship. Anything else (PRODUCT_BUG, COULD_NOT_FIX, no changes) is left for
    // human review rather than raising a noise PR.
    if (openPr && job.verdict === "HEALED" && changedFiles.length && !job._stopped) {
      try {
        const base = branch || (await getDefaultBranch(parsed.owner, parsed.repo));
        const slug = spec
          .replace(/^.*\//, "")
          .replace(/\.(cy|spec|test)\.[jt]sx?$/i, "")
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .slice(0, 40);
        const newBranch = `self-heal/${slug}-${job.id}`;
        const message =
          `fix(self-heal): repair ${spec}\n\n` +
          `Automated self-heal via QA Portal (${job.cliUsed}). Verified green by ` +
          `the CLI's own Cypress run before this PR was opened.`;

        await commitToNewBranchAndPush({
          projectDir: dir,
          changedFiles,
          message,
          newBranch,
          onLog: log,
        });

        const body =
          `## 🔧 Automated self-heal\n\n` +
          `Repaired failing spec: \`${spec}\`\n\n` +
          `- **CLI:** ${job.cliUsed}\n` +
          `- **Verdict:** ${job.verdict} (${loopSummary})\n` +
          `- **Verification:** ${
            job.verified
              ? "independent pipeline-side Cypress run passed ✅"
              : `⚠ ${job.verifyNote || "not independently verified"}`
          }\n` +
          `- **Files changed:** ${changedFiles.map((f) => `\`${f}\``).join(", ")}\n\n` +
          `### Summary\n${(job.healSummary || "").slice(0, 4000)}\n\n` +
          `> Opened automatically by the QA Portal auto-fix flow. Review before merging.`;

        const pr = await openPullRequest({
          owner: parsed.owner,
          repo: parsed.repo,
          head: newBranch,
          base,
          title: `fix(self-heal): repair ${spec}`,
          body,
          draft: draftPr,
        });
        job.pr = { url: pr.url, number: pr.number, branch: newBranch, base, draft: pr.draft };
        job.committed = true;
        log(
          `✅ Opened ${pr.draft ? "draft " : ""}PR #${pr.number} (${newBranch} → ${base}): ${pr.url}`
        );

        // Post to Slack so the team can review the fix before it's merged.
        await notifySlackPrOpened(
          {
            pr: job.pr,
            spec,
            verdict: job.verdict,
            changedFiles,
            cliUsed: job.cliUsed,
          },
          log
        );
      } catch (e) {
        // PR failure must not fail the whole heal — the fix + diff are still
        // valid and can be committed manually. Surface it clearly instead.
        job.prError = e.message;
        log(`⚠ Could not open a PR automatically: ${e.message}. The diff is ready for manual commit.`);
      }
    }

    log(
      `Self-heal finished — verdict: ${job.verdict} (${loopSummary}); ` +
        `${changedFiles.length} file(s) changed.` +
        (job.pr
          ? ` PR #${job.pr.number} opened.`
          : changedFiles.length
            ? " Review the diff, then Approve & commit."
            : "")
    );
    job.status = "done";
    return job;
  } catch (e) {
    if (job._stopped) {
      job.status = "stopped";
      emit(job, "Self-heal stopped by user.");
      return job;
    }
    job.error = e.message;
    job.status = "error";
    emit(job, `ERROR: ${e.message}`);
    return job;
  }
}
