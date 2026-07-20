#!/usr/bin/env node
/**
 * Dev-server guard: run `npm run guard` in a terminal INSTEAD of `npm run dev`.
 *
 * Supervises `next dev` so the portal survives crashes (auto-respawn), and
 * exposes a tiny control API the UI's "server down" banner talks to:
 *   GET  /health   → { up: boolean }
 *   POST /restart  → kill + respawn the dev server
 *
 * No dependencies — plain node. The dev server itself can't offer a restart
 * button (once it's dead nothing is listening), which is why this lives in a
 * separate always-on process on its own port.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_PORT = Number(process.env.GUARD_PORT || 8082);
const PORTAL_PORT = Number(process.env.PORTAL_PORT || 8080);
const dir = path.dirname(fileURLToPath(import.meta.url));

let child = null;
let restarting = false;

function start() {
  // detached → own process group, so restart() can kill next dev AND the
  // worker processes it spawns (killing just the parent leaves the port bound).
  child = spawn(path.join(dir, "node_modules", ".bin", "next"), ["dev", "-p", String(PORTAL_PORT)], {
    cwd: dir,
    stdio: "inherit",
    detached: true,
  });
  console.log(`[guard] portal started (pid ${child.pid}) on http://localhost:${PORTAL_PORT}`);
  child.on("exit", (code, signal) => {
    child = null;
    if (restarting) return; // manual restart respawns explicitly
    console.log(`[guard] dev server exited (${signal || code}) — restarting in 3s…`);
    setTimeout(start, 3000);
  });
}

function killGroup(signal = "SIGKILL") {
  if (!child) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function restart(res) {
  console.log("[guard] restart requested from the UI");
  restarting = true;
  const respawn = () => {
    restarting = false;
    start();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  };
  if (child) {
    child.once("exit", () => setTimeout(respawn, 500));
    killGroup();
  } else {
    respawn();
  }
}

http
  .createServer((req, res) => {
    // The portal page (localhost:8080) calls this cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ up: Boolean(child) }));
    }
    if (req.method === "POST" && req.url === "/restart") {
      return restart(res);
    }
    res.writeHead(404);
    res.end();
  })
  .listen(GUARD_PORT, "127.0.0.1", () => {
    console.log(`[guard] control API on http://127.0.0.1:${GUARD_PORT} (POST /restart)`);
  });

// Take the dev server down with us on Ctrl-C so the port isn't left bound.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killGroup();
    process.exit(0);
  });
}

start();
