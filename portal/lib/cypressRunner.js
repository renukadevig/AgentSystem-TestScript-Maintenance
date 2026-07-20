/**
 * Run Cypress against a cloned repo by spawning the Cypress CLI as a
 * subprocess, then collect the screenshot artifacts it produced for the VLM.
 *
 * Why the CLI and not the in-process Node Module API (`cypress.run()`):
 * cypress.run() fails under the Next.js server runtime with "Could not find
 * Cypress test run results" (it bails in ~1s before Electron launches). The
 * CLI runs headless and works, so we shell out to the portal's own cypress
 * binary pointed at the cloned project.
 *
 * There is no Figma/baseline to diff against, so screenshots are returned as a
 * flat list — each is reviewed on its own by the UI/UX, Arabic/RTL and i18n
 * lenses in vlm.js. Pre-computed visual-regression diff images are skipped.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_COMPARISONS = Number(process.env.MAX_COMPARISONS || 12);
const RUN_TIMEOUT_MS = Number(process.env.CYPRESS_RUN_TIMEOUT_MS || 900000);

function runCli(cmd, args, { cwd, timeoutMs, onLog, onChild }) {
  return new Promise((resolve, reject) => {
    // Next's dev server sets NODE_OPTIONS (inspector/loader flags) which the
    // Cypress Electron binary rejects ("not supported in packaged apps") and
    // which can degrade the run — strip it for the child.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(cmd, args, { cwd, env });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Cypress run timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // Cypress exits non-zero when tests FAIL — that's expected (failures
      // produce screenshots), so we resolve regardless of exit code.
      resolve({ code, stdout, stderr });
    });
  });
}

/** Detect a page-load failure (gated env, network error) from Cypress output. */
function detectLoadFailure(out) {
  const m = out.match(
    /(\d{3})\s*[-:]?\s*(Forbidden|Unauthorized|Not Found|Bad Gateway|Service Unavailable|Internal Server Error|Gateway Timeout)/i
  );
  if (m) return `HTTP ${m[1]} ${m[2]}`;
  if (
    /cy\.visit\(\)\s*failed|failed trying to load|could not load|net::|ERR_|ECONNREFUSED|ENOTFOUND/i.test(
      out
    )
  )
    return "page failed to load (cy.visit error — check the Base URL is a plain origin)";
  return null;
}

/**
 * Pull failing-test detail out of Cypress's mocha "spec" reporter output.
 * After the passing/failing counts, failures are printed as numbered blocks:
 *   1) Suite title
 *        nested title:
 *      AssertionError: expected 'x' to equal 'y'
 *       at ...stack frames...
 * The last title line ends with ":" (mocha convention); the line right after
 * it is the error message. Best-effort — a repo with a custom reporter simply
 * won't match, and the caller falls back to a run-level summary bug.
 */
function parseFailures(stdout) {
  const failures = [];
  // Failures live between the last "N failing" line and Cypress's own
  // "(Results)" summary table (marked by the box-drawing "┌").
  const start = stdout.search(/\n\s*\d+\s+failing\s*\n/);
  if (start < 0) return failures;
  const end = stdout.indexOf("┌", start);
  const block = stdout.slice(start, end >= 0 ? end : undefined);

  const chunks = block.split(/\n\s*\d+\)\s+/).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    const titleEndIdx = lines.findIndex((l) => l.endsWith(":"));
    const titleLines = titleEndIdx >= 0 ? lines.slice(0, titleEndIdx + 1) : lines.slice(0, 1);
    const title = titleLines.join(" ").replace(/:$/, "");
    const errorLines = (titleEndIdx >= 0 ? lines.slice(titleEndIdx + 1) : lines.slice(1)).filter(
      (l) => !l.startsWith("at ")
    );
    const error = errorLines.join(" ").slice(0, 500);
    if (title) failures.push({ title, error: error || "(no error message captured)" });
  }
  return failures;
}

/** Pull pass/fail counts out of Cypress's run-summary table. */
function parseSummary(stdout, code) {
  const num = (re) => {
    const m = stdout.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const totalTests = num(/Tests:\s+(\d+)/);
  const totalPassed = num(/Passing:\s+(\d+)/);
  const totalFailed = num(/Failing:\s+(\d+)/);
  return {
    totalTests,
    totalPassed,
    totalFailed,
    totalPending: num(/Pending:\s+(\d+)/),
    totalSkipped: num(/Skipped:\s+(\d+)/),
    exitCode: code,
    loadError: detectLoadFailure(stdout),
    failures: parseFailures(stdout),
  };
}

const REPORT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
const MAX_REPORT_JSON_BYTES = 20 * 1024 * 1024;

/**
 * Repos using a custom reporter (cypress-mochawesome-reporter,
 * cypress-multi-reporters, etc.) never print Cypress's own summary table, so
 * `parseSummary` can't regex counts out of stdout. Those reporters do write a
 * merged mochawesome-format JSON report (`{ stats: { tests, passes,
 * failures, ... } }`) somewhere under the project — find the most recent one
 * written during this run and pull real counts from it instead of guessing.
 */
async function findMochawesomeSummary(projectDir, sinceMs) {
  let best = null;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (REPORT_SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs < sinceMs || stat.size > MAX_REPORT_JSON_BYTES) continue;
        if (best && stat.mtimeMs <= best.mtimeMs) continue;
        let data;
        try {
          data = JSON.parse(await fs.readFile(full, "utf8"));
        } catch {
          continue;
        }
        const stats = data?.stats;
        if (stats && typeof stats.tests === "number") {
          best = { mtimeMs: stat.mtimeMs, path: full, stats };
        }
      }
    }
  }
  await walk(projectDir);
  return best;
}

/**
 * @returns {Promise<{summary: object, screenshots: Array}>}
 */
export async function runCypress({
  projectDir,
  specs,
  baseUrl,
  failureScreenshots = true,
  onLog,
  onChild,
}) {
  const screenshotsFolder = path.join(projectDir, "cypress", "screenshots");

  // The portal's own cypress binary (verified) drives the cloned project.
  const cliPath = path.resolve(process.cwd(), "node_modules", ".bin", "cypress");

  const cfg = [`screenshotsFolder=${screenshotsFolder}`, "video=false"];
  // When we've injected app-only viewport screenshots, suppress Cypress's
  // runner-chrome failure screenshots so the VLM only sees the real page.
  cfg.push(`screenshotOnRunFailure=${failureScreenshots}`);
  if (baseUrl) cfg.push(`baseUrl=${baseUrl}`);
  const args = ["run", "--project", projectDir, "--config", cfg.join(",")];
  if (specs?.length) args.push("--spec", specs.join(","));

  onLog?.(
    `Running Cypress (CLI) on ${specs?.length || "all"} spec(s)${
      baseUrl ? ` against ${baseUrl}` : ""
    }…`
  );

  const runStart = Date.now();
  let result;
  try {
    result = await runCli(cliPath, args, {
      cwd: projectDir,
      timeoutMs: RUN_TIMEOUT_MS,
      onLog,
      onChild,
    });
  } catch (err) {
    throw new Error(`Cypress failed to run: ${err.message}`);
  }

  const summary = parseSummary(result.stdout, result.code);
  if (summary.totalTests === undefined) {
    // No standard "spec" reporter table in stdout (custom reporter, e.g.
    // cypress-mochawesome-reporter) — fall back to its merged JSON report.
    const report = await findMochawesomeSummary(projectDir, runStart);
    if (report) {
      summary.totalTests = report.stats.tests;
      summary.totalPassed = report.stats.passes;
      summary.totalFailed = report.stats.failures;
      summary.totalPending = report.stats.pending ?? summary.totalPending;
      summary.totalSkipped = report.stats.skipped ?? summary.totalSkipped;
      onLog?.(
        `No standard Cypress summary table (custom reporter) — read counts from ${path.relative(
          projectDir,
          report.path
        )} instead.`
      );
    } else if (result.code > 0) {
      // Last resort: Cypress's exit code equals the number of failing tests.
      summary.totalFailed = result.code;
      summary.totalPassed = 0;
    }
  }
  onLog?.(
    `Cypress finished (exit ${result.code}) — ${summary.totalPassed ?? "?"} passed, ${
      summary.totalFailed ?? "?"
    } failed${summary.totalTests ? ` of ${summary.totalTests}` : ""}.`
  );
  if (summary.loadError) {
    onLog?.(
      `⚠ Cypress ran, but the app did NOT load: ${summary.loadError}. ` +
        `The funnel can't execute against a blocked page — set a reachable Base URL or run on VPN.`
    );
  } else if (summary.exitCode > 0 && summary.totalTests === undefined) {
    const tail = (result.stderr || result.stdout || "").slice(-500);
    onLog?.(`No standard run summary (custom reporter?). Output tail: ${tail}`);
  }

  // Surface the actual failure detail in the log so a failed run is diagnosable.
  if ((summary.totalFailed || 0) > 0 || (summary.exitCode > 0 && !summary.loadError)) {
    if (summary.failures?.length) {
      for (const f of summary.failures) onLog?.(`✗ ${f.title}\n   ${f.error}`);
    }
    // Keep a tail of the raw output for the UI to show even when the mocha
    // block wasn't parseable.
    const tail = (result.stdout || result.stderr || "")
      .replace(/\[[0-9;]*m/g, "") // strip ANSI colour codes
      .slice(-2000)
      .trim();
    summary.logTail = tail;
    onLog?.(`Failure output (tail):\n${tail}`);
  }

  const screenshots = await collectScreenshots(screenshotsFolder, onLog);
  onLog?.(`Collected ${screenshots.length} screenshot(s).`);
  return { summary, screenshots: screenshots.slice(0, MAX_COMPARISONS) };
}

const PNG_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

async function findPngs(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (PNG_SKIP_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".png")) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

/**
 * Collect the screenshots the run produced as a flat list. With no Figma /
 * baseline to diff against, every screenshot is reviewed on its own by the
 * three VLM lenses. Diff images from a visual-regression plugin (if any) are
 * skipped — they aren't a single screen to assess.
 */
async function collectScreenshots(screenshotsFolder, onLog) {
  let pngs = (await findPngs(screenshotsFolder)).filter(
    (p) => !p.toLowerCase().includes("diff")
  );
  // Prefer our injected app-only ("vlm__") screenshots if present, so the VLM
  // never sees Cypress's runner panel even if both kinds exist.
  const appOnly = pngs.filter((p) => path.basename(p).startsWith("vlm__"));
  if (appOnly.length) pngs = appOnly;
  if (!pngs.length) {
    onLog?.(
      "No screenshots produced by this run (specs passed without capturing, or none ran). " +
        "Add cy.screenshot() in the specs, or rely on failure screenshots."
    );
    return [];
  }
  pngs.sort();
  const shots = [];
  for (const p of pngs) {
    const buf = await fs.readFile(p);
    shots.push({ name: path.basename(p, ".png"), state: "default", b64: buf.toString("base64") });
  }
  return shots;
}

/**
 * Playwright sibling of runCypress — verification runs for repos whose specs
 * are Playwright tests. Exit code 0 = all passed (Playwright exits non-zero on
 * any failure), counts parsed from the line reporter.
 */
export async function runPlaywright({ projectDir, specs, onLog, onChild }) {
    const args = ['playwright', 'test', ...(specs || []), '--reporter=line'];
    onLog?.(`Running Playwright (CLI) on ${specs?.length || 'all'} spec(s)…`);
    const runStart = Date.now();
    void runStart;
    let result;
    try {
        result = await runCli('npx', args, {
            cwd: projectDir,
            timeoutMs: RUN_TIMEOUT_MS,
            onLog,
            onChild,
        });
    } catch (err) {
        throw new Error(`Playwright failed to run: ${err.message}`);
    }
    const out = `${result.stdout}\n${result.stderr}`;
    const num = (re) => {
        const m = out.match(re);
        return m ? Number(m[1]) : undefined;
    };
    const totalPassed = num(/(\d+)\s+passed/i);
    const totalFailed = num(/(\d+)\s+failed/i) ?? (result.code > 0 ? 1 : 0);
    const summary = {
        totalTests: (totalPassed || 0) + (totalFailed || 0) || undefined,
        totalPassed,
        totalFailed,
        exitCode: result.code,
        loadError: detectLoadFailure(out),
        failures: [],
        logTail: out.replace(/\[[0-9;]*m/g, '').slice(-2000).trim(),
    };
    onLog?.(
        `Playwright finished (exit ${result.code}) — ${totalPassed ?? '?'} passed, ${totalFailed ?? '?'} failed.`,
    );
    return { summary, screenshots: [] };
}
