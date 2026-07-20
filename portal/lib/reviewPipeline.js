/**
 * PR review pipeline: resolve the PR, pull its metadata + unified diff from
 * the GitHub API, clone the HEAD branch (so the reviewer can grep real repo
 * context), then drive the local AI CLI to produce a DRAFT review. Nothing is
 * ever posted to GitHub — the human copies the draft, edits, and posts it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { emit, trackChild } from "./jobs.js";
import { parsePrUrl, cloneRepo } from "./github.js";
import {
  buildReviewPrompt,
  runClaudeReview,
  runCursorReview,
  parseReviewOutput,
} from "./prReview.js";
import { claudeConfigDirFor, config } from "./config.js";

// The diff is written to a file the agent Reads selectively, so a generous cap
// is fine — this only guards against pathological multi-MB vendored-code PRs.
const MAX_DIFF_BYTES = Number(process.env.REVIEW_MAX_DIFF_BYTES || 800_000);

function ghHeaders(accept) {
  const headers = { Accept: accept || "application/vnd.github+json" };
  const token = config().githubToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch PR metadata + the full unified diff. */
export async function fetchPrData({ owner, repo, number }) {
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;

  const metaRes = await fetch(base, { headers: ghHeaders() });
  if (!metaRes.ok) throw new Error(`GitHub API ${metaRes.status} fetching PR #${number}`);
  const meta = await metaRes.json();

  const diffRes = await fetch(base, { headers: ghHeaders("application/vnd.github.v3.diff") });
  if (!diffRes.ok) throw new Error(`GitHub API ${diffRes.status} fetching PR #${number} diff`);
  let diff = await diffRes.text();
  let diffTruncated = false;
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES);
    diffTruncated = true;
  }

  return {
    pr: {
      number,
      title: meta.title || "",
      body: meta.body || "",
      author: meta.user?.login || "",
      baseRef: meta.base?.ref || "",
      headRef: meta.head?.ref || "",
      changedFiles: meta.changed_files ?? 0,
      additions: meta.additions ?? 0,
      deletions: meta.deletions ?? 0,
      url: meta.html_url || "",
      state: meta.state || "",
    },
    diff,
    diffTruncated,
  };
}

/** How far the branch has drifted from base ("the ground moved"). Best-effort. */
export async function fetchCompare({ owner, repo, baseRef, headRef }) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(
        baseRef
      )}...${encodeURIComponent(headRef)}`,
      { headers: ghHeaders() }
    );
    if (!res.ok) return null;
    const d = await res.json();
    return { aheadBy: d.ahead_by ?? 0, behindBy: d.behind_by ?? 0 };
  } catch {
    return null;
  }
}

/** Paths touched by this PR (for the cross-PR overlap scan). Best-effort, first 300. */
async function fetchPrFiles({ owner, repo, number }) {
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      { headers: ghHeaders() }
    );
    if (!res.ok) break;
    const batch = await res.json();
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  return files;
}

async function fetchPrFilesSafe({ owner, repo, number }) {
  try {
    return await fetchPrFiles({ owner, repo, number });
  } catch {
    return [];
  }
}

// Commit messages that look like a deliberate removal/retirement — the lens-8
// signal that a path this PR re-adds was dropped on purpose.
export const REVERSAL_RE = /\b(remov\w*|retir\w*|deprecat\w*|revert\w*|delet\w*|drop\w*)\b/i;

/**
 * Base-branch commit history for each path the PR touches (lens 8 evidence).
 * The reviewer CLI is read-only with no git — and the clone is shallow anyway —
 * so "was this deliberately removed before?" has to be answered here via the
 * GitHub API and handed over as a file. Best-effort; capped to bound API calls.
 */
export async function fetchPathHistories({ owner, repo, baseRef, files }) {
  const out = [];
  for (const file of (files || []).slice(0, 30)) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(
          file
        )}&sha=${encodeURIComponent(baseRef)}&per_page=10`,
        { headers: ghHeaders() }
      );
      if (!res.ok) continue;
      const commits = await res.json();
      if (!Array.isArray(commits) || !commits.length) continue;
      out.push({
        file,
        commits: commits.map((c) => ({
          sha: (c.sha || "").slice(0, 7),
          date: c.commit?.author?.date?.slice(0, 10) || "",
          message: (c.commit?.message || "").split("\n")[0].slice(0, 120),
        })),
      });
    } catch {
      /* best-effort */
    }
  }
  return out;
}

/**
 * Existing discussion on the PR (conversation comments, submitted reviews and
 * their inline comments) so the reviewer never re-raises a settled point and
 * can do a delta-only re-review. Best-effort — failures return empty lists.
 */
export async function fetchPrDiscussion({ owner, repo, number }) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  async function list(url) {
    try {
      const res = await fetch(url, { headers: ghHeaders() });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }
  const [issueComments, reviews, reviewComments] = await Promise.all([
    list(`${base}/issues/${number}/comments?per_page=50`),
    list(`${base}/pulls/${number}/reviews?per_page=50`),
    list(`${base}/pulls/${number}/comments?per_page=100`),
  ]);
  const clip = (s) => String(s || "").trim().slice(0, 3000);
  return {
    issueComments: issueComments.map((c) => ({ user: c.user?.login, body: clip(c.body) })),
    reviews: reviews
      .filter((r) => (r.body || "").trim() || r.state !== "COMMENTED")
      .map((r) => ({ user: r.user?.login, state: r.state, body: clip(r.body) })),
    reviewComments: reviewComments.map((c) => ({
      user: c.user?.login,
      path: c.path,
      body: clip(c.body),
    })),
  };
}

/**
 * Which OTHER open PRs touch the same files? Scans the ~20 most recently
 * updated open PRs (1 API call each). Best-effort — an API hiccup returns [].
 */
export async function findOverlappingPrs({ owner, repo, number, ownFiles }) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=20`,
      { headers: ghHeaders() }
    );
    if (!res.ok) return [];
    const open = (await res.json()).filter((p) => p.number !== number);
    const own = new Set(ownFiles);
    const overlaps = [];
    for (const p of open) {
      const files = await fetchPrFiles({ owner, repo, number: p.number });
      const shared = files.filter((f) => own.has(f));
      if (shared.length) {
        overlaps.push({
          number: p.number,
          title: p.title || "",
          author: p.user?.login || "",
          sharedFiles: shared.slice(0, 10),
        });
      }
    }
    return overlaps;
  } catch {
    return [];
  }
}

/** Write the PR brief + diff where the reviewer can Read them (job dir, OUTSIDE the clone). */
async function writeReviewFiles({ jobId, pr, diff, diffTruncated, compare, overlaps, discussion, histories }) {
  const dir = path.join(config().workspaceDir, jobId);
  await fs.mkdir(dir, { recursive: true });

  const briefPath = path.join(dir, "PR_BRIEF.md");
  const diffPath = path.join(dir, "PR_DIFF.patch");
  const discussionPath = path.join(dir, "PR_DISCUSSION.md");
  const historyPath = path.join(dir, "PR_HISTORY.md");

  const staleLine = compare
    ? `- Branch drift: ${compare.aheadBy} commit(s) ahead of ${pr.baseRef}, **${compare.behindBy} behind** — ${
        compare.behindBy > 50
          ? "the ground has likely moved under this branch; check the base tree for prior art / moved files (lens 7)"
          : "reasonably fresh"
      }`
    : "";

  const overlapBlock = overlaps?.length
    ? `\n## Other OPEN PRs touching the same files (rebase-order / conflict risk — lens 7)\n\n${overlaps
        .map(
          (o) =>
            `- #${o.number} "${o.title}" by @${o.author} — shares: ${o.sharedFiles.join(", ")}`
        )
        .join("\n")}\n`
    : "";

  const brief = `# PR #${pr.number}: ${pr.title}

- Author: @${pr.author}
- Branch: ${pr.headRef} → ${pr.baseRef}
- Files changed: ${pr.changedFiles} (+${pr.additions}/−${pr.deletions})
${staleLine ? staleLine + "\n" : ""}- URL: ${pr.url}
${overlapBlock}
## Description (verbatim from the author — cross-check every claim against the diff)

${pr.body || "(the PR has NO description — flag this and reconstruct the intent from the diff)"}
`;

  await fs.writeFile(briefPath, brief, "utf8");
  await fs.writeFile(
    diffPath,
    diffTruncated
      ? `${diff}\n\n<<< DIFF TRUNCATED at ${MAX_DIFF_BYTES} bytes — the clone still holds the full HEAD state >>>\n`
      : diff,
    "utf8"
  );

  // Prior discussion → its own file (only when there is any), so the reviewer
  // can honor the "never re-raise a settled point / delta-only re-review" rule.
  const hasDiscussion =
    discussion &&
    (discussion.issueComments.length || discussion.reviews.length || discussion.reviewComments.length);
  if (hasDiscussion) {
    const md = [
      `# Existing discussion on PR #${pr.number} (do NOT re-raise settled points)`,
      ...discussion.reviews.map((r) => `\n## Review by @${r.user} — ${r.state}\n\n${r.body || "(no body)"}`),
      ...discussion.issueComments.map((c) => `\n## Comment by @${c.user}\n\n${c.body}`),
      ...(discussion.reviewComments.length
        ? [
            "\n## Inline review comments\n",
            ...discussion.reviewComments.map((c) => `- @${c.user} on \`${c.path}\`: ${c.body}`),
          ]
        : []),
    ].join("\n");
    await fs.writeFile(discussionPath, md, "utf8");
  }

  // Base-branch history of the PR's paths → lens 8 (deliberate reversals).
  if (histories?.length) {
    const md = [
      `# Base-branch (${pr.baseRef}) history of the paths this PR touches`,
      ``,
      `Lens 8 evidence. A ⚠-marked commit that previously removed/retired one of these paths`,
      `means this PR may re-introduce something dropped on purpose — find that commit's`,
      `rationale (ticket, decision doc) before accepting the addition.`,
      ...histories.map((h) => {
        const lines = h.commits.map((c) => {
          const mark = REVERSAL_RE.test(c.message) ? " ⚠ possible removal/retirement" : "";
          return `- ${c.sha} ${c.date}: ${c.message}${mark}`;
        });
        return `\n## ${h.file}\n\n${lines.join("\n")}`;
      }),
    ].join("\n");
    await fs.writeFile(historyPath, md, "utf8");
  }

  return {
    briefPath,
    diffPath,
    discussionPath: hasDiscussion ? discussionPath : "",
    historyPath: histories?.length ? historyPath : "",
  };
}

export async function runReviewPipeline(job) {
  const log = (m) => emit(job, m);
  const onChild = (c) => trackChild(job, c);
  job.status = "running";

  try {
    const { prUrl, extraPrompt, account, cliType } = job.input;
    const parsed = parsePrUrl(prUrl);
    if (!parsed) throw new Error(`Not a GitHub PR link: ${prUrl}`);

    log(`Fetching PR #${parsed.number} metadata + diff from GitHub…`);
    const { pr, diff, diffTruncated } = await fetchPrData(parsed);
    job.pr = pr;
    log(
      `PR #${pr.number} "${pr.title}" by @${pr.author} — ${pr.headRef} → ${pr.baseRef}, ` +
        `${pr.changedFiles} file(s), +${pr.additions}/−${pr.deletions}.`
    );
    if (diffTruncated) log(`⚠ Diff exceeds ${MAX_DIFF_BYTES} bytes — truncated copy for the reviewer.`);
    if (!pr.body) log(`⚠ PR has no description — the reviewer will flag it and infer intent from the diff.`);

    // Ground-moved facts: how stale is the branch, and which other open PRs
    // collide with it? Both best-effort — a failure never blocks the review.
    log("Checking branch drift, prior discussion, and overlapping open PRs…");
    const [compare, ownFiles, discussion] = await Promise.all([
      fetchCompare({ owner: parsed.owner, repo: parsed.repo, baseRef: pr.baseRef, headRef: pr.headRef }),
      fetchPrFilesSafe(parsed),
      fetchPrDiscussion(parsed),
    ]);
    const discussionCount =
      discussion.issueComments.length + discussion.reviews.length + discussion.reviewComments.length;
    if (discussionCount) log(`PR already has ${discussionCount} comment(s)/review(s) — reviewer will avoid re-raising them.`);
    if (compare) log(`Branch is ${compare.aheadBy} ahead / ${compare.behindBy} behind ${pr.baseRef}.`);
    const overlaps = await findOverlappingPrs({
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      ownFiles,
    });
    if (overlaps.length)
      log(`⚠ ${overlaps.length} other open PR(s) touch the same files: ${overlaps.map((o) => `#${o.number}`).join(", ")}.`);

    // Lens-8 evidence: did a base-branch commit deliberately remove what this
    // PR (re-)adds? The read-only reviewer can't run git, so fetch it here.
    const histories = await fetchPathHistories({
      owner: parsed.owner,
      repo: parsed.repo,
      baseRef: pr.baseRef,
      files: ownFiles,
    });
    const reversals = histories.filter((h) => h.commits.some((c) => REVERSAL_RE.test(c.message)));
    if (reversals.length)
      log(
        `⚠ ${reversals.length} touched path(s) have removal/retirement commits in ${pr.baseRef} history — possible deliberate-reversal (lens 8).`
      );

    const { briefPath, diffPath, discussionPath, historyPath } = await writeReviewFiles({
      jobId: job.id,
      pr,
      diff,
      diffTruncated,
      compare,
      overlaps,
      discussion,
      histories,
    });

    // Clone the HEAD branch so the reviewer greps real repo context (placement,
    // prior art, references to touched paths) — not just the diff text.
    const dir = await cloneRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch: pr.headRef,
      jobId: job.id,
      onLog: log,
      onChild,
    });
    job.projectDir = dir;

    // Also clone the CURRENT BASE branch — this is what lets the reviewer see
    // "the ground moved": prior art that landed after the branch was cut,
    // parallel trees for the same concern, contradicting rules on base.
    let basePath = "";
    try {
      basePath = await cloneRepo({
        owner: parsed.owner,
        repo: parsed.repo,
        branch: pr.baseRef,
        jobId: job.id,
        dirName: `${parsed.owner}__${parsed.repo}__base`,
        onLog: log,
        onChild,
      });
    } catch (e) {
      log(`⚠ Could not clone base branch ${pr.baseRef} (${e.message}) — reviewing without base-tree comparison.`);
    }

    if (job._stopped) throw new Error("stopped");

    const useCursor = cliType === "cursor";
    const cliLabel = useCursor ? `Cursor CLI (${config().cursorModel})` : "Claude Code";
    job.cliUsed = useCursor ? cliLabel : `Claude Code${account ? ` (${account})` : ""}`;

    let configDir = "";
    if (!useCursor) {
      configDir = claudeConfigDirFor(account);
      if (account) {
        log(
          configDir
            ? `Using the "${account}" Claude account for this review.`
            : `Requested "${account}" account, but no config dir is set — using default login.`
        );
      }
    }

    const prompt = buildReviewPrompt({ pr, briefPath, diffPath, basePath, discussionPath, historyPath, extraPrompt });
    if (extraPrompt?.trim()) log("Including operator focus notes in the review prompt.");
    log(`Invoking ${cliLabel} to review the PR (read-only). This can take several minutes…`);

    const output = useCursor
      ? await runCursorReview({ projectDir: dir, prompt, onChild })
      : await runClaudeReview({ projectDir: dir, prompt, configDir, onChild });

    const { verdict, blockers, draft } = parseReviewOutput(output);
    job.reviewVerdict = verdict;
    job.reviewBlockers = blockers;
    job.reviewDraft = draft;

    log(`Review finished — verdict: ${verdict}, ${blockers} blocking item(s). Draft ready to copy below.`);
    job.status = "done";
    return job;
  } catch (e) {
    if (job._stopped) {
      job.status = "stopped";
      emit(job, "Review stopped by user.");
      return job;
    }
    job.error = e.message;
    job.status = "error";
    emit(job, `ERROR: ${e.message}`);
    return job;
  }
}
