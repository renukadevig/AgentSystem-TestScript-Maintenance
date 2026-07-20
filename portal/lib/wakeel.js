/**
 * wakeel.js
 * On-demand "Wakeel agent coverage" report over Jira Story-type issues.
 *
 * For each Story it answers, per agent, whether the Wakeel agent was used:
 *   - QA Test Plan agent        → Wakeel Action = "Generate Test Plan"
 *   - QA Automation Author agent → Wakeel Action = "Generate Test Automation"
 *
 * The Wakeel Action custom field only holds the *latest* value, so per-agent
 * history is taken from the union of the current value and every value the
 * changelog ever recorded — that way a ticket that ran Test Plan and later
 * Automation shows BOTH as used.
 *
 * When an agent was NOT used, a deterministic reason is inferred (no AI):
 *   1. Not yet at QA stage        — the issue never reached a Ready-for-QA/QA
 *                                    status, so it isn't eligible yet.
 *   2. Missing requirement info   — no acceptance criteria AND a thin story.
 *   3. No acceptance criteria     — AC not documented (field empty + no AC heading).
 *   4. Thin story                 — very short description / ~3 lines.
 *   5. Coverage gap               — eligible, well-specified, but never triggered.
 *
 * Credentials + base URL are reused from lib/config.js (JIRA_* env vars).
 * Everything instance-specific (which custom field carries Wakeel Action, which
 * fields hold acceptance criteria) is discovered from Jira, not hardcoded.
 */
import { config } from "./config.js";

// --- Tunables (kept here so the whole heuristic is auditable in one place) ---
const THIN_DESC_CHARS = 200; // below this the description is "thin"
const THIN_DESC_LINES = 3; // "its short 3 line story"
// A status name matching this is considered "QA stage or later" — i.e. the
// point from which a Wakeel agent is expected to have run.
const QA_OR_LATER =
  /(ready for qa|in qa|qa\b|testing|ready for release|released|deployed|live|done|closed|resolved|merged|uat|staging|pre-?prod|production)/i;

function jira() {
  const c = config().jira;
  if (!c.baseUrl || !c.email || !c.apiToken) {
    throw new Error(
      "Jira is not configured (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)."
    );
  }
  return c;
}

async function jiraFetch(path, method = "get", payload) {
  const c = jira();
  const auth = Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
  const opts = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (payload) opts.body = JSON.stringify(payload);

  const url = c.baseUrl.replace(/\/+$/, "") + path;
  let res = await fetch(url, opts);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await fetch(url, opts);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${method} ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// --- Field discovery (cached for the life of the process) ---
let _fieldCache = null;
async function discoverFields() {
  if (_fieldCache) return _fieldCache;
  const fields = await jiraFetch("/rest/api/3/field", "get");
  const byName = (needle) =>
    fields.filter((f) => (f.name || "").toLowerCase().includes(needle));

  // Wakeel Action drives agent usage. Prefer the exact "wakeel action" field;
  // fall back to the first field named like "wakeel".
  const wakeelAction =
    byName("wakeel action")[0] || byName("wakeel")[0] || null;
  const acFields = byName("acceptance criteria").map((f) => f.id);

  _fieldCache = {
    wakeelActionId: wakeelAction ? wakeelAction.id : null,
    wakeelActionName: wakeelAction ? wakeelAction.name : null,
    acFieldIds: acFields,
  };
  return _fieldCache;
}

/** Flatten Atlassian Document Format to plain text, preserving line breaks. */
function adfToText(adf) {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  let out = "";
  const walk = (n) => {
    if (!n) return;
    if (n.type === "text" && n.text) out += n.text;
    if (n.type === "hardBreak") out += "\n";
    (n.content || []).forEach(walk);
    if (n.type === "paragraph" || (n.type || "").startsWith("heading")) out += "\n";
  };
  walk(adf);
  return out;
}

/** A cascading-select field value → readable label (parent / child). */
function optionText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  const parts = [];
  if (v.value) parts.push(v.value);
  if (v.child && v.child.value) parts.push(v.child.value);
  return parts.join(" / ");
}

/** Which agent a Wakeel Action label refers to. */
function agentOfActionLabel(label) {
  const s = (label || "").toLowerCase();
  if (s.includes("test plan")) return "testPlan";
  if (s.includes("automation")) return "automation";
  return null;
}

/** Paginated enhanced search. Returns up to maxIssues issue objects. */
async function searchStories(jql, fields, maxIssues) {
  const issues = [];
  let nextPageToken = null;
  let guard = 0;
  do {
    const payload = { jql, maxResults: 100, fields };
    if (nextPageToken) payload.nextPageToken = nextPageToken;
    const data = await jiraFetch("/rest/api/3/search/jql", "post", payload);
    if (data.issues && data.issues.length) issues.push(...data.issues);
    nextPageToken = data.nextPageToken || null;
    guard++;
  } while (nextPageToken && issues.length < maxIssues && guard < 200);
  return issues.slice(0, maxIssues);
}

/** Full status + custom-field changelog for one issue (paginated). */
async function getChangelog(key) {
  const values = [];
  let startAt = 0;
  let guard = 0;
  while (guard < 100) {
    const data = await jiraFetch(
      `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=100`,
      "get"
    );
    if (data.values && data.values.length) values.push(...data.values);
    if (data.isLast || !data.values || !data.values.length) break;
    startAt += data.maxResults || 100;
    guard++;
  }
  return values;
}

/** Run async work over items with a bounded concurrency pool. */
async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Evaluate one issue into a report row.
 * @param issue      Jira issue (with requested fields)
 * @param changelog  that issue's changelog values
 * @param fieldMap   discovered field ids
 */
function evaluateIssue(issue, changelog, fieldMap) {
  const f = issue.fields || {};
  const key = issue.key;
  const status = f.status ? f.status.name : "";
  const statusCategory = f.status?.statusCategory?.key || ""; // new | indeterminate | done

  // --- Agent usage: current Wakeel Action value ∪ changelog history ---
  const labels = new Set();
  if (fieldMap.wakeelActionId) {
    const cur = optionText(f[fieldMap.wakeelActionId]);
    if (cur) labels.add(cur);
  }
  for (const v of changelog) {
    for (const it of v.items || []) {
      const isWakeelAction =
        it.fieldId === fieldMap.wakeelActionId ||
        (it.field || "").toLowerCase() === "wakeel action";
      if (isWakeelAction && it.toString) labels.add(it.toString);
    }
  }
  let testPlanUsed = false;
  let automationUsed = false;
  for (const label of labels) {
    const a = agentOfActionLabel(label);
    if (a === "testPlan") testPlanUsed = true;
    if (a === "automation") automationUsed = true;
  }

  // --- Reached QA stage? (current status or any past status) ---
  let reachedQA = statusCategory === "done" || QA_OR_LATER.test(status);
  if (!reachedQA) {
    for (const v of changelog) {
      for (const it of v.items || []) {
        if (it.field === "status" && QA_OR_LATER.test(it.toString || "")) {
          reachedQA = true;
          break;
        }
      }
      if (reachedQA) break;
    }
  }

  // --- Requirement quality ---
  const descText = adfToText(f.description).trim();
  const descChars = descText.length;
  const descLines = descText.split("\n").filter((l) => l.trim()).length;
  const acFromField = (fieldMap.acFieldIds || []).some((id) => {
    const v = f[id];
    return typeof v === "string" ? v.trim().length > 0 : adfToText(v).trim().length > 0;
  });
  const acInDesc = /acceptance\s+criteria/i.test(descText);
  const hasAC = acFromField || acInDesc;
  const thin = descChars < THIN_DESC_CHARS || descLines <= THIN_DESC_LINES;

  // --- Deterministic "why not used" reason (precedence order) ---
  function reasonFor(used) {
    if (used) return "";
    if (!reachedQA) {
      return `Not yet at QA stage (status: “${status}”). Wakeel runs from Ready-for-QA onward.`;
    }
    if (!hasAC && thin) {
      return `Missing requirement info — no acceptance criteria and thin story (${descChars} chars, ${descLines} line${descLines === 1 ? "" : "s"}).`;
    }
    if (!hasAC) return "No acceptance criteria documented.";
    if (thin) return `Thin story — description only ${descChars} chars / ${descLines} line${descLines === 1 ? "" : "s"}.`;
    return "Coverage gap — eligible and well-specified, but the agent was never triggered.";
  }

  const c = jira();
  return {
    key,
    url: `${c.baseUrl.replace(/\/+$/, "")}/browse/${key}`,
    project: f.project ? f.project.key : "",
    summary: f.summary || "",
    status,
    reachedQA,
    descChars,
    descLines,
    hasAC,
    thin,
    testPlan: { used: testPlanUsed, reason: reasonFor(testPlanUsed) },
    automation: { used: automationUsed, reason: reasonFor(automationUsed) },
    // A short shared "eligibility" note (why the ticket isn't a candidate at all)
    eligible: reachedQA && hasAC && !thin,
  };
}

/**
 * Build the full report.
 * @param opts { projectKeys?: string, extraJql?: string, maxIssues?: number }
 * @param onLog optional progress callback
 */
export async function buildWakeelReport(opts = {}, onLog) {
  const fieldMap = await discoverFields();
  if (!fieldMap.wakeelActionId) {
    throw new Error(
      "Could not find a Wakeel Action field in Jira. Expected a custom field named like “Wakeel Action”."
    );
  }
  onLog?.(`Wakeel field: ${fieldMap.wakeelActionName} (${fieldMap.wakeelActionId}).`);

  const keys = String(opts.projectKeys || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const maxIssues = Math.min(Math.max(parseInt(opts.maxIssues, 10) || 200, 1), 500);

  let jql = "issuetype = Story";
  if (keys.length) jql += ` AND project in (${keys.join(",")})`;
  if (opts.extraJql && opts.extraJql.trim()) jql += ` AND (${opts.extraJql.trim()})`;
  jql += " ORDER BY updated DESC";

  const fields = [
    "summary",
    "status",
    "project",
    "issuetype",
    "description",
    fieldMap.wakeelActionId,
    ...(fieldMap.acFieldIds || []),
  ];

  onLog?.(`Searching Stories: ${jql}`);
  const issues = await searchStories(jql, fields, maxIssues);
  onLog?.(`Found ${issues.length} Story issue(s). Fetching changelogs…`);

  const rows = await mapPool(issues, 6, async (issue) => {
    const changelog = await getChangelog(issue.key);
    return evaluateIssue(issue, changelog, fieldMap);
  });

  // --- Aggregate stats ---
  const stats = {
    total: rows.length,
    testPlanUsed: rows.filter((r) => r.testPlan.used).length,
    automationUsed: rows.filter((r) => r.automation.used).length,
    eitherUsed: rows.filter((r) => r.testPlan.used || r.automation.used).length,
    bothUsed: rows.filter((r) => r.testPlan.used && r.automation.used).length,
    noneUsed: rows.filter((r) => !r.testPlan.used && !r.automation.used).length,
    reasons: {},
  };
  // Reason breakdown across every "not used" verdict (both agents).
  for (const r of rows) {
    for (const agent of ["testPlan", "automation"]) {
      const reason = r[agent].reason;
      if (!reason) continue;
      const bucket = reason.split(" — ")[0].split(" (")[0].replace(/[.:].*$/, "").trim();
      stats.reasons[bucket] = (stats.reasons[bucket] || 0) + 1;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    jql,
    field: { id: fieldMap.wakeelActionId, name: fieldMap.wakeelActionName },
    truncated: issues.length >= maxIssues,
    maxIssues,
    stats,
    rows,
  };
}
