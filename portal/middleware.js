import { NextResponse } from "next/server";

/**
 * Shared-password gate (HTTP Basic Auth).
 *
 * Protects every route — pages AND /api — so the portal can be shared over a
 * public tunnel (e.g. Cloudflare Tunnel) without being wide open. The browser
 * shows its native login popup; teammates type the shared password once.
 *
 * Set PORTAL_PASSWORD in .env.local. If it's blank/unset the gate is DISABLED
 * (convenient for local dev), so the app behaves exactly as before until you
 * opt in by setting a password. Any username is accepted — only the password
 * is checked.
 */
export function middleware(req) {
  const password = process.env.PORTAL_PASSWORD;
  if (!password) return NextResponse.next(); // gate disabled when unset

  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice("Basic ".length)); // "user:pass"
      const provided = decoded.slice(decoded.indexOf(":") + 1);
      if (provided === password) return NextResponse.next();
    } catch {
      /* malformed header — fall through to 401 */
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TestRun Portal"' },
  });
}

export const config = {
  // Guard everything except Next's own static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
