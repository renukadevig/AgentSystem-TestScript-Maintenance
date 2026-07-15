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
| `PORTAL_URL` | `http://127.0.0.1:8080` | where the [AutoHeal portal](https://github.com/renukadevig/Agent-AutoHeal-TestScripts) runs |
| `GITHUB_TOKEN` | `ghp_…` | read the specs repo tree (fallback picker) |
| `CLAUDE_CLI_PATH` | `/usr/local/bin/claude` | your locally installed + logged-in Claude Code CLI |
| `QUALITY_URL` | `https://your-quality-dashboard` | report source; leave `QUALITY_COOKIE` blank to read your Chrome session live (macOS) |
| `AUTOFIX_CHANNEL_CONFIG` *(optional)* | see below | per-channel repo/branch/framework map |

**Step 3 — run it**: `npm start`, then `node slack-autofix-bot.mjs scan` to
thread buttons under the latest failing reports in your channel.

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
