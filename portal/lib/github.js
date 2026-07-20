/**
 * Clone a repository branch and scan it for Cypress test specs.
 *
 * Uses the system `git` binary (shallow clone) rather than a JS git library —
 * fewer deps, and the host already has git. A GITHUB_TOKEN, if present, is
 * injected into the clone URL for private repos and is never written to logs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/** Parse owner/repo out of a GitHub URL or "owner/repo" shorthand. */
export function parseRepo(input) {
  const s = (input || "").trim();
  // owner/repo shorthand
  let m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (m && !s.includes("://") && !s.includes("github.com")) {
    return { owner: m[1], repo: m[2] };
  }
  m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(s);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function cloneUrl(owner, repo) {
  const token = config().githubToken;
  if (token) {
    // x-access-token works for both classic and fine-grained PATs
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

function redact(text) {
  const token = config().githubToken;
  return token ? text.replaceAll(token, "***") : text;
}

function run(cmd, args, opts = {}) {
  const { timeoutMs, onChild, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOpts });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${cmd} ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`${cmd} ${args[0]} exited ${code}: ${redact(stderr).slice(0, 800)}`)
        );
    });
  });
}

/**
 * Install the cloned repo's own dependencies so its Cypress plugins / custom
 * commands resolve. Uses `npm ci` when a lockfile is present, else `npm install`.
 * Best-effort with a generous timeout — a failure is thrown for the caller to log.
 */
export async function installDeps(projectDir, onLog, onChild) {
  let hasLock = false;
  try {
    await fs.access(path.join(projectDir, "package-lock.json"));
    hasLock = true;
  } catch {
    /* no lockfile */
  }
  const sub = hasLock ? "ci" : "install";
  onLog?.(`Installing repo dependencies (npm ${sub}) — this can take several minutes…`);
  await run("npm", [sub, "--no-audit", "--no-fund", "--prefer-offline"], {
    cwd: projectDir,
    timeoutMs: Number(process.env.NPM_INSTALL_TIMEOUT_MS || 600000),
    env: { ...process.env, CYPRESS_INSTALL_BINARY: "0", HUSKY: "0" },
    onChild,
  });
  onLog?.("Repo dependencies installed.");
}

/**
 * Shallow-clone `branch` of owner/repo into a fresh job-scoped directory.
 * Returns the absolute path to the working tree.
 */
export async function cloneRepo({ owner, repo, branch, jobId, dirName, onLog, onChild }) {
  const dir = path.join(config().workspaceDir, jobId, dirName || `${owner}__${repo}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });

  const args = ["clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  args.push(cloneUrl(owner, repo), dir);

  onLog?.(`Cloning ${owner}/${repo}${branch ? `@${branch}` : ""} (shallow)…`);
  await run("git", args, { onChild });
  onLog?.("Clone complete.");
  return dir;
}

/** Resolve a repo's default branch (used as the PR base when none was given). */
export async function getDefaultBranch(owner, repo) {
  const token = config().githubToken;
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} reading ${owner}/${repo}`);
  const data = await res.json();
  return data.default_branch || "main";
}

/**
 * Open a pull request via the GitHub API. Requires a GITHUB_TOKEN with write /
 * pull-request scope (the read-only clone token is not enough). Returns
 * { url, number }.
 */
export async function openPullRequest({ owner, repo, head, base, title, body, draft = false }) {
  const token = config().githubToken;
  if (!token)
    throw new Error(
      "GITHUB_TOKEN with pull-request (write) scope is required to open a PR. Set it in .env.local."
    );
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, head, base, body, draft }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.errors?.map((e) => e.message).join("; ") || data?.message || "unknown error";
    throw new Error(`GitHub API ${res.status} opening PR: ${detail}`);
  }
  return { url: data.html_url, number: data.number, draft: Boolean(data.draft) };
}

/** Parse a GitHub PR URL → { owner, repo, number }. */
export function parsePrUrl(input) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec((input || "").trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Resolve a PR URL to its head branch + repo via the GitHub API.
 * Returns { repoUrl, branch, number }.
 */
export async function resolvePr(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw new Error(`Not a GitHub PR link: ${prUrl}`);
  const token = config().githubToken;
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} resolving PR #${pr.number}`);
  }
  const data = await res.json();
  const branch = data?.head?.ref;
  if (!branch) throw new Error("Could not read the PR's head branch.");
  return { repoUrl: `${pr.owner}/${pr.repo}`, branch, number: pr.number };
}

const SPEC_RE = /\.(cy|spec|test)\.(js|jsx|ts|tsx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);

/**
 * Walk the cloned tree and return Cypress spec files as POSIX-style relative
 * paths. Prefers conventional Cypress locations but matches any *.cy.* /
 * *.spec.* / *.test.* file so it works across repo layouts.
 */
export async function scanSpecs(rootDir) {
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile() && SPEC_RE.test(e.name)) {
        const rel = path.relative(rootDir, path.join(dir, e.name));
        found.push(rel.split(path.sep).join("/"));
      }
    }
  }

  await walk(rootDir);
  found.sort();
  return found;
}

// Appended to the cloned repo's Cypress support file so every test emits an
// APP-ONLY screenshot (capture:'viewport' excludes Cypress's command-log panel).
// Stacks as an extra afterEach — it doesn't replace the repo's own hooks.
const APP_SHOT_SNIPPET = `

// === VLM Test Hub: app-only screenshots for AI review (auto-added) ===
afterEach(function () {
  try {
    const title = (Cypress.currentTest && Cypress.currentTest.title) || 'screen';
    const name = 'vlm__' + String(title).replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
    cy.screenshot(name, { capture: 'viewport', overwrite: true });
  } catch (e) { /* never let the screenshot hook fail a test */ }
});
`;

const SUPPORT_CANDIDATES = [
  "cypress/support/e2e.js",
  "cypress/support/e2e.ts",
  "cypress/support/e2e.jsx",
  "cypress/support/e2e.tsx",
  "cypress/support/index.js",
  "cypress/support/index.ts",
];

/**
 * Append an app-only screenshot hook to the repo's Cypress support file so the
 * VLM reviews the real page, not Cypress's runner chrome. Returns true if a
 * support file was found and patched.
 */
export async function injectAppScreenshots(projectDir, onLog) {
  for (const rel of SUPPORT_CANDIDATES) {
    const full = path.join(projectDir, rel);
    try {
      await fs.access(full);
    } catch {
      continue;
    }
    await fs.appendFile(full, APP_SHOT_SNIPPET);
    onLog?.(`Injected app-only screenshot hook into ${rel}.`);
    return true;
  }
  onLog?.(
    "No Cypress support file found — keeping default (runner) failure screenshots."
  );
  return false;
}

/**
 * Build a platform → product → funnel-spec tree directly from the repo's spec
 * paths. Keys off the conventional layout `cypress/e2e/<platform>/funnels/<product>/...`.
 *
 * Returns:
 *   {
 *     platforms: ["desktop","pwa",...],            // sorted, only those with funnels
 *     tree: { desktop: { flights: [specs...] } },   // specs are repo-relative paths
 *   }
 */
export function buildFunnelTree(specs) {
  const tree = {};
  for (const rel of specs) {
    const parts = rel.split("/");
    const fi = parts.indexOf("funnels");
    // need .../<platform>/funnels/<product>/<file>
    if (fi < 1 || fi + 2 > parts.length - 1) continue;
    const platform = parts[fi - 1];
    const product = parts[fi + 1];
    if (!platform || !product) continue;
    (tree[platform] ??= {});
    (tree[platform][product] ??= []).push(rel);
  }
  for (const platform of Object.keys(tree)) {
    for (const product of Object.keys(tree[platform])) {
      tree[platform][product].sort();
    }
  }
  return { platforms: Object.keys(tree).sort(), tree };
}

/** Filter discovered specs by a product's glob-ish path fragments. */
export function filterSpecs(specs, globs) {
  if (!globs || globs.length === 0) return specs;
  // Treat each glob loosely: strip ** and * and match as a substring fragment.
  const fragments = globs.map((g) =>
    g.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/+/g, "/").toLowerCase()
  );
  return specs.filter((s) => {
    const low = s.toLowerCase();
    return fragments.some((f) => f && low.includes(f.replace(/\/$/, "")));
  });
}
