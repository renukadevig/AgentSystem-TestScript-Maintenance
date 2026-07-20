import { NextResponse } from "next/server";
import { createJob, serializeJob } from "@/lib/jobs.js";
import { runPipeline } from "@/lib/runPipeline.js";
import { parseRepo } from "@/lib/github.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { repoUrl, branch, productId, baseUrl?, testType?: "uiux"|"automation",
 *        vlmEngine?: "gemini"|"claude"|"cursor", dispatch?: {jira,slack} }
 * Starts a background run and returns the job id immediately. The UI polls
 * GET /api/test/[jobId] for progress.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoUrl, branch, productId, baseUrl, dispatch, specs, testType, vlmEngine } = body || {};
  if (!parseRepo(repoUrl || "")) {
    return NextResponse.json(
      { error: `Could not parse a GitHub repo from: ${repoUrl}` },
      { status: 400 }
    );
  }
  if (!productId) {
    return NextResponse.json({ error: "productId is required" }, { status: 400 });
  }

  const job = createJob({
    repoUrl,
    branch: branch || "",
    productId,
    baseUrl: baseUrl || "",
    specs: Array.isArray(specs) ? specs : [],
    testType: testType === "automation" ? "automation" : "uiux",
    vlmEngine: vlmEngine === "claude" || vlmEngine === "cursor" ? vlmEngine : "gemini",
    dispatch: {
      jira: Boolean(dispatch?.jira),
      slack: Boolean(dispatch?.slack),
    },
  });

  // Fire-and-forget: run in the background, UI polls for status.
  runPipeline(job).catch((e) => {
    job.status = "error";
    job.error = e?.message || String(e);
  });

  return NextResponse.json({ jobId: job.id, ...serializeJob(job) });
}
