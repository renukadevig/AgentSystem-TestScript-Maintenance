import { NextResponse } from "next/server";
import { getJob, emit, serializeJob } from "@/lib/jobs.js";
import { commitToNewBranchAndPush } from "@/lib/selfheal.js";
import { parseRepo, getDefaultBranch, openPullRequest } from "@/lib/github.js";
import { notifySlackPrOpened } from "@/lib/dispatch.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — apply a FEATURE_CHANGED test update and open a draft PR.
 *
 * Only reachable after the reverify step reclassified a first-pass PRODUCT_BUG
 * as a recent feature change (not an app bug) and the human clicked
 * "Agree to apply for feature change". The AI already adapted the spec in the
 * working tree during reverify; here we commit that diff to a new branch and
 * open a draft PR for review.
 */
export async function POST(_req, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (job.verdict !== "FEATURE_CHANGED")
    return NextResponse.json(
      { error: "this action only applies to a FEATURE_CHANGED finding" },
      { status: 400 }
    );
  if (!job.projectDir)
    return NextResponse.json({ error: "no working tree for this job" }, { status: 400 });
  if (!job.changedFiles?.length)
    return NextResponse.json({ error: "no changes to apply" }, { status: 400 });
  if (job.committed)
    return NextResponse.json({ error: "already applied" }, { status: 409 });

  const log = (m) => emit(job, m);
  try {
    const { repoUrl, branch, spec } = job.input;
    const parsed = parseRepo(repoUrl);
    if (!parsed) throw new Error(`Could not parse a GitHub repo from: ${repoUrl}`);

    const base = branch || (await getDefaultBranch(parsed.owner, parsed.repo));
    const slug = spec
      .replace(/^.*\//, "")
      .replace(/\.(cy|spec|test)\.[jt]sx?$/i, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 40);
    const newBranch = `feature-change/${slug}-${job.id}`;
    const fc = job.featureChange || {};
    const message =
      `test(feature-change): update ${spec} for changed product behaviour\n\n` +
      (fc.summary ? `${fc.summary}\n\n` : "") +
      `Reclassified from a suspected product bug to a recent feature change by ` +
      `the QA Portal reverify step, then approved by a human before this PR.`;

    await commitToNewBranchAndPush({
      projectDir: job.projectDir,
      changedFiles: job.changedFiles,
      message,
      newBranch,
      onLog: log,
    });

    const body =
      `## 🔁 Test update for a recent feature change\n\n` +
      `Updated spec: \`${spec}\`\n\n` +
      `This started as a suspected **product bug**. An independent reverify run reclassified it ` +
      `as a **recent feature change** — the feature still works but behaves differently, so the ` +
      `test was out of date. A human approved applying the update.\n\n` +
      (fc.summary ? `- **What changed:** ${fc.summary}\n` : "") +
      (fc.reason ? `- **Why it's not a bug:** ${fc.reason}\n` : "") +
      `- **CLI:** ${job.cliUsed || "Claude Code"}\n` +
      `- **Files changed:** ${job.changedFiles.map((f) => `\`${f}\``).join(", ")}\n\n` +
      `### Summary\n${(job.healSummary || "").slice(0, 4000)}\n\n` +
      `> Opened by the QA Portal after human approval. Review before merging.`;

    const pr = await openPullRequest({
      owner: parsed.owner,
      repo: parsed.repo,
      head: newBranch,
      base,
      title: `test(feature-change): update ${spec}`,
      body,
      draft: true,
    });
    job.pr = { url: pr.url, number: pr.number, branch: newBranch, base, draft: pr.draft };
    job.committed = true;
    log(`✅ Opened ${pr.draft ? "draft " : ""}PR #${pr.number} (${newBranch} → ${base}): ${pr.url}`);

    await notifySlackPrOpened(
      {
        pr: job.pr,
        spec,
        verdict: job.verdict,
        changedFiles: job.changedFiles,
        cliUsed: job.cliUsed,
      },
      log
    );

    return NextResponse.json(serializeJob(job));
  } catch (e) {
    job.prError = e?.message || String(e);
    log(`⚠ Could not apply the feature change / open a PR: ${job.prError}`);
    return NextResponse.json({ error: job.prError }, { status: 502 });
  }
}
