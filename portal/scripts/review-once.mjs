// One-shot PR review runner — drives the same pipeline the /api/review route uses.
import { createJob } from "../lib/jobs.js";
import { runReviewPipeline } from "../lib/reviewPipeline.js";

const prUrl = process.argv[2];
const account = process.argv[3] || ""; // "" | business | personal
const cliType = process.argv[4] || "claude"; // claude | cursor
if (!prUrl) {
  console.error("usage: node scripts/review-once.mjs <prUrl> [account] [cliType]");
  process.exit(1);
}

const job = createJob({
  prUrl: prUrl.trim(),
  extraPrompt: "",
  account: ["business", "personal"].includes(account) ? account : "",
  cliType: ["claude", "cursor"].includes(cliType) ? cliType : "claude",
  mode: "review",
});

// Stream log lines as they are emitted.
let lastLen = 0;
const timer = setInterval(() => {
  for (; lastLen < job.log.length; lastLen++) {
    console.error("· " + job.log[lastLen]);
  }
}, 500);

await runReviewPipeline(job);
clearInterval(timer);
for (; lastLen < job.log.length; lastLen++) console.error("· " + job.log[lastLen]);

console.log("\n================ REVIEW RESULT ================");
console.log("status:   " + job.status);
if (job.error) console.log("error:    " + job.error);
console.log("verdict:  " + (job.reviewVerdict || "-"));
console.log("blockers: " + (job.reviewBlockers ?? "-"));
console.log("cli:      " + (job.cliUsed || "-"));
console.log("\n=============== REVIEW DRAFT ==================\n");
console.log(job.reviewDraft || "(no draft produced)");
