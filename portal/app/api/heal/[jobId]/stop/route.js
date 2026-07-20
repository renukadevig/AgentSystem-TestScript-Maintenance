import { NextResponse } from "next/server";
import { getJob, killJob, emit, serializeJob } from "@/lib/jobs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST — stop a running self-heal job (kills Claude / Cypress / clone). */
export async function POST(_req, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "running" && job.status !== "queued") {
    return NextResponse.json({ error: `job is ${job.status}` }, { status: 409 });
  }
  emit(job, "Stop requested — terminating…");
  killJob(job);
  return NextResponse.json(serializeJob(job));
}
