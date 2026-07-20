/**
 * Orchestration core — mirrors run_test() from the Python agent.
 *
 * Pipeline:
 *   1. Clone the chosen repo branch (GitHub)
 *   2. Scan + filter Cypress specs for the chosen product
 *   3. Run Cypress via the Node Module API, collecting screenshots
 *   4. Feed screenshot evidence to Gemini -> structured bugs
 *   5. Autonomously dispatch bugs to Jira / Slack
 *
 * Each stage degrades gracefully: a failure is logged and the run continues
 * where it sensibly can, ending "done" with whatever was produced or "error".
 */
import { emit, trackChild } from "./jobs.js";
import {
  parseRepo,
  cloneRepo,
  scanSpecs,
  filterSpecs,
  installDeps,
  injectAppScreenshots,
} from "./github.js";
import { runCypress } from "./cypressRunner.js";
import { assessScreenshot } from "./vlm.js";
import { dispatchBugs } from "./dispatch.js";
import { findProduct } from "./products.js";

/**
 * Turn Cypress's own pass/fail results into bugs for the "automation" test
 * type — no VLM calls involved. One bug per parsed failing test when the
 * mocha reporter output was parseable; otherwise one summary bug for the run
 * so a parsing miss never silently reports zero findings.
 */
function buildAutomationBugs(cyp, specs) {
  const failures = cyp?.failures || [];
  if (failures.length) {
    return failures.map((f, i) => ({
      id: `AUTO-${i + 1}`,
      title: f.title || `Automation test failure #${i + 1}`,
      severity: "Major",
      category: "Automation",
      lens: "Automation",
      description: "Cypress automation test failed.",
      steps: [],
      expected_result: "The test should pass.",
      actual_result: f.error,
      requirement_ref: specs?.[0] || "",
      screenshot_ref: "",
    }));
  }
  if ((cyp?.totalFailed || 0) > 0) {
    return [
      {
        id: "AUTO-1",
        title: `${cyp.totalFailed} automation test(s) failed`,
        severity: "Major",
        category: "Automation",
        lens: "Automation",
        description: `${cyp.totalFailed} of ${cyp.totalTests ?? "?"} test(s) failed during the funnel run.`,
        steps: [],
        expected_result: "All funnel steps should pass.",
        actual_result:
          cyp.logTail || "The run failed but no error detail was captured. See the run log.",
        requirement_ref: (specs || []).join(", "),
        screenshot_ref: "",
      },
    ];
  }
  return [];
}

export async function runPipeline(job) {
  const log = (m) => emit(job, m);
  const onChild = (c) => trackChild(job, c);
  // Stop kills tracked children, but some stages survive that (Cypress
  // resolves on any exit code, npm-install failures are tolerated) and the
  // VLM loop has no child at all — so every stage boundary must check the
  // flag itself. Throwing lands in the catch below, which maps it to "stopped".
  const assertNotStopped = () => {
    if (job._stopped) throw new Error("Run stopped by user");
  };
  job.status = "running";

  try {
    const {
      repoUrl,
      branch,
      productId,
      baseUrl,
      dispatch,
      specs: requestedSpecs,
      testType,
      vlmEngine,
    } = job.input;
    const product = findProduct(productId);
    const effectiveBaseUrl = baseUrl || product?.baseUrl || "";

    // 1. Clone -----------------------------------------------------------
    const parsed = parseRepo(repoUrl);
    if (!parsed) throw new Error(`Could not parse a GitHub repo from: ${repoUrl}`);
    const projectDir = await cloneRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      jobId: job.id,
      onLog: log,
      onChild,
    });

    // 2. Scan + filter specs --------------------------------------------
    let specs;
    if (requestedSpecs?.length) {
      // Caller pinned an explicit subset — run exactly those.
      specs = requestedSpecs;
      log(`Running ${specs.length} caller-specified spec(s).`);
    } else {
      specs = await scanSpecs(projectDir);
      log(`Discovered ${specs.length} spec file(s).`);
      if (product?.specGlobs?.length) {
        const filtered = filterSpecs(specs, product.specGlobs);
        if (filtered.length) {
          specs = filtered;
          log(`Filtered to ${specs.length} spec(s) for ${product.name}.`);
        } else {
          log(`No specs matched ${product.name} globs — running all.`);
        }
      }
    }
    job.specs = specs;
    if (!specs.length) {
      log("No Cypress specs found; nothing to run.");
      job.status = "done";
      return job;
    }

    // 2b. Install the cloned repo's own deps so its plugins resolve ------
    try {
      await installDeps(projectDir, log, onChild);
    } catch (e) {
      assertNotStopped(); // a killed npm install is a stop, not a tolerable failure
      log(`Dependency install failed (${e.message}); attempting Cypress anyway.`);
    }
    assertNotStopped();

    // 2c. Inject app-only screenshots (capture the page, not Cypress chrome)
    const appOnly = await injectAppScreenshots(projectDir, log);

    // 3. Run Cypress -----------------------------------------------------
    let screenshots = [];
    try {
      const { summary, screenshots: shots } = await runCypress({
        projectDir,
        specs,
        baseUrl: effectiveBaseUrl,
        failureScreenshots: !appOnly, // suppress runner shots when app-only is active
        onLog: log,
        onChild,
      });
      job.cypress = summary;
      screenshots = shots;
    } catch (e) {
      assertNotStopped();
      job.cypress = { error: e.message };
      log(`Cypress stage failed: ${e.message}`);
    }
    // A SIGKILLed Cypress still resolves (any exit code is "normal"), so a
    // stop during the run would otherwise sail on into assessment/dispatch.
    assertNotStopped();

    // 4. Automation check or VLM assessment ------------------------------
    const cyp = job.cypress || {};

    if (testType === "automation") {
      // Pure Cypress pass/fail — no VLM calls, no API quota spent.
      const funcBugs = buildAutomationBugs(cyp, specs);
      // Attach the captured screenshots so the failing screen is visible on the
      // bug card. The last shot is the most recent state (usually the failure).
      if (screenshots.length && funcBugs.length) {
        for (const shot of screenshots) job.screenshots[shot.name] = shot.b64;
        const lastShot = screenshots[screenshots.length - 1].name;
        for (const b of funcBugs) if (!b.screenshot_name) b.screenshot_name = lastShot;
      }
      job.bugs.push(...funcBugs);
      log(`Automation test: ${funcBugs.length} issue(s) from the Cypress run.`);
    } else if (
      // UI/UX path — only when the Cypress run did NOT fail. If any test
      // failed (or the page didn't load / Cypress errored), the screenshots
      // are failure states, not the real screens worth reviewing — so we
      // skip the VLM entirely and don't spend Google API calls.
      Boolean(cyp.error) ||
      Boolean(cyp.loadError) ||
      (typeof cyp.exitCode === "number" && cyp.exitCode !== 0) ||
      (typeof cyp.totalFailed === "number" && cyp.totalFailed > 0)
    ) {
      log(
        "Cypress test failed — skipping the VLM assessment (no Google API calls). " +
          "Only passing runs are reviewed."
      );
    } else if (screenshots.length) {
      // VLM_MAX_SCREENSHOTS caps how many screens are sent to Gemini so a run
      // can stay under the API daily quota (free tier = 20 calls/day; each
      // screenshot costs one call per active lens). Blank/0 = assess all.
      const maxShots = Number(process.env.VLM_MAX_SCREENSHOTS || 0);
      const toAssess =
        maxShots > 0 ? screenshots.slice(0, maxShots) : screenshots;
      if (toAssess.length < screenshots.length) {
        log(
          `VLM_MAX_SCREENSHOTS=${maxShots}: assessing ${toAssess.length} of ${screenshots.length} screenshot(s) to stay under API quota.`
        );
      }
      const engineLabel =
        vlmEngine === "claude" ? "Claude CLI" : vlmEngine === "cursor" ? "Cursor CLI" : "Gemini/OpenRouter";
      log(
        `Assessing ${toAssess.length} screenshot(s) via ${engineLabel} — UI/UX, Arabic/RTL & i18n lenses…`
      );
      for (const shot of toAssess) {
        assertNotStopped(); // no child process during VLM calls — only this check can stop the loop
        // Keep one copy of this screen's image on the job; bugs reference it by name.
        job.screenshots[shot.name] = shot.b64;
        const bugs = await assessScreenshot(shot, {
          specName: shot.name,
          targetUrl: effectiveBaseUrl,
          onLog: log,
          engine: vlmEngine,
        });
        for (const b of bugs) b.requirement_ref ||= shot.name;
        job.bugs.push(...bugs);
        log(`${shot.name}: ${bugs.length} issue(s) across lenses.`);
      }
    } else {
      log("No screenshots to assess — skipping VLM step.");
    }

    // 5. Dispatch --------------------------------------------------------
    assertNotStopped();
    if (dispatch && (dispatch.jira || dispatch.slack)) {
      job.dispatched = await dispatchBugs(
        job.bugs,
        {
          repoUrl,
          branch,
          productId,
          productName: product?.name,
        },
        dispatch,
        log
      );
    } else {
      log("Dispatch not requested — findings shown in console only.");
    }

    log(`Done — ${job.bugs.length} total finding(s).`);
    job.status = "done";
    return job;
  } catch (e) {
    if (job._stopped) {
      job.status = "stopped";
      emit(job, "Run stopped by user.");
      return job;
    }
    job.error = e.message;
    job.status = "error";
    emit(job, `ERROR: ${e.message}`);
    return job;
  }
}
