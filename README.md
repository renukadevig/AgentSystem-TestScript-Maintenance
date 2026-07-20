# AutoTest.ai — Agentic QA Auto-fix

One repo, two cooperating processes that together form an agentic QA auto-fix
system. They are **separate apps that talk over HTTP** — not one program — so
both must be running for the full flow.

```
.
├── portal/      # The FIX ENGINE (Next.js). Clones the repo, runs Cypress/Playwright,
│                # drives the local AI CLI to heal a failing spec, INDEPENDENTLY
│                # re-verifies, reclassifies product-bug vs recent feature-change,
│                # and opens draft PRs. Runs on http://127.0.0.1:8080.
│
└── slack-bot/   # The SENSING + TRIAGE front-end (Slack, Socket Mode). Watches CI
                 # report channels, does AI failure/crash triage, and posts the
                 # buttons. Every fix action is an HTTP call to the portal.
```

## Why two parts

- **`slack-bot/` has no Cypress runner and no git/PR logic.** It senses failures,
  triages them, and shows buttons in Slack.
- **`portal/` does all the real work**: clone → run tests → heal → re-verify → PR.

When someone clicks **Auto-fix** (or **Agree to apply for feature change**) in
Slack, the bot POSTs to the portal (`PORTAL_URL`, default `http://127.0.0.1:8080`).
If the portal isn't running, the bot reports *"is the QA portal running?"* and
nothing heals.

## Run it (both are needed)

```bash
# 1. Fix engine
cd portal && npm install && npm run dev        # serves http://127.0.0.1:8080

# 2. Slack bot (new terminal) — talks to the portal above
cd slack-bot && npm install && node slack-autofix-bot.mjs
```

Each subfolder keeps its own `README.md`, `.env.example`, and `package.json`.
Copy each `.env.example` to `.env` / `.env.local` and fill in the tokens before
running.

## The flow

CI posts a failure → bot triages it in Slack → click **Auto-fix** → portal heals
and **independently verifies** with a real test rerun → opens a **draft PR**.
A suspected **product bug** is reruns once to reverify; if it turns out a feature
changed recently (not an app bug), the bot offers **"Agree to apply for feature
change"**, which opens the PR only after a human clicks.
