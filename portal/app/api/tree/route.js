import { NextResponse } from "next/server";
import { parseRepo, cloneRepo, scanSpecs, buildFunnelTree } from "@/lib/github.js";
import { newJobId } from "@/lib/jobs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { repoUrl, branch }
 * Clones the branch and returns a platform → product → funnel-spec tree built
 * entirely from the repo, so the UI dropdowns + funnel-script list are
 * repo-driven (nothing hardcoded).
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoUrl, branch } = body || {};
  const parsed = parseRepo(repoUrl || "");
  if (!parsed) {
    return NextResponse.json(
      { error: `Could not parse a GitHub repo from: ${repoUrl}` },
      { status: 400 }
    );
  }

  try {
    const dir = await cloneRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      jobId: `tree-${newJobId()}`,
    });
    const specs = await scanSpecs(dir);
    const { platforms, tree } = buildFunnelTree(specs);
    const totalFunnelSpecs = Object.values(tree)
      .flatMap((p) => Object.values(p))
      .reduce((n, arr) => n + arr.length, 0);

    return NextResponse.json({
      repo: `${parsed.owner}/${parsed.repo}`,
      branch: branch || "(default)",
      platforms,
      tree,
      totalSpecs: specs.length,
      totalFunnelSpecs,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
