# Evaluation — measuring the agent inside the harness

A harness without measurement can't answer the only question that matters:
**is the agent actually good?** This folder turns the portal's persisted job
history (every heal job records its per-attempt verdicts in `job.healLoops`)
into agent quality numbers.

```bash
node evaluation/agent-metrics.mjs          # human-readable report
node evaluation/agent-metrics.mjs --json   # machine-readable (dashboards/CI)
```

What it reports and why it matters:

| Metric | The question it answers |
|---|---|
| **Heal success rate** (`HEALED / (HEALED + COULD_NOT_FIX)`) | when a fix was the right answer, how often did the agent deliver one? Honest stops (product bugs, obsolete tests) are excluded — they are correct outcomes, not failures |
| **Independently verified ratio** | how many heals were proven by the harness's own rerun vs merely claimed by the AI (unverified acceptances are flagged separately) |
| **First-attempt vs retry-loop heals** | how often the observe → replan → retry loop earned its keep — the defining agent behavior |
| **Honesty outcomes** | product bugs reported, obsolete tests flagged, honest give-ups — the agent refusing to force a test green |
| **Attempts per job, draft PRs opened** | cost and output volume |
| **Per-job table** | spec, verdict, attempts, verified flag, PR link — the audit trail |

The script is read-only: it never touches the pipeline, only reads
`$WORKSPACE_DIR/jobs-store.json` (default `.workspaces/`). Run it from the
repo root, the same working directory the server uses.
