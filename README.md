# QA Slack Auto-fix Bot

A Socket-Mode Slack bot for QA channels that turns CI failure noise into
actionable, AI-analyzed threads:

- **Failing Cypress reports** → threads a **🧠 AI Analyse Failures** button →
  modal with per-spec **root-cause triage** (`🔧 test-code fix` / `🐞 possible
  product bug` / `🌐 environment`) → pick a spec → **auto-fix** it via the QA
  portal (AI repair → independent Cypress verification → draft PR), with live
  progress threaded back.
- **Crashed Jenkins builds** (no report exists) → threads a **🧠 AI Analyse
  Crash** button → fetches the build's **console log**, AI infers what the run
  was executing when it died and why → **posts the RCA into the thread** for
  the team — including a direct answer if the crash message asked a question
  (e.g. *"do we need to split the job?"*).

```
 CI reporter message           Jenkins Crash Monitor message
 (Total/Passed/Failed)         (job + build + timeout)
        │ scan / watcher              │ scan / watcher
        ▼                             ▼
 [🧠 AI Analyse Failures]      [🧠 AI Analyse Crash]
        │ click                       │ click
        ▼                             ▼
 modal: per-spec root causes   RCA from console log
 → pick spec → auto-fix        → posted in-thread (team-visible)
 → draft PR link in thread
```

## Requirements — who can use this

> **Disclaimer:** this bot is useful only if your team already has ALL of the
> following. Without any one of them, the flow cannot work end-to-end:
>
> 1. **A Slack workspace** where you can create an app (or get one approved).
> 2. **GitHub** hosting your test-specs repo, plus a token with write access
>    to it (draft PRs are opened there).
> 3. **A Claude Code subscription** — the `claude` CLI must be installed and
>    logged in on the machine running the bot/portal; it powers the failure
>    analysis, crash RCA, and the fixes themselves. No API key is used.
> 4. **CI/CD that posts test reports into the Slack channel** (scheduled
>    Jenkins/GitHub Actions/GitLab runs) — see the prerequisite section below
>    for the exact message format.
> 5. The **[AutoHeal portal](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal)**
>    running somewhere reachable — the bot delegates the actual fixing to it.
>    (Analysis-only use works without it.)
> 6. **macOS** for the runtime Chrome-session reader; on Linux/Windows set
>    `QUALITY_COOKIE` manually.
>
> Maturity: a working internal tool, proven end-to-end on real CI failures —
> but shipped as-is, without warranty; review the safety model and test on a
> scratch channel/repo before adopting.

## How it connects

| Dependency | How |
|---|---|
| **QA portal** (the fix engine) | plain HTTP — `POST $PORTAL_URL/api/heal`; run the [portal](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal) separately |
| **Quality dashboard** (report data) | operator's own Chrome session, read at runtime (macOS Keychain) — no pasted cookies |
| **Jenkins** (console logs) | same runtime Chrome-session mechanism |
| **AI analysis** | local `claude` CLI (subscription login, no API key); model via `AUTOFIX_ANALYSIS_MODEL` (default `claude-fable-5`) |
| **Slack** | Socket Mode (no public URL — runs behind VPN); app created from `slack-autofix-manifest.json` |

## Setup — what YOU provide after cloning

```bash
npm install
cp .env.example .env        # ← every input below goes in this file
npm start                   # long-lived bot process
```

**Step 1 — create your Slack app** (one time): api.slack.com/apps → *Create New
App → From an app manifest* → paste `slack-autofix-manifest.json` → install to
your workspace. This gives you the two Slack tokens below.

**Step 2 — fill `.env`.** These are ALL the inputs; nothing is hardcoded:

| Input | Example | What it controls |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` | the bot identity (from OAuth & Permissions) |
| `SLACK_APP_TOKEN` | `xapp-…` | Socket Mode connection (App-Level Token, `connections:write`) |
| `SLACK_USER_TOKEN` *(optional)* | `xoxp-…` | lets `scan` read channel history **without inviting the bot** |
| `SLACK_AUTOFIX_CHANNEL` | `#your-ci-channel` | **your channel** — where CI reports land and buttons are threaded |
| `AUTOFIX_REPO` | `your-org/your-specs-repo` | **your specs repo** — where draft PRs are opened |
| `AUTOFIX_BRANCH` | `master` | base branch for fixes (blank = repo default) |
| `AUTOFIX_FRAMEWORK` | `cypress` or `playwright` | **your test framework** — drives fix prompts + the verification runner |
| `AUTOFIX_SPEC_FILTER` *(optional)* | `hotel` | narrows the fallback spec picker to your product's paths |
| `AUTOFIX_ANALYSIS_MODEL` *(optional)* | `claude-fable-5` | model for the triage analysis |
| `PORTAL_URL` | `http://127.0.0.1:8080` | where the [AutoHeal portal](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal) runs |
| `GITHUB_TOKEN` | `ghp_…` | read the specs repo tree (fallback picker) |
| `CLAUDE_CLI_PATH` | `/usr/local/bin/claude` | your locally installed + logged-in Claude Code CLI |
| `QUALITY_URL` | `https://your-quality-dashboard` | report source; leave `QUALITY_COOKIE` blank to read your Chrome session live (macOS) |
| `AUTOFIX_CHANNEL_CONFIG` *(optional)* | see below | per-channel repo/branch/framework map |
| `SCAN_INTERVAL_MINUTES` *(optional)* | `5` | auto-scan: sweep the channel(s) every N minutes and thread buttons under new failing/crashed messages — no channel invite needed (`0` = off) |
| `REPORT_LINK_HINT` *(optional)* | `report` | substring to pick the report link when a CI message contains several URLs |

**Step 3 — run it**: `npm start`, then `node slack-autofix-bot.mjs scan` to
thread buttons under the latest failing reports in your channel.

### Prerequisite — your CI must post test reports into the channel

The bot doesn't run tests on a schedule itself; it **reacts to CI report
messages** already landing in your Slack channel. If your channel is empty, set
this up first — it's what makes the whole flow work:

**1. A scheduled CI job runs your suite** (Jenkins pipeline, GitHub Actions
cron, GitLab schedule — anything), e.g. nightly or per release-candidate.

**2. After the run, the job posts a summary to the channel** (Slack incoming
webhook or a reporter plugin). The bot detects a report message when it has:

| Required | Example |
|---|---|
| The words `Sanity Report` or `Monitoring Report` (or the posting app is named `Cypress Test Reporter`) | `Sanity Report \| desktopWeb \| Hotels \| v2.205.3-RC.0` |
| A failed count in the form `Failed: N` | `✖️ Failed: 15` |
| *(Recommended)* a **Report link** to your quality dashboard: `…/public/insights/<category>/<24-hex-id>` | `<https://quality.example.com/public/insights/cypress/6a51…c0b6\|Report>` |

With the Report link, the modal shows real per-spec failures + AI root causes
(the bot fetches the report JSON — mochawesome-style `results[].tests[]` with
`state` and `err.message`). Without it, the bot falls back to a plain spec
picker from the GitHub tree — it works, but you lose the error-driven triage.

Example CI step (after the test run, using an incoming webhook):

```bash
# counts from mochawesome merged JSON (adapt to your reporter)
TOTAL=$(jq .stats.tests report.json); PASS=$(jq .stats.passes report.json)
FAIL=$(jq .stats.failures report.json); SKIP=$(jq .stats.pending report.json)
curl -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d @- <<EOF
{"text":"🚀 Sanity Report | desktopWeb | Hotels | $BUILD_TAG | <https://quality.example.com/public/insights/cypress/$REPORT_ID|Report>\n\n\`\`\`🧪 Total: $TOTAL   ✔️ Passed: $PASS   ✖️ Failed: $FAIL   ⏳ Pending/Skipped: $SKIP\`\`\`"}
EOF
```

**3. (Optional) crashed-build alerts** — the bot also reacts to Jenkins crash
messages containing the words `Jenkins Crash` plus a build URL
(`https://<jenkins>/job/…/job/<name>/<build>/`). An `Action:` line with a
question gets answered directly in the AI's RCA reply:

```
Jenkins Crash: Nightly/Hotels/destination-types #276 - EXECUTION_TIMEOUT
Job: <https://jenkins.example.com/job/Nightly/job/Hotels/job/destination-types/276/>
Action: 👥 Hotel Team: @lead - DO WE NEED TO SPLIT THE JOB?
```

Once these messages flow, `scan` (or the auto-watcher, if the bot is invited)
threads the analyse buttons under them — and everything else follows.

### Any reporting tool (not just the quality dashboard)

The Report link in the CI message can point at **any report**, and the bot
parses it in tiers:

1. **Quality-dashboard links** (`…/public/insights/<category>/<id>`) — native
   JSON API, fastest.
2. **Known JSON formats** — mochawesome merged JSON and Playwright's
   `--reporter=json` output are parsed natively.
3. **Anything else — HTML reports, custom JSON, plain text** — the AI reads the
   fetched content and extracts the failed tests (spec, test name, error).
   Slower on first click (cached afterwards), but it means Allure/mochawesome
   HTML/home-grown reports all work without code changes.

Access uses the operator's Chrome session first and falls back to anonymous
fetch for public report URLs. If a message contains several links, set
`REPORT_LINK_HINT` (a substring, e.g. `report`) to pick the right one. Note:
auto-fix needs spec *file paths* — if a report format doesn't include them,
you still get the failure analysis, just not the one-click fix.

### Cypress AND Playwright

Set `AUTOFIX_FRAMEWORK=cypress` or `playwright` (globally, or per channel in
the map below). It changes: the fix instructions the AI receives (run commands,
config files, wait conventions) and the **independent verification runner**
(`npx cypress run --spec …` vs `npx playwright test …`) the portal uses before
opening a PR. Spec detection covers both naming styles
(`*.cy.*` / `*.spec.*` / `*.test.*`).

### Multi-team / multi-channel use

Everything a team changes lives in `.env` — no code edits:

- `SLACK_AUTOFIX_CHANNEL`, `AUTOFIX_REPO`, `AUTOFIX_BRANCH`, `AUTOFIX_SPEC_FILTER`
  set the default channel and the specs repo PRs are opened against.
- `AUTOFIX_CHANNEL_CONFIG` (JSON) maps **each channel to its own repo/branch/
  filter**, so one bot instance can serve e.g. hotels, flights and transport
  channels, healing into different repos:

  ```
  AUTOFIX_CHANNEL_CONFIG={"#hotel-cypress-logs":{"repo":"org/hotel-specs","filter":"hotel"},"#web-playwright-logs":{"repo":"org/web-pw-specs","framework":"playwright"}}
  ```

- `scan` accepts a channel too: `node slack-autofix-bot.mjs scan 2 "#flights-cypress-logs"`.
- There are no hardcoded org defaults in the code — with nothing configured the
  bot fails fast with a clear message instead of pointing at someone else's repo.

## Commands

```bash
node slack-autofix-bot.mjs                  # run the bot (long-lived)
node slack-autofix-bot.mjs scan [N] [#chan] # thread buttons under the last N failing/crashed messages (channel optional)
node slack-autofix-bot.mjs warm <reportId>… # pre-run AI triage for report id(s) — makes modals instant
node slack-autofix-bot.mjs crash-rca <ts>   # analyze a crash message by ts and post the RCA in-thread
node slack-autofix-bot.mjs post <spec> [name]  # manual one-off failed-test card
```

## Behavior details

- **Analysis cache** (`.analysis-cache.json`, gitignored): one AI pass per
  report/build, shared between the bot and the `scan`/`warm` CLI processes;
  `scan` pre-warms so modals open instantly.
- **Loading states** (both buttons — failures and crash): uncached clicks show
  an in-modal "Analyzing…" view and swap the thread button for an
  *"AI analysis in progress…"* notice, so nobody can start a duplicate run;
  the button is restored on every exit path, and racing clicks share a single
  analysis (the crash RCA can never double-post).
- **Report picker** shows only the specs that actually failed (spec file names,
  root cause as the subtitle; full paths in the triage list).
- **Crash RCAs post once per build** — repeat clicks reuse the cached analysis.
- **New messages are picked up automatically** two ways: the live watcher
  (instant, but requires the bot to be invited to the channel) or the
  **scheduled auto-scan** — set `SCAN_INTERVAL_MINUTES=5` and the bot sweeps
  the channel(s) every N minutes via the user token, no invite needed. It
  covers the default channel plus every channel in `AUTOFIX_CHANNEL_CONFIG`,
  and never double-threads (existing replies are detected).

## Safety

- The bot never fixes anything on its own: analysis is read-only; a fix starts
  only from an explicit human selection + confirm.
- Fixes are delegated to the portal, which independently verifies with a real
  Cypress rerun and opens **draft PRs** only; product bugs are reported, never
  forced green.
- No secrets in the repo: tokens live in `.env` (gitignored); dashboard and
  Jenkins access borrow the operator's live browser session at runtime.
- macOS-specific: the runtime Chrome-cookie reader uses the macOS Keychain
  (first use shows an approval dialog). On Linux, set `QUALITY_COOKIE`.
