/**
 * Run one consolidated (all-lenses) VLM pass through a local coding-agent CLI
 * — Claude Code or Cursor — instead of a hosted vision API. Both are full
 * agents with their own multimodal Read tool, so pointing them at a saved
 * screenshot PNG and asking them to assess it works with no OpenRouter/Gemini
 * key. Mirrors the spawn pattern already used for self-heal in selfheal.js:
 * stdio ["ignore","pipe","pipe"] so `-p` doesn't stall 3s waiting on stdin,
 * and both stdout+stderr are captured since these CLIs print real failures
 * (e.g. usage-limit) to stdout, not stderr.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";

const CLI_VLM_TIMEOUT_MS = Number(process.env.CLI_VLM_TIMEOUT_MS || 180000); // 3 min/screenshot

function spawnCli(cli, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cli, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`Could not launch "${cli}": ${e.message}`));
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI VLM pass timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT")
        reject(new Error(`CLI not found at "${cli}". Check the *_CLI_PATH setting in .env.local.`));
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      // Surface both streams — these CLIs often print the real failure to
      // stdout while stderr holds only a benign warning.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n---\n").slice(-1200);
      if (/hit your (session|usage) limit|usage limit reached|resets \d/i.test(detail)) {
        return reject(
          new Error(`Usage/session limit reached — VLM pass can't run until it resets. ${detail}`)
        );
      }
      reject(new Error(`CLI exited ${code}: ${detail || "(no output)"}`));
    });
  });
}

function baseEnv(cliPath) {
  const env = { ...process.env };
  // Next's dev server sets NODE_OPTIONS (inspector/loader flags) some CLIs reject.
  delete env.NODE_OPTIONS;
  if (cliPath.includes("/")) env.PATH = `${path.dirname(cliPath)}:${env.PATH || ""}`;
  return env;
}

/**
 * @param engine "claude" | "cursor"
 * @param system  combined system prompt (all active lenses)
 * @param prompt  user prompt — already references the screenshot's absolute path
 * @param cwd     working dir for the spawned CLI (the screenshot's temp dir)
 */
export async function runCliVlmPass({ engine, system, prompt, cwd }) {
  const cfg = config();

  if (engine === "cursor") {
    const cli = cfg.cursorCliPath;
    const args = [
      "-p",
      `${system}\n\n${prompt}`,
      "--model",
      cfg.cursorModel,
      "--output-format",
      "text",
      "--mode",
      "ask", // read-only Q&A mode — no edits/shell, just look and answer
      "--trust",
    ];
    return spawnCli(cli, args, { cwd, env: baseEnv(cli), timeoutMs: CLI_VLM_TIMEOUT_MS });
  }

  const cli = cfg.claudeCliPath;
  const args = [
    "-p",
    prompt,
    "--append-system-prompt",
    system,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read", // read-only — only needs to look at the screenshot
    "--output-format",
    "text",
  ];
  return spawnCli(cli, args, { cwd, env: baseEnv(cli), timeoutMs: CLI_VLM_TIMEOUT_MS });
}
