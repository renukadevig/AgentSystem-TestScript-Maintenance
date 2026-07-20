import { NextResponse } from "next/server";
import { parseRepo, cloneRepo, scanSpecs, filterSpecs } from "@/lib/github.js";
import { findProduct } from "@/lib/products.js";
import { newJobId } from "@/lib/jobs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { repoUrl, branch, productId }
 * Clones the branch (shallow) and returns the discovered Cypress specs so the
 * user can preview what a run would execute.
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { repoUrl, branch, productId } = body || {};
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
      jobId: `scan-${newJobId()}`,
    });
    let specs = await scanSpecs(dir);
    const product = findProduct(productId);
    const filtered = product?.specGlobs?.length
      ? filterSpecs(specs, product.specGlobs)
      : specs;

    return NextResponse.json({
      repo: `${parsed.owner}/${parsed.repo}`,
      branch: branch || "(default)",
      total: specs.length,
      specs: filtered.length ? filtered : specs,
      filtered: Boolean(filtered.length && filtered.length !== specs.length),
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
