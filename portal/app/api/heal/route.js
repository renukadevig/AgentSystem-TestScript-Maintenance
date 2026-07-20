import { NextResponse } from "next/server";
import { createJob, serializeJob } from "@/lib/jobs.js";
import { runHealPipeline } from "@/lib/healPipeline.js";
import { parseRepo } from "@/lib/github.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { repoUrl, branch, spec, baseUrl?, extraPrompt?, account? }
 * Starts a background self-heal run (Claude Code fixes the failing spec, no
 * commit). The UI polls GET /api/heal/[jobId] and commits on approval via
 * POST /api/heal/[jobId]/commit.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoUrl, branch, spec, baseUrl, extraPrompt, account, cliType, openPr, failureContext, framework, compareUrl } = body || {};
  if (!parseRepo(repoUrl || "")) {
    return NextResponse.json(
      { error: `Could not parse a GitHub repo from: ${repoUrl}` },
      { status: 400 }
    );
  }
  if (!spec) {
    return NextResponse.json({ error: "spec is required" }, { status: 400 });
  }

  const job = createJob({
    repoUrl,
    branch: branch || "",
    spec,
    baseUrl: baseUrl || "",
    extraPrompt: (extraPrompt || "").trim(),
    account: ["business", "personal"].includes(account) ? account : "",
    cliType: ["claude", "cursor"].includes(cliType) ? cliType : "claude",
    openPr: Boolean(openPr),
    framework: framework === "playwright" ? "playwright" : "cypress",
    compareUrl: typeof compareUrl === "string" ? compareUrl.slice(0, 300) : "",
    // Failure detail already captured by CI (report errors/stack) — lets the
    // AI analyse + fix directly and skip the reproduction run.
    failureContext: typeof failureContext === "string" ? failureContext.slice(0, 8000) : "",
    mode: "heal",
  });

  runHealPipeline(job).catch((e) => {
    job.status = "error";
    job.error = e?.message || String(e);
  });

  return NextResponse.json({ jobId: job.id, ...serializeJob(job) });
}
