# CI-FailedTestScripts-AutoFix-Portal

**AI engine that heals broken CI test scripts: analyse → fix → run & verify → draft PR.**

## Where this fits in your QA workflow

Every new build deployed to staging can silently break E2E test scripts without
breaking the product itself:

- a UI uplift **renames locators** your page objects point at,
- an **API contract changes** — a payload key your intercepts/mocks still assert,
- a **navigation flow is reordered**, so steps click into the void,
- or a spec was simply **flaky** (timing/waits) and the new build tipped it over.

Then the scheduled CI run fires, the report lands with a wall of red — and a QA
engineer loses hours per spec: read the report, reproduce locally, hunt the
root cause, patch selectors/waits/mocks, rerun until green, raise a PR.

**This portal automates exactly that maintenance loop.** Point it at the failed
spec (one click from the [Slack bot](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal),
or via this UI/API) and it will:

1. **Analyse** the failure — starting from the CI report's own captured errors,
2. **Fix the test code** the way your repo's rules demand (reuse page objects,
   no fixed waits) via the local **Claude Code / Cursor CLI** (subscription
   login — no API key),
3. **Run & verify** — an independent Cypress/Playwright rerun, refixing up to
   3 times on real output,
4. **Open a draft PR** with the verified fix for human review.

And the guardrail that makes it trustworthy: if the failure is a **real product
bug** (the app broke, not the script), it says so and refuses to force the test
green — those go to the team as findings, not fake fixes.

**The payoff: test-script maintenance drops from hours per broken spec to
minutes of PR review.**

```
                 ┌──────────────────────────────────────────────────────────┐
 CI posts a      │  Slack #hotel-cypress-logs                               │
 failing report ─┼▶ 🧠 "AI Analyse Failures" button (threaded by the bot)   │
                 │     └▶ modal: per-spec ROOT-CAUSE triage (AI, cached)    │
                 │         └▶ pick a spec → Start auto-fix                  │
                 └───────────────┬──────────────────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────────────────┐
                 │  Self-heal pipeline (this portal, localhost:8080)        │
                 │  1. clone specs repo @ branch                            │
                 │  2. AI fixes the spec — starting from the CI report's    │
                 │     captured errors (no reproduction run needed)         │
                 │  3. INDEPENDENT Cypress rerun verifies the fix           │
                 │  4. still failing? → refix with real output (max 3 loops)│
                 │  5. genuine product bug? → reported, NEVER forced green  │
                 │  6. green → commit on self-heal/* branch → DRAFT PR      │
                 └───────────────┬──────────────────────────────────────────┘
                                 ▼
                 Slack thread: loop verdicts → ✅ draft PR link
                 ("verified by an independent Cypress rerun")
```

---

## Agentic architecture — the agent loop, in code

This portal is not a fixed script with an LLM call bolted on. Its core is a
genuine **agent loop** — given a *goal* ("make this failing spec pass,
honestly"), it plans, acts, observes real results, and replans until the goal
is reached or it decides the goal is the wrong one (product bug / obsolete
test). The loop lives in [`lib/healPipeline.js`](lib/healPipeline.js):

```
 Goal: POST /api/heal { repo, spec, failureContext, framework }
   │
   ▼
 ┌───────────────────────── AGENT LOOP (≤ MAX_HEAL_LOOPS) ─────────────────────────┐
 │                                                                                 │
 │  PLAN     attempt 1: heal prompt from the CI report's real captured errors      │
 │           attempt 2+: refix prompt from the pipeline's OWN verification output  │
 │              → buildHealPrompt / buildRefixPrompt (lib/selfheal.js)             │
 │  ACT      local Claude Code / Cursor CLI edits the spec in a fresh clone        │
 │              → runClaudeHeal / runCursorHeal (lib/selfheal.js)                  │
 │  OBSERVE  independent Cypress/Playwright rerun — the AI's "HEALED" claim is     │
 │           NEVER trusted on its word                                             │
 │              → runCypress / runPlaywright (lib/cypressRunner.js)                │
 │  DECIDE   verdict per attempt, recorded in job.healLoops:                       │
 │             ✅ verified green   → capture diff → draft PR → done                │
 │             ❌ still failing    → RETRY: real failure output feeds the replan   │
 │             🐞 PRODUCT_BUG      → STOP + structured bug report (never forced    │
 │                                   green)                                        │
 │             🗑 OBSOLETE_TEST    → STOP + retire/rewrite recommendation          │
 │             🛑 loops exhausted  → honest COULD_NOT_FIX, best diff kept for      │
 │                                   human review                                  │
 └─────────────────────────────────────────────────────────────────────────────────┘
   │
   ▼
 FINISH  commit on self-heal/* branch → DRAFT PR → Slack notification
            → openPullRequest (lib/github.js), notifySlackPrOpened (lib/dispatch.js)
```

| Agent capability | Where it lives |
|---|---|
| **Goal intake** | `app/api/heal/route.js` → `runHealPipeline(job)` |
| **Plan / replan** | `buildHealPrompt` (attempt 1) vs `buildRefixPrompt` fed with real verification output (attempts 2+) — [`lib/selfheal.js`](lib/selfheal.js) |
| **Act (tool use)** | git clone, Claude/Cursor CLI edit session — [`lib/github.js`](lib/github.js), [`lib/selfheal.js`](lib/selfheal.js) |
| **Observe** | independent spec rerun + result parsing — [`lib/cypressRunner.js`](lib/cypressRunner.js) |
| **Decide / classify** | `HEALED` / `PRODUCT_BUG` / `OBSOLETE_TEST` / `COULD_NOT_FIX` verdicts — [`lib/healPipeline.js`](lib/healPipeline.js) |
| **Retry loop** | `for (attempt = 1..MAX_HEAL_LOOPS)` with per-attempt verdict log (`job.healLoops`) — [`lib/healPipeline.js`](lib/healPipeline.js) |
| **Self-skepticism** | the pipeline reruns the spec itself before believing the AI — [`lib/healPipeline.js`](lib/healPipeline.js) |
| **Escalate to humans** | structured bug reports, draft-only PRs, manual approve-&-commit endpoint — `app/api/heal/[jobId]/commit` |
| **Sensing / triage half** | lives in the companion [Slack bot repo](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal) (observe → analyze → classify → human approval) |

**What makes it an agent rather than automation:** the workflow is not a fixed
if/else flowchart. Each attempt's *plan* is derived from what the previous
attempt actually *observed*; the loop can conclude the goal itself is wrong
(product bug, obsolete test) instead of forcing it; and outcomes are open-set —
the same input class can end in a PR, a bug report, a retirement
recommendation, or an honest failure.

**The harness.** The agent (the CLI reasoning session) is deliberately wrapped
in deterministic scaffolding: retry caps, `SIGKILL` timeouts on every spawned
session, independent verification, file-backed job state, and human gates on
anything irreversible. The full concern-by-concern map is in
[`docs/HARNESS.md`](docs/HARNESS.md), and
[`evaluation/agent-metrics.mjs`](evaluation/agent-metrics.mjs) measures the
agent inside it (success rate, verified ratio, retry-loop yield, honesty
outcomes — see [`evaluation/README.md`](evaluation/README.md)).

---

## Features

### 1. Slack — AI failure analysis + one-click auto-fix
> Lives in its own repo: **[CI-FailedTestScripts-AutoFix-Portal](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal)** — it drives this portal over plain HTTP (`POST /api/heal`).
- A Socket-Mode bot (no public URL; runs behind VPN) threads a
  **🧠 AI Analyse Failures** button under failing CI reports.
- Clicking opens a modal with **per-spec root-cause triage**: a short AI
  analysis of each failed spec, classified `🔧 likely test-code fix` /
  `🐞 possible product bug` / `🌐 environment issue` — so you know what's worth
  auto-fixing *before* starting anything.
- The analysis reads the **full CI report** (passed/failed/skipped) from the
  quality dashboard, filters failures for action, runs on a strong model
  (`claude-fable-5` by default, `AUTOFIX_ANALYSIS_MODEL` to override), and is
  **cached per report** (`scan` pre-warms it, so modals open instantly).
  While an uncached analysis runs, the thread button switches to an
  *"AI analysis in progress…"* state.
- Pick a spec → **Start auto-fix** → progress threads back live (loop verdicts,
  verification result, final draft-PR link).

### 2. Self-heal pipeline (the fix engine) — Cypress & Playwright
- Works with **Cypress and Playwright** specs: `POST /api/heal` takes a
  `framework` param (`cypress` default) that switches the fix instructions the
  AI receives (run commands, config files, wait conventions) **and** the
  independent verification runner (`runCypress` vs `runPlaywright`).
- Clones the specs repo and drives the local **Claude Code** (or **Cursor**) CLI
  to repair the failing spec **following the repo's own automation rules**
  (AGENTS.md/skills, page objects, custom commands, no fixed waits).
- With CI failure context provided, the AI **analyzes first, then fixes** —
  skipping the slow reproduction run.
- **Trust nothing:** after the AI reports HEALED, the pipeline reruns the spec
  itself. Green → proceed. Red → the real Cypress output goes back for a refix
  (max 3 loops), then an honest `COULD_NOT_FIX`. App unreachable → the PR is
  opened but loudly marked *unverified*.
- **No false positives:** a diagnosed `PRODUCT_BUG` stops the run — assertions
  are never weakened to force green.
- Fixes land as **draft PRs** on a fresh `self-heal/<spec>-<job>` branch;
  commit author = the human who triggered the action, never a bot identity.

### 3. PR review (draft-only, 6 lenses)
Paste a PR link → the local CLI (read-only: Read/Glob/Grep) reviews the diff
through six lenses — description-vs-diff, purpose & hidden assumptions,
architecture & placement, reference integrity/blast radius, code correctness,
and concrete per-owner verification asks. Output is a **draft** with a copy
button — **nothing is ever posted to GitHub**; a human edits and posts it.

### 4. Cypress runs + VLM visual review
Point at a repo/branch/product → specs run headless → screenshots are assessed
by a vision model (Gemini or OpenRouter, or the Claude/Cursor CLI) through
**UI/UX, Arabic/RTL and i18n lenses** → structured bug reports (severity, steps,
expected/actual, evidence screenshot). Findings can be auto-filed to **Jira**
and/or alerted to **Slack**.

### 5. Quality-dashboard integration (no pasted secrets)
Failure detail comes from the internal quality dashboard's report API using the
operator's **own Chrome session**: the cookie is read at runtime from the local
Chrome profile (macOS Keychain — one "Always Allow" on first use). If the Okta
session expires, the modal asks for a re-login; nothing breaks or degrades.

---

## Repository layout

```
app/                  Next.js UI + API routes
  api/heal/           self-heal jobs (start / poll / stop / manual commit)
  api/review/         PR-review jobs
  api/test/           Cypress + VLM runs
lib/
  healPipeline.js     THE AGENT LOOP: plan → act → observe → decide/retry → draft PR
  selfheal.js         CLI drivers (Claude/Cursor), heal prompts, git helpers
  cypressRunner.js    portal-side Cypress + Playwright execution/parsing
  github.js           clone / PR-create / default-branch helpers
  prReview.js         6-lens PR review prompt + parsing
  vlm.js, prompts.js  vision lenses + shared bug JSON schema
  dispatch.js         Jira / Slack auto-dispatch
docs/
  HARNESS.md          the deterministic scaffolding around the agent, mapped to code
evaluation/
  agent-metrics.mjs   measures the agent: success rate, verified ratio, honesty
```

## Requirements — who can use this

> **Disclaimer:** you need ALL of these for the full flow: a **GitHub** repo of
> runnable Cypress/Playwright specs + a token with write access (draft PRs); a
> **Claude Code subscription** with the CLI installed and logged in on this
> machine (no API key — it powers the fixes); network reach to the app under
> test (VPN for gated staging); and, for the Slack flow, the companion
> **[Slack bot](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal)**
> plus CI posting test reports into your channel. Shipped as-is, without
> warranty — test against a scratch repo before adopting.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in values (see table)
npm run dev                    # portal UI + API on http://localhost:8080
```

What the host machine needs:

| Piece | Needed for | Notes |
|---|---|---|
| Node ≥ 20, git | everything | |
| `claude` CLI, logged in | self-heal, PR review, AI triage | `CLAUDE_CLI_PATH`; subscription auth, no API key |
| GitHub token (write on the specs repo) | clone, push, draft PRs | `GITHUB_TOKEN` |
| Slack app from the manifest | Slack flow | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`; optional `SLACK_USER_TOKEN` lets `scan` read history without inviting the bot to the channel |
| Chrome logged into the quality dashboard | report-driven triage | runtime cookie, macOS Keychain |
| VPN | staging verification runs | |
| Gemini/OpenRouter key (optional) | VLM visual review only | |

### Key configuration (`.env.local`)

| Variable | Purpose |
|---|---|
| `CLAUDE_CLI_PATH` | absolute path to the `claude` binary (self-heal / review / triage) |
| `AUTOFIX_ANALYSIS_MODEL` | model for the pre-modal triage (default `claude-fable-5`) |
| `AUTOFIX_REPO` / `AUTOFIX_BRANCH` | specs repo + branch the Slack flow heals |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_USER_TOKEN` | Slack bot (Socket Mode) |
| `SLACK_AUTOFIX_CHANNEL` | channel with the CI reports (default `#hotel-cypress-logs`) |
| `QUALITY_URL` / `QUALITY_COOKIE` | quality dashboard; cookie blank = read live from Chrome |
| `GITHUB_TOKEN` | clone private repos + open draft PRs |
| `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` / `VLM_MODEL` | VLM visual review |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | Jira dispatch |
| `MAX_HEAL_LOOPS` | fix→verify loop cap (default 3) |
| `WORKSPACE_DIR` | where clones + artifacts live (default `.workspaces`) |

> **Never commit `.env.local`.** `.gitignore` excludes `.env*`, `.workspaces`,
> and the AI triage cache — verify with `git status` before pushing.

## Safety model

- **Draft PRs only** — a human marks ready-for-review and merges.
- **Independent verification** — the pipeline reruns the spec itself; the AI's
  own claim of success is never the last word.
- **Product bugs are surfaced, not silenced** — `PRODUCT_BUG` stops the run.
- **Human-triggered, human-attributed** — nothing heals without a click, and
  commits carry the clicker's identity.
- **Reviews are drafts** — the PR reviewer never posts to GitHub.
- **No secrets in the repo or prompts** — tokens live in env; dashboard access
  borrows the operator's live session at runtime.

## Deployment

**This is a server app, not a static site** — clones, Cypress and the CLI all
run server-side. It needs a long-lived process with a real filesystem: a laptop,
an internal VM, or the included **Docker** setup (`docker compose up -d --build`).
It cannot run on serverless hosts (Vercel/Netlify functions are read-only and
time-limited).

> **Keep it internal.** The portal holds a GitHub PAT and Jira token and has no
> built-in login beyond an optional shared password — bind it to VPN/internal
> network; add an auth proxy before any external exposure.

## Known limitations

- Single-process job store (one runner at a time) with **file-backed persistence**: job history/results survive restarts, and jobs that were mid-run are marked `interrupted` instead of vanishing. For multi-instance, swap `lib/jobs.js` for Redis/DB — the exported interface is the seam.
- The Slack **auto-watcher** (reacting to new reports without `scan`) requires
  the bot to be invited to the channel; `scan [N]` covers the gap via the user
  token.
- The runtime Chrome-cookie reader is **macOS-specific** (Keychain). On Linux,
  set `QUALITY_COOKIE` manually.
- Verification runs need network reach to the app under test (VPN for staging);
  unreachable env → PR is opened but flagged unverified.
