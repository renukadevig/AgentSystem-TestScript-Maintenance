import { NextResponse } from "next/server";
import { getJob, serializeJob } from "@/lib/jobs.js";
import { dispatchBugs } from "@/lib/dispatch.js";
import { jiraConfigured } from "@/lib/config.js";
import { findProduct } from "@/lib/products.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { jobId, projectKey }
 * Files every (not-yet-filed) bug on a job to Jira under one project key —
 * the bulk "Report to Jira" button, as opposed to /api/jira's per-bug button.
 */
export async function POST(req) {
  if (!jiraConfigured()) {
    return NextResponse.json(
      { error: "Jira is not configured (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)." },
      { status: 400 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { jobId, projectKey } = body || {};
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

  const key = (projectKey || "").trim();
  if (!key) return NextResponse.json({ error: "A Jira project key is required." }, { status: 400 });
  if (!job.bugs.length) return NextResponse.json({ error: "No bugs to report." }, { status: 400 });

  // Don't re-file bugs already successfully filed to Jira on this job.
  const alreadyFiled = new Set(
    job.dispatched.filter((d) => d.target === "jira" && d.key).map((d) => d.bug)
  );
  const toFile = job.bugs.filter((b) => !alreadyFiled.has(b.id));
  if (!toFile.length) {
    return NextResponse.json({ job: serializeJob(job), filed: 0, failed: 0 });
  }

  const product = findProduct(job.input?.productId);
  const records = await dispatchBugs(
    toFile,
    {
      repoUrl: job.input?.repoUrl,
      branch: job.input?.branch,
      productId: job.input?.productId,
      productName: product?.name,
    },
    { jira: true, slack: false },
    null,
    key
  );
  job.dispatched.push(...records);

  return NextResponse.json({
    job: serializeJob(job),
    filed: records.filter((r) => !r.error).length,
    failed: records.filter((r) => r.error).length,
  });
}
