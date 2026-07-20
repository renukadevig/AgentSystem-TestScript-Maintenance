import { NextResponse } from "next/server";
import { resolvePr } from "@/lib/github.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pr?url=<github PR link>
 * Resolves a PR link to its repo + head branch so the UI can auto-fill the
 * repo and branch fields.
 */
export async function GET(req) {
  const url = new URL(req.url).searchParams.get("url") || "";
  try {
    const resolved = await resolvePr(url);
    return NextResponse.json(resolved);
  } catch (e) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 400 });
  }
}
