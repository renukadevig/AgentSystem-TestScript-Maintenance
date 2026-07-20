import { NextResponse } from "next/server";
import { getJob, serializeJob } from "@/lib/jobs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(serializeJob(job));
}
