import { NextResponse } from "next/server";
import { createJiraIssue } from "@/lib/dispatch.js";
import { jiraConfigured } from "@/lib/config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { bug, projectKey, ctx? }
 * Files a single VLM finding as a Jira bug under the given project key
 * (e.g. "TRN", "CTH"). Used by the per-bug "Report to Jira" button.
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

  const { bug, projectKey, ctx } = body || {};
  if (!bug || !bug.title) {
    return NextResponse.json({ error: "A bug with a title is required." }, { status: 400 });
  }
  const key = (projectKey || "").trim();
  if (!key) {
    return NextResponse.json({ error: "A Jira project key is required." }, { status: 400 });
  }

  try {
    const rec = await createJiraIssue(bug, ctx || {}, key);
    return NextResponse.json(rec);
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
