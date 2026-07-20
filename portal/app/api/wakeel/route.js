import { NextResponse } from "next/server";
import { buildWakeelReport } from "@/lib/wakeel.js";
import { jiraConfigured } from "@/lib/config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { projectKeys?, extraJql?, maxIssues? }
 * Runs the on-demand Wakeel agent-coverage report over Story-type issues and
 * returns it. Called by the "Fetch report" button on /wakeel.
 */
export async function POST(req) {
  if (!jiraConfigured()) {
    return NextResponse.json(
      { error: "Jira is not configured (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)." },
      { status: 400 }
    );
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — report all Story projects */
  }

  const log = [];
  try {
    const report = await buildWakeelReport(
      {
        projectKeys: body.projectKeys || "",
        extraJql: body.extraJql || "",
        maxIssues: body.maxIssues,
      },
      (m) => log.push(m)
    );
    return NextResponse.json({ ...report, log });
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e), log }, { status: 502 });
  }
}
