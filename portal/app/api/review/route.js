import { NextResponse } from "next/server";
import { createJob, serializeJob } from "@/lib/jobs.js";
import { runReviewPipeline } from "@/lib/reviewPipeline.js";
import { parsePrUrl } from "@/lib/github.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { prUrl, extraPrompt?, account?, cliType? }
 * Starts a background PR review (local AI CLI drafts the review; nothing is
 * posted to GitHub). The UI polls GET /api/review/[jobId].
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { prUrl, extraPrompt, account, cliType } = body || {};
  if (!parsePrUrl(prUrl || "")) {
    return NextResponse.json(
      { error: `Not a GitHub PR link: ${prUrl}` },
      { status: 400 }
    );
  }

  const job = createJob({
    prUrl: prUrl.trim(),
    extraPrompt: (extraPrompt || "").trim(),
    account: ["business", "personal"].includes(account) ? account : "",
    cliType: ["claude", "cursor"].includes(cliType) ? cliType : "claude",
    mode: "review",
  });

  runReviewPipeline(job).catch((e) => {
    job.status = "error";
    job.error = e?.message || String(e);
  });

  return NextResponse.json({ jobId: job.id, ...serializeJob(job) });
}
