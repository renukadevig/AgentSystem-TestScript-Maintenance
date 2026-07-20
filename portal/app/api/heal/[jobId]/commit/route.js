import { NextResponse } from "next/server";
import { getJob, emit, serializeJob } from "@/lib/jobs.js";
import { commitAndPush } from "@/lib/selfheal.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — commit the reviewed self-heal changes and push to the same branch.
 * Called only after the human approves the diff in the UI.
 */
export async function POST(_req, { params }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (!job.projectDir)
    return NextResponse.json({ error: "no working tree for this job" }, { status: 400 });
  if (!job.changedFiles?.length)
    return NextResponse.json({ error: "no changes to commit" }, { status: 400 });
  if (job.committed)
    return NextResponse.json({ error: "already committed" }, { status: 409 });

  try {
    const message =
      `fix(self-heal): repair ${job.input.spec}\n\n` +
      `Automated self-heal via QA Portal, reviewed and approved before commit.`;
    await commitAndPush({
      projectDir: job.projectDir,
      changedFiles: job.changedFiles,
      message,
      branch: job.input.branch,
      onLog: (m) => emit(job, m),
    });
    job.committed = true;
    emit(
      job,
      `Committed & pushed ${job.changedFiles.length} file(s) to ${job.input.branch || "the branch"}.`
    );
    return NextResponse.json(serializeJob(job));
  } catch (e) {
    emit(job, `Commit failed: ${e.message}`);
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
