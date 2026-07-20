/**
 * CLI Auth API
 *
 * POST /api/cli-auth  { cli, account? }
 *   Spawns the login command for the chosen CLI. The command opens a browser
 *   tab for OAuth. Returns immediately with a sessionId so the UI can poll.
 *
 * GET  /api/cli-auth?sessionId=...
 *   Returns the live status/output of the login session.
 *
 * GET  /api/cli-auth/status
 *   Returns the current logged-in state for all CLIs (no session needed).
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { config, cursorConfigured } from "@/lib/config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// In-memory store: sessionId → { status, log, pid }
// Fine for a local dev server; nothing is persisted across restarts.
const sessions = new Map();

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * POST { cli: "claude" | "cursor", account?: "business" | "personal" }
 * Spawns the login command and returns immediately.
 */
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const { cli, account } = body || {};
  if (!["claude", "cursor"].includes(cli)) {
    return NextResponse.json({ error: 'cli must be "claude" or "cursor"' }, { status: 400 });
  }

  const cfg = config();
  const sessionId = makeId();
  const session = { status: "running", log: [], pid: null };
  sessions.set(sessionId, session);

  function addLog(line) {
    session.log.push(line);
    // Keep last 200 lines
    if (session.log.length > 200) session.log.shift();
  }

  let bin, args, env;

  if (cli === "cursor") {
    bin = cfg.cursorCliPath;
    args = ["login"];
    env = { ...process.env };
  } else {
    bin = cfg.claudeCliPath;
    args = ["login"];
    env = { ...process.env };
    // For business/personal, point at the right config dir
    if (account === "business" && cfg.claudeAccounts.business) {
      env.CLAUDE_CONFIG_DIR = cfg.claudeAccounts.business;
    } else if (account === "personal" && cfg.claudeAccounts.personal) {
      env.CLAUDE_CONFIG_DIR = cfg.claudeAccounts.personal;
    }
  }

  // Make sure ~/.local/bin etc. are on PATH so the binary is found
  if (bin.includes("/")) env.PATH = `${path.dirname(bin)}:${env.PATH || ""}`;
  delete env.NODE_OPTIONS;

  addLog(`Spawning: ${bin} ${args.join(" ")}`);
  addLog("A browser tab will open — complete login there.");

  let child;
  try {
    // Use "inherit" for stdin so the CLI can do TTY-based auth prompts if needed.
    // stdout/stderr are piped so we can capture and stream them.
    child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    session.pid = child.pid;
  } catch (e) {
    session.status = "error";
    session.log.push(`Failed to spawn: ${e.message}`);
    return NextResponse.json({ sessionId, error: e.message }, { status: 500 });
  }

  child.stdout.on("data", (d) => {
    String(d).split("\n").filter(Boolean).forEach(addLog);
  });
  child.stderr.on("data", (d) => {
    String(d).split("\n").filter(Boolean).forEach(addLog);
  });
  child.on("error", (e) => {
    session.status = "error";
    addLog(`Error: ${e.message}`);
  });
  child.on("close", (code) => {
    session.status = code === 0 ? "done" : "error";
    addLog(code === 0 ? "Login successful ✓" : `Exited with code ${code}`);
  });

  return NextResponse.json({ sessionId });
}

/**
 * GET /api/cli-auth?sessionId=...   → live session status
 * GET /api/cli-auth                 → current login status for all CLIs
 */
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");

  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json({ status: s.status, log: s.log, pid: s.pid });
  }

  // Return live login state for all CLIs by running their status commands
  const cfg = config();
  const [claudeStatus, cursorStatus] = await Promise.all([
    checkCli(cfg.claudeCliPath, ["--version"]),
    checkCli(cfg.cursorCliPath, ["status"]),
  ]);

  return NextResponse.json({
    claude: claudeStatus,
    cursor: { ...cursorStatus, installed: cursorConfigured() },
    cursorModel: cfg.cursorModel,
  });
}

/** Run a quick CLI check and return { installed, loggedIn, info }. */
function checkCli(bin, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (bin.includes("/")) env.PATH = `${path.dirname(bin)}:${env.PATH || ""}`;
    delete env.NODE_OPTIONS;

    let out = "";
    let err = "";
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => resolve({ installed: false, loggedIn: false, info: "Not found" }));
    child.on("close", (code) => {
      const combined = `${out}\n${err}`.trim();
      // "agent status" prints "Logged in as ..." or "Not logged in"
      // "claude --version" just prints the version if installed
      const loggedIn = /logged in as|authenticated/i.test(combined) ||
        (code === 0 && args[0] === "--version");
      const notLoggedIn = /not logged in|login required/i.test(combined);
      resolve({
        installed: code !== 127,
        loggedIn: loggedIn && !notLoggedIn,
        info: combined.split("\n")[0].slice(0, 80),
      });
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve({ installed: false, loggedIn: false, info: "Timed out" }); }, 5000);
  });
}
