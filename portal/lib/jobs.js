/**
 * Job store: in-memory for live objects (child processes etc.), with a
 * file-backed snapshot so job HISTORY and results survive server restarts.
 * On boot, persisted jobs are reloaded; anything that was mid-run is marked
 * "interrupted" (the spawned processes died with the old server) instead of
 * silently 404ing to pollers.
 *
 * Still single-process by design (one runner per portal). For multi-instance,
 * swap this module for a Redis/DB implementation — the exported interface
 * (createJob/getJob/emit/serializeJob) is the seam.
 */
import fs from "node:fs";
import path from "node:path";

const PERSIST_FILE = path.resolve(
  process.cwd(),
  process.env.WORKSPACE_DIR || ".workspaces",
  "jobs-store.json"
);

function loadPersistedJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
    const m = new Map();
    for (const [id, j] of Object.entries(raw)) {
      if (j.status === "running" || j.status === "queued") {
        j.status = "interrupted";
        j.error = j.error || "server restarted while this job was running";
        (j.log ??= []).push("── server restarted; job was interrupted ──");
      }
      m.set(id, j);
    }
    return m;
  } catch {
    return new Map();
  }
}

const store = (globalThis.__qaJobs ??= loadPersistedJobs());

let counter = (globalThis.__qaJobCounter ??= { n: 0 });

// Debounced snapshot writer — cheap enough to call on every log line.
let persistTimer = null;
export function persistJobs() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      const out = {};
      for (const [id, job] of store) {
        // Plain-JSON snapshot: serialized fields + what post-restart actions
        // need (projectDir lets an approved diff still be committed), minus
        // heavy screenshot payloads.
        out[id] = { ...serializeJob(job), screenshots: {}, projectDir: job.projectDir || "" };
      }
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(out));
    } catch {
      /* persistence is best-effort — never break a run over it */
    }
  }, 500);
}

export function newJobId() {
  counter.n += 1;
  // short, human-ish id: timestamp tail + sequence
  return `${Date.now().toString(36)}${counter.n.toString(36)}`;
}

export function createJob(input) {
  const id = newJobId();
  const job = {
    id,
    status: "queued", // queued | running | done | error
    input, // { repoUrl, branch, productId, baseUrl, dispatch }
    createdAt: new Date().toISOString(),
    log: [],
    specs: [], // discovered spec files (relative paths)
    cypress: null, // summary of the cypress run
    bugs: [], // VLM findings
    screenshots: {}, // { [screenshotName]: base64 } — one copy per screen, referenced by bugs
    dispatched: [], // tickets/alerts created
    error: null,
  };
  store.set(id, job);
  persistJobs();
  return job;
}

export function getJob(id) {
  return store.get(id) || null;
}

export function emit(job, msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  job.log.push(line);
  // also surface in server logs
  console.log(`[job ${job.id}] ${msg}`);
  persistJobs(); // debounced — snapshots status/log/results to disk
}

/** Track a spawned child process on the job so a Stop request can kill it. */
export function trackChild(job, child) {
  (job._children ??= new Set()).add(child);
  child.on("close", () => job._children?.delete(child));
}

/** Kill everything the job spawned and flag it stopped (pipelines honor this). */
export function killJob(job) {
  job._stopped = true;
  for (const c of job._children || []) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  job._children?.clear();
}

/** Strip heavy fields for the polling payload. */
export function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    input: job.input,
    createdAt: job.createdAt,
    log: job.log,
    specs: job.specs,
    cypress: job.cypress,
    bugs: job.bugs,
    screenshots: job.screenshots || {},
    dispatched: job.dispatched,
    error: job.error,
    totalBugs: job.bugs.length,
    // --- self-heal fields (present only on heal jobs) ---
    mode: job.input?.mode || "qa",
    verdict: job.verdict || "",
    healSummary: job.healSummary || "",
    changedFiles: job.changedFiles || [],
    diff: job.diff || "",
    committed: Boolean(job.committed),
    hasWorkTree: Boolean(job.projectDir),
    healLoops: job.healLoops || [],
    verified: job.verified ?? null,
    bugReport: job.bugReport || null,
    obsoleteReport: job.obsoleteReport || null,
    featureChange: job.featureChange || null,
    bugReverify: job.bugReverify || null,
    reverifyingBug: Boolean(job.reverifyingBug),
    verifyNote: job.verifyNote || "",
    // --- PR fields (heal auto-PR + review jobs) ---
    pr: job.pr || null,
    prError: job.prError || "",
    reviewVerdict: job.reviewVerdict || "",
    reviewBlockers: job.reviewBlockers ?? 0,
    reviewDraft: job.reviewDraft || "",
    cliUsed: job.cliUsed || "",
  };
}
