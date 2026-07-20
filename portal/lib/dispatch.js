/**
 * Autonomous dispatch: turn VLM bug findings into Jira tickets and/or Slack
 * alerts. Both targets are optional and only fire when configured AND the run
 * requested them. Each is best-effort — a dispatch failure is recorded, never
 * thrown, so it can't sink the run.
 */
import { config, jiraConfigured, slackConfigured } from "./config.js";

const SEVERITY_TO_JIRA_PRIORITY = {
  Blocker: "Highest",
  Critical: "High",
  Major: "Medium",
  Minor: "Low",
  Trivial: "Lowest",
};

/** Minimal Atlassian Document Format wrapper for a bug body. */
function adfDoc(bug, ctx) {
  const line = (text) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  });
  const heading = (text) => ({
    type: "heading",
    attrs: { level: 4 },
    content: [{ type: "text", text }],
  });
  const steps = (bug.steps || []).length
    ? [
        heading("Steps"),
        {
          type: "orderedList",
          content: bug.steps.map((s) => ({
            type: "listItem",
            content: [line(String(s))],
          })),
        },
      ]
    : [];

  return {
    type: "doc",
    version: 1,
    content: [
      line(bug.description || ""),
      ...steps,
      heading("Expected"),
      line(bug.expected_result || "(n/a)"),
      heading("Actual"),
      line(bug.actual_result || "(n/a)"),
      heading("Context"),
      line(
        `Repo: ${ctx.repoUrl || "?"} @ ${ctx.branch || "default"} · Product: ${
          ctx.productName || ctx.productId || "?"
        } · Spec: ${bug.requirement_ref || ctx.specName || "?"} · Severity: ${
          bug.severity
        } · Category: ${bug.category}`
      ),
    ],
  };
}

export async function createJiraIssue(bug, ctx, projectKeyOverride) {
  const { jira } = config();
  const projectKey = (projectKeyOverride || jira.projectKey || "").trim();
  if (!projectKey) throw new Error("No Jira project key provided.");
  const auth = Buffer.from(`${jira.email}:${jira.apiToken}`).toString("base64");
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: jira.issueType },
      summary: `[QA Portal] ${bug.title}`.slice(0, 250),
      description: adfDoc(bug, ctx),
    },
  };

  const res = await fetch(`${jira.baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Jira ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    target: "jira",
    key: data.key,
    url: `${jira.baseUrl}/browse/${data.key}`,
    bug: bug.id,
  };
}

async function postSlack(bug, ctx) {
  const { slackWebhookUrl } = config();
  const text = [
    `:bug: *${bug.severity}* — ${bug.title}`,
    bug.description,
    `*Expected:* ${bug.expected_result}`,
    `*Actual:* ${bug.actual_result}`,
    `_${ctx.productName || ctx.productId || ""} · ${ctx.repoUrl || ""}@${
      ctx.branch || "default"
    } · ${bug.requirement_ref || ctx.specName || ""}_`,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { target: "slack", bug: bug.id, ok: true };
}

/**
 * Post a self-heal PR to Slack for team review before it's merged. Best-effort:
 * a Slack failure is logged, never thrown, so it can't sink the heal. No-op if
 * Slack isn't configured.
 */
export async function notifySlackPrOpened({ pr, spec, verdict, changedFiles, cliUsed }, onLog) {
  if (!slackConfigured()) {
    onLog?.("Slack not configured — skipping PR notification.");
    return { ok: false, skipped: true };
  }
  const { slackWebhookUrl } = config();
  const draftNote = pr.draft ? " (draft — review before marking ready to merge)" : "";
  const text = [
    `:wrench: *Auto-fix PR opened${draftNote}* — <${pr.url}|#${pr.number}>`,
    `*Spec:* \`${spec}\``,
    `*Verdict:* ${verdict}${cliUsed ? ` · _${cliUsed}_` : ""}`,
    `*Branch:* \`${pr.branch}\` → \`${pr.base}\``,
    changedFiles?.length ? `*Files:* ${changedFiles.map((f) => `\`${f}\``).join(", ")}` : "",
    `Review it before merging.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 200)}`);
    onLog?.(`Posted the PR to Slack for review.`);
    return { ok: true };
  } catch (e) {
    onLog?.(`Slack PR notification failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Dispatch a list of bugs to the requested targets.
 * @param bugs   findings to file
 * @param ctx    run context { repoUrl, branch, productId, productName, specName }
 * @param want   { jira: boolean, slack: boolean }
 * @param onLog  progress callback
 * @param projectKeyOverride  Jira project key to file under, overriding env JIRA_PROJECT_KEY
 * @returns array of dispatch records (successes and failures)
 */
export async function dispatchBugs(bugs, ctx, want, onLog, projectKeyOverride) {
  const records = [];
  if (!bugs.length) {
    onLog?.("No bugs to dispatch.");
    return records;
  }

  const doJira = want.jira && jiraConfigured();
  const doSlack = want.slack && slackConfigured();

  if (want.jira && !jiraConfigured())
    onLog?.("Jira requested but not configured — skipping Jira dispatch.");
  if (want.slack && !slackConfigured())
    onLog?.("Slack requested but not configured — skipping Slack dispatch.");

  for (const bug of bugs) {
    if (doJira) {
      try {
        const rec = await createJiraIssue(bug, ctx, projectKeyOverride);
        records.push(rec);
        onLog?.(`Filed Jira ${rec.key} for ${bug.id}.`);
      } catch (e) {
        records.push({ target: "jira", bug: bug.id, error: e.message });
        onLog?.(`Jira dispatch failed for ${bug.id}: ${e.message}`);
      }
    }
    if (doSlack) {
      try {
        await postSlack(bug, ctx);
        records.push({ target: "slack", bug: bug.id, ok: true });
        onLog?.(`Posted Slack alert for ${bug.id}.`);
      } catch (e) {
        records.push({ target: "slack", bug: bug.id, error: e.message });
        onLog?.(`Slack dispatch failed for ${bug.id}: ${e.message}`);
      }
    }
  }
  return records;
}
