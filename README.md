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

## How it connects

| Dependency | How |
|---|---|
| **QA portal** (the fix engine) | plain HTTP — `POST $PORTAL_URL/api/heal`; run the [portal](https://github.com/renukadevig/Agent-AutoHeal-TestScripts) separately |
| **Quality dashboard** (report data) | operator's own Chrome session, read at runtime (macOS Keychain) — no pasted cookies |
| **Jenkins** (console logs) | same runtime Chrome-session mechanism |
| **AI analysis** | local `claude` CLI (subscription login, no API key); model via `AUTOFIX_ANALYSIS_MODEL` (default `claude-fable-5`) |
| **Slack** | Socket Mode (no public URL — runs behind VPN); app created from `slack-autofix-manifest.json` |

## Setup

```bash
npm install
cp .env.example .env        # fill in (see below)
npm start                   # long-lived bot process
```

1. Create the Slack app: api.slack.com/apps → *Create New App → From an app
   manifest* → paste `slack-autofix-manifest.json` → install to workspace.
2. `.env`:
   - `SLACK_BOT_TOKEN` (xoxb-, OAuth & Permissions) + `SLACK_APP_TOKEN`
     (xapp-, App-Level Token with `connections:write`)
   - `SLACK_USER_TOKEN` (xoxp-, optional) — lets `scan` read channel history
     **without inviting the bot** to the channel
   - `SLACK_AUTOFIX_CHANNEL` — the CI-reports channel
   - `PORTAL_URL` — where the QA portal runs (default `http://127.0.0.1:8080`)
   - `AUTOFIX_REPO` / `AUTOFIX_BRANCH` — specs repo the auto-fix heals
   - `GITHUB_TOKEN` — used to list specs (fallback picker)
   - `CLAUDE_CLI_PATH` — absolute path to the `claude` binary
   - `QUALITY_URL` — quality dashboard base; leave `QUALITY_COOKIE` blank to
     read the session live from Chrome

## Commands

```bash
node slack-autofix-bot.mjs                  # run the bot (long-lived)
node slack-autofix-bot.mjs scan [N]         # thread buttons under the last N failing/crashed messages
node slack-autofix-bot.mjs warm <reportId>… # pre-run AI triage for report id(s) — makes modals instant
node slack-autofix-bot.mjs crash-rca <ts>   # analyze a crash message by ts and post the RCA in-thread
node slack-autofix-bot.mjs post <spec> [name]  # manual one-off failed-test card
```

## Behavior details

- **Analysis cache** (`.analysis-cache.json`, gitignored): one AI pass per
  report/build, shared between the bot and the `scan`/`warm` CLI processes;
  `scan` pre-warms so modals open instantly.
- **Loading states**: uncached clicks show an in-modal "Analyzing…" view and
  swap the thread button for an *"AI analysis in progress…"* notice (also
  prevents duplicate concurrent runs); every exit path restores the button.
- **Report picker** shows only the specs that actually failed (spec file names,
  root cause as the subtitle; full paths in the triage list).
- **Crash RCAs post once per build** — repeat clicks reuse the cached analysis.
- The **auto-watcher** (reacting to new messages without `scan`) requires the
  bot to be a channel member; without an invite, use `scan [N]`.

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
