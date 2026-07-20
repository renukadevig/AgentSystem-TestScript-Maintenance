#!/usr/bin/env node
/**
 * Agent evaluation: how well is the self-heal agent doing inside its harness?
 *
 * Reads the portal's file-backed job store (lib/jobs.js persists every job,
 * including per-attempt loop verdicts in job.healLoops) and aggregates the
 * numbers that answer "is the agent actually good?":
 *
 *   - heal success rate, and how much of it is INDEPENDENTLY verified
 *   - first-attempt heals vs heals that needed the retry loop (i.e. how often
 *     the observe→replan loop earned its keep)
 *   - honesty outcomes: PRODUCT_BUG / OBSOLETE_TEST / COULD_NOT_FIX — the
 *     verdicts where refusing to force green is the CORRECT behavior
 *   - attempts per job, draft PRs opened
 *
 * Usage:
 *   node evaluation/agent-metrics.mjs           # human-readable report
 *   node evaluation/agent-metrics.mjs --json    # machine-readable JSON
 *
 * Reads WORKSPACE_DIR (default .workspaces) relative to the repo root, same
 * as the server does — run it from the repo root.
 */
import fs from "node:fs";
import path from "node:path";

const STORE = path.resolve(
  process.cwd(),
  process.env.WORKSPACE_DIR || ".workspaces",
  "jobs-store.json"
);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
} catch {
  console.error(`No job store found at ${STORE} — run some heal jobs first (or set WORKSPACE_DIR).`);
  process.exit(1);
}

const jobs = Object.values(raw).filter((j) => (j.mode || j.input?.mode) === "heal");
const completed = jobs.filter((j) => j.status === "done");
const byVerdict = (v) => completed.filter((j) => (j.verdict || "UNKNOWN") === v);

const healed = byVerdict("HEALED");
const productBug = byVerdict("PRODUCT_BUG");
const obsolete = byVerdict("OBSOLETE_TEST");
const couldNotFix = byVerdict("COULD_NOT_FIX");

// Verified = the harness's own independent Cypress/Playwright rerun was green,
// not just the AI's claim. verifyNote marks env-unreachable acceptances.
const verifiedHealed = healed.filter((j) => j.verified === true);
const unverifiedHealed = healed.filter((j) => j.verified !== true);

const attemptsOf = (j) => (j.healLoops || []).length || null;
const firstAttemptHeals = healed.filter((j) => attemptsOf(j) === 1);
const retryHeals = healed.filter((j) => (attemptsOf(j) || 0) > 1);

const attemptCounts = completed.map(attemptsOf).filter(Boolean);
const avgAttempts = attemptCounts.length
  ? (attemptCounts.reduce((a, b) => a + b, 0) / attemptCounts.length).toFixed(2)
  : null;

const prsOpened = jobs.filter((j) => j.pr?.url).length;

// "Fixable" = jobs where a fix was the right answer (excludes the honest
// stops: product bugs and obsolete tests are correct NON-fix outcomes).
const fixable = healed.length + couldNotFix.length;

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

const report = {
  store: STORE,
  jobs: {
    total: jobs.length,
    completed: completed.length,
    error: jobs.filter((j) => j.status === "error").length,
    interruptedOrStopped: jobs.filter((j) => ["interrupted", "stopped"].includes(j.status)).length,
  },
  verdicts: {
    HEALED: healed.length,
    PRODUCT_BUG: productBug.length,
    OBSOLETE_TEST: obsolete.length,
    COULD_NOT_FIX: couldNotFix.length,
    UNKNOWN: byVerdict("UNKNOWN").length,
  },
  effectiveness: {
    healSuccessRate: pct(healed.length, fixable),
    healSuccessRateNote: "HEALED / (HEALED + COULD_NOT_FIX) — honest stops excluded",
    independentlyVerified: `${verifiedHealed.length}/${healed.length}`,
    unverifiedAccepted: unverifiedHealed.length,
    firstAttemptHeals: firstAttemptHeals.length,
    healsThatNeededRetryLoop: retryHeals.length,
    avgAttemptsPerCompletedJob: avgAttempts,
  },
  honesty: {
    productBugStops: productBug.length,
    obsoleteTestStops: obsolete.length,
    honestGiveUps: couldNotFix.length,
    note: "these are CORRECT outcomes — the agent refused to force a test green",
  },
  output: { draftPrsOpened: prsOpened },
  perJob: completed.map((j) => ({
    id: j.id,
    spec: j.input?.spec || "",
    verdict: j.verdict || "UNKNOWN",
    attempts: attemptsOf(j),
    verified: j.verified ?? null,
    pr: j.pr?.url || null,
    cli: j.cliUsed || "",
  })),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const line = (s = "") => console.log(s);
line(`QA Portal — self-heal agent evaluation`);
line(`store: ${STORE}`);
line();
line(`Jobs: ${report.jobs.total} heal job(s) · ${report.jobs.completed} completed · ${report.jobs.error} error · ${report.jobs.interruptedOrStopped} interrupted/stopped`);
line();
line(`Verdicts (completed)`);
for (const [k, v] of Object.entries(report.verdicts)) {
  if (v) line(`  ${k.padEnd(14)} ${String(v).padStart(3)}  ${pct(v, completed.length)}`);
}
line();
line(`Effectiveness`);
line(`  heal success rate      ${report.effectiveness.healSuccessRate}  (${report.effectiveness.healSuccessRateNote})`);
line(`  independently verified ${report.effectiveness.independentlyVerified} of HEALED (pipeline's own rerun, not the AI's claim)`);
if (unverifiedHealed.length) line(`  ⚠ accepted unverified  ${unverifiedHealed.length} (app unreachable from pipeline — flagged on the PR)`);
line(`  healed on attempt 1    ${report.effectiveness.firstAttemptHeals}`);
line(`  healed via retry loop  ${report.effectiveness.healsThatNeededRetryLoop}  (the observe→replan loop earned its keep)`);
if (avgAttempts) line(`  avg attempts / job     ${avgAttempts}`);
line();
line(`Honesty (correct non-fix outcomes — never forced green)`);
line(`  product bugs reported  ${report.honesty.productBugStops}`);
line(`  obsolete tests flagged ${report.honesty.obsoleteTestStops}`);
line(`  honest give-ups        ${report.honesty.honestGiveUps}`);
line();
line(`Output: ${prsOpened} draft PR(s) opened`);
line();
line(`Per job`);
for (const j of report.perJob) {
  line(`  ${j.id}  ${String(j.verdict).padEnd(14)} attempts=${j.attempts ?? "?"} verified=${j.verified === null ? "—" : j.verified}  ${j.spec}${j.pr ? `  → ${j.pr}` : ""}`);
}
