# The harness — deterministic scaffolding around the agent

An agentic system has two distinct parts, and this repo deliberately separates
them:

- **The agent** — the reasoning component: the local Claude Code / Cursor CLI
  session that reads the failing spec, decides what to change, edits the code,
  and reports a verdict. Non-deterministic by nature.
- **The harness** — everything deterministic wrapped around it: the code that
  plans its prompts, executes it with timeouts, independently verifies its
  claims, bounds its retries, persists its state, and gates its output behind
  humans. The harness is what makes a non-deterministic agent safe to point at
  a production test repo.

The harness is not one file — it is a set of concerns, each implemented where
it belongs:

| Harness concern | Implementation |
|---|---|
| **Loop runner + iteration cap** | the `for (attempt ≤ MAX_HEAL_LOOPS)` agent loop — [`lib/healPipeline.js`](../lib/healPipeline.js) (`MAX_HEAL_LOOPS`, default 3) |
| **Output contract + stop conditions** | verdict parsing — `HEALED` / `PRODUCT_BUG` / `OBSOLETE_TEST` / `COULD_NOT_FIX`; product bugs and obsolete tests stop the loop immediately |
| **Don't-trust-the-model verification** | after the AI claims `HEALED`, the harness reruns the spec itself — [`lib/cypressRunner.js`](../lib/cypressRunner.js); an unreachable app is accepted only with a loud `unverified` flag |
| **Timeouts & kill switches** | `SIGKILL` timers on every CLI session — [`lib/selfheal.js`](../lib/selfheal.js); `RUN_TIMEOUT_MS` on verification runs; `killJob` + per-job child-process tracking with a user-facing Stop endpoint — [`lib/jobs.js`](../lib/jobs.js) |
| **State, progress, crash recovery** | job store with live `emit()` progress events, file-backed persistence, jobs mid-run at a restart marked `interrupted` — [`lib/jobs.js`](../lib/jobs.js) |
| **Prompt planning / context injection** | `buildHealPrompt` (from the CI report's real errors) and `buildRefixPrompt` (from the harness's OWN verification output) + loading the target repo's automation skills — [`lib/selfheal.js`](../lib/selfheal.js) |
| **Human gates** | a fix starts only from an explicit human selection; output is a **draft PR** only; manual approve-&-commit endpoint — `app/api/heal/[jobId]/commit` |
| **Attribution** | commits carry the identity of the human who triggered the action, never a bot identity |
| **Process supervision** | [`guard.js`](../guard.js) supervises the server itself (auto-respawn + health/restart API) |
| **Concurrency guards** (bot side) | analysis cache, in-flight dedup and double-post race guards — in the [Slack bot repo](https://github.com/renukadevig/CI-FailedTestScripts-AutoFix-Portal) |
| **Evaluation** | [`evaluation/agent-metrics.mjs`](../evaluation/agent-metrics.mjs) measures the agent inside the harness: success rate, verified ratio, retry-loop yield, honesty outcomes — see [`evaluation/README.md`](../evaluation/README.md) |

## Design principles

1. **The AI's word is never the last word.** Every `HEALED` claim is checked
   by a harness-side rerun the model cannot influence.
2. **Refusing is a success mode.** `PRODUCT_BUG`, `OBSOLETE_TEST` and
   `COULD_NOT_FIX` are first-class, measured outcomes — the harness never
   pressures the agent to force a test green.
3. **Everything the agent spawns can be killed.** Every child process is
   tracked on the job; stop requests and timeouts end in `SIGKILL`, not hope.
4. **Nothing irreversible without a human.** Draft PRs, explicit approval to
   commit, human-attributed commits.
5. **If it isn't measured, it isn't known.** The evaluation script turns the
   persisted job history into agent quality numbers.
