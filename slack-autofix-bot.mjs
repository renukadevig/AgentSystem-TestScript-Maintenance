/**
 * Slack Auto-fix bot for QA CI-report channels.
 *
 * Two ways to trigger a self-heal:
 *   1. AUTO: the bot watches the channel; when the existing "Cypress Test
 *      Reporter" posts a Sanity Report with Failed > 0, the bot threads a
 *      reply with a spec picker — select a hotel spec to auto-fix it.
 *   2. MANUAL: `node scripts/slack-autofix-bot.mjs post <spec> [test name…]`
 *      posts a one-off card with an Auto-fix button.
 *
 * Picking a spec (with a confirm dialog) calls the QA portal's self-heal
 * pipeline (POST /api/heal, openPr=true): clone → local Claude CLI reruns the
 * failing spec → heals → re-verifies → draft PR. Progress + the PR link are
 * threaded back under the report.
 *
 * Runs in Socket Mode — no public URL; works from a laptop behind VPN.
 *
 * Env (in .env — see .env.example; AUTOFIX_CHANNEL_CONFIG for per-channel repos):
 *   SLACK_BOT_TOKEN=xoxb-…       (Bot User OAuth Token)
 *   SLACK_APP_TOKEN=xapp-…       (App-level token, connections:write)
 *   SLACK_AUTOFIX_CHANNEL=#your-ci-channel
 *   PORTAL_URL=http://127.0.0.1:8080
 *   AUTOFIX_REPO=<owner>/<specs-repo>       (where draft PRs are opened)
 *   AUTOFIX_BRANCH=master
 *   AUTOFIX_SPEC_FILTER=                    (substring(s) for the spec picker, comma-sep)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bolt from '@slack/bolt';
import { getQualityCookieHeader } from './quality-cookie.mjs';

// ---- env: load .env.local the same way the portal does -----------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
}

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const APP_TOKEN = process.env.SLACK_APP_TOKEN || '';
// Optional user token (xoxp-…): lets `scan` read channel history AS the user
// (already a member) so the bot never needs to be invited to the channel.
const USER_TOKEN = process.env.SLACK_USER_TOKEN || '';
// ---- team-configurable targets (no hardcoded org defaults) --------------------
// Global defaults come from .env; AUTOFIX_CHANNEL_CONFIG optionally maps each
// Slack channel to its own specs repo / branch / spec filter, e.g.:
//   AUTOFIX_CHANNEL_CONFIG={"#hotel-cypress-logs":{"repo":"org/hotel-specs","branch":"master","filter":"hotel"},
//                           "#flights-cypress-logs":{"repo":"org/flight-specs","filter":"flight"}}
const CHANNEL = process.env.SLACK_AUTOFIX_CHANNEL || '';
const PORTAL = (process.env.PORTAL_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const REPO = process.env.AUTOFIX_REPO || '';
const BRANCH = process.env.AUTOFIX_BRANCH || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const SPEC_FILTER_RAW = process.env.AUTOFIX_SPEC_FILTER || '';

let CHANNEL_CONFIG = {};
try {
    const parsed = JSON.parse(process.env.AUTOFIX_CHANNEL_CONFIG || '{}');
    for (const [k, v] of Object.entries(parsed)) CHANNEL_CONFIG[k.toLowerCase().replace(/^#?/, '#')] = v;
} catch (e) {
    console.error(`AUTOFIX_CHANNEL_CONFIG is not valid JSON — ignoring it (${e.message})`);
}

/** Effective config for a channel name; channel map wins over global env. */
function cfgForName(channelName) {
    const c = CHANNEL_CONFIG[(channelName || '').toLowerCase().replace(/^#?/, '#')] || {};
    return {
        repo: c.repo || REPO,
        branch: c.branch ?? BRANCH,
        filter: c.filter ?? SPEC_FILTER_RAW,
        framework: (c.framework || process.env.AUTOFIX_FRAMEWORK || 'cypress').toLowerCase() === 'playwright' ? 'playwright' : 'cypress',
    };
}

// channel-id → "#name" cache (interactive payloads carry ids, config uses names)
const chanNames = new Map();
async function cfgForChannelId(id) {
    if (!chanNames.has(id)) {
        try {
            const r = await readClient.conversations.info({ channel: id });
            chanNames.set(id, `#${r.channel?.name || ''}`);
        } catch {
            chanNames.set(id, '');
        }
    }
    return cfgForName(chanNames.get(id));
}
// Quality dashboard (report source). QUALITY_COOKIE is a logged-in session's
// Cookie header — the "public" report pages still require an Okta session.
const QUALITY_URL = (process.env.QUALITY_URL || '').replace(/\/+$/, ''); // quality dashboard base — required for report-driven triage
const QUALITY_COOKIE = process.env.QUALITY_COOKIE || '';

if (!BOT_TOKEN || !APP_TOKEN) {
    console.error(
        'Missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN in .env.local.\n' +
            'Create the app from scripts/slack-autofix-manifest.json, install it, and paste both tokens.',
    );
    process.exit(1);
}

const { App } = bolt;
const app = new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true });
// Read-side client: user token when provided (no channel membership needed),
// else the bot token (requires /invite).
const readClient = USER_TOKEN ? new bolt.webApi.WebClient(USER_TOKEN) : app.client;

// ---- spec list (for the picker) — from the GitHub tree, cached ---------------
const specCache = new Map(); // `${repo}@${branch}|${filter}` → { at, specs }
async function listSpecs(cfg) {
    if (!cfg.repo) throw new Error('no specs repo configured — set AUTOFIX_REPO or AUTOFIX_CHANNEL_CONFIG');
    const key = `${cfg.repo}@${cfg.branch || 'default'}|${cfg.filter}`;
    const hit = specCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000 && hit.specs.length) return hit.specs;
    const filters = (cfg.filter || '').split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
    const headers = { Accept: 'application/vnd.github+json' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(
        `https://api.github.com/repos/${cfg.repo}/git/trees/${cfg.branch || 'HEAD'}?recursive=1`,
        { headers },
    );
    if (!res.ok) throw new Error(`GitHub tree ${res.status}`);
    const data = await res.json();
    const specs = (data.tree || [])
        .map((t) => t.path)
        .filter((p) => /\.(cy|spec|test)\.[jt]sx?$/i.test(p))
        .filter((p) => !p.includes('obsolete') && !p.includes('obselete'))
        .filter((p) => !filters.length || filters.some((f) => p.toLowerCase().includes(f)))
        .sort();
    specCache.set(key, { at: Date.now(), specs });
    return specs;
}

// Slack option text is capped at 75 chars — show the path tail, keep full path in value.
function specOption(spec) {
    const tail = spec.length > 73 ? `…${spec.slice(-72)}` : spec;
    return {
        text: { type: 'plain_text', text: tail },
        value: spec, // ≤150 chars for repo-relative spec paths
    };
}

function confirmDialog(specLabel, repo) {
    return {
        title: { type: 'plain_text', text: 'Start auto-fix?' },
        text: {
            type: 'mrkdwn',
            text: `Reruns \`${specLabel}\`, self-heals it with the local AI CLI, re-verifies, and opens a *draft PR* on ${repo}.`,
        },
        confirm: { type: 'plain_text', text: 'Start' },
        deny: { type: 'plain_text', text: 'Cancel' },
    };
}

// ---- report-driven failures (quality.almosafer.io) -----------------------------
// reportId → [{ spec, errors: [{ title, message }] }]
const reportCache = new Map();

/** Pull the 24-char report id out of a reporter message's Report link.
 *  The category segment (cypress/backend/…) is captured so the right
 *  dashboard API is queried — remembered per report id. */
const reportCategory = new Map();
function extractReportId(msg) {
    const m = JSON.stringify(msg).match(/public\/insights\/(\w[\w-]*)\/([a-f0-9]{24})/i);
    if (!m) return null;
    reportCategory.set(m[2], m[1]);
    return m[2];
}

/**
 * Fetch the Cypress report from the quality dashboard and return failed tests
 * grouped by spec file. Shape from cypress-report-adapter.ts: results[] (and
 * buildResults[].results[]) → suites with file/_flattenMetadata.filePath and
 * tests[] carrying state + err.message.
 */
// Cookie source: explicit env override, else read live from the user's own
// Chrome session (scripts/quality-cookie.mjs) — cached briefly so a burst of
// picks doesn't hammer the Keychain/cookie store.
let liveCookie = { at: 0, value: '' };
async function qualityCookie() {
    if (QUALITY_COOKIE) return QUALITY_COOKIE;
    if (Date.now() - liveCookie.at < 5 * 60 * 1000 && liveCookie.value) return liveCookie.value;
    const value = await getQualityCookieHeader(QUALITY_URL);
    if (!value) throw new Error('no quality.almosafer.io session in Chrome — log in there first');
    liveCookie = { at: Date.now(), value };
    return value;
}

async function fetchFailedSpecs(reportId) {
    if (!QUALITY_URL) throw new Error('QUALITY_URL not set — configure the quality dashboard base URL in .env');
    if (reportCache.has(reportId)) return reportCache.get(reportId);
    const cookie = await qualityCookie();
    const res = await fetch(`${QUALITY_URL}/api/insights/${reportCategory.get(reportId) || 'cypress'}/${reportId}`, {
        headers: { cookie, 'user-agent': 'qa-autofix-bot' },
        redirect: 'manual', // a login redirect means the session expired
    });
    if (res.status >= 300 && res.status < 400) {
        liveCookie = { at: 0, value: '' }; // force a fresh Chrome read next time
        throw new Error('quality session expired — log in to quality.almosafer.io in Chrome');
    }
    if (!res.ok) throw new Error(`quality API ${res.status}`);
    const data = await res.json();
    const report = data?.report || data?.rawReport || data?.data?.report || data?.data || data;
    const suites = [
        ...(report?.results || []),
        ...(report?.buildResults || []).flatMap((b) => b?.results || []),
    ];
    const bySpec = new Map();
    for (const suite of suites) {
        const spec = suite?._flattenMetadata?.filePath || suite?.file || '';
        if (!spec) continue;
        for (const t of suite?.tests || []) {
            if ((t.state || '').toLowerCase() !== 'failed') continue;
            if (!bySpec.has(spec)) bySpec.set(spec, []);
            bySpec.get(spec).push({
                title: t.fullTitle || t.title || '(untitled test)',
                message: t.err?.message || '(no error message captured)',
            });
        }
    }
    const failed = [...bySpec.entries()].map(([spec, errors]) => ({ spec, errors }));
    // Full-run stats travel with the failures so the thread can show the
    // complete picture (all / passed / failed / skipped), not just failures.
    const s = report?.stats || {};
    const stats = {
        total: s.tests ?? null,
        passed: s.passes ?? null,
        failed: s.failures ?? null,
        skipped: (s.skipped ?? 0) + (s.pending ?? 0) || null,
    };
    const entry = { failed, stats };
    reportCache.set(reportId, entry);
    if (reportCache.size > 50) reportCache.delete(reportCache.keys().next().value);
    return entry;
}

// ---- AI root-cause triage (fast Haiku pass over the report's errors) ----------
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
// Model for the pre-modal root-cause triage. Fable 5 for analysis quality;
// override with AUTOFIX_ANALYSIS_MODEL (e.g. "haiku" for speed).
const ANALYSIS_MODEL = process.env.AUTOFIX_ANALYSIS_MODEL || 'claude-fable-5';
// Disk-backed so the short-lived `scan` process can pre-warm the triage and
// the long-running bot picks it up on click (separate processes, shared file).
const ANALYSIS_CACHE_FILE = path.join(__dirname, '.analysis-cache.json');
function loadAnalysisCache() {
    try {
        return new Map(Object.entries(JSON.parse(fs.readFileSync(ANALYSIS_CACHE_FILE, 'utf8'))));
    } catch {
        return new Map();
    }
}
const analysisCache = loadAnalysisCache(); // reportId → [{rootCause, category}] aligned with failed[]
function persistAnalysisCache() {
    try {
        fs.writeFileSync(ANALYSIS_CACHE_FILE, JSON.stringify(Object.fromEntries(analysisCache)));
    } catch {
        /* cache persistence is best-effort */
    }
}
const analysisInFlight = new Map(); // reportId → Promise

const CATEGORY_BADGE = {
    TEST_CODE: '🔧 likely test-code fix',
    PRODUCT_BUG: '🐞 possible product bug',
    ENVIRONMENT: '🌐 environment/access issue',
    UNCLEAR: '❓ unclear — needs a look',
};

function runClaudeQuick(prompt, { timeoutMs = 240_000 } = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        if (CLAUDE_CLI.includes('/')) env.PATH = `${path.dirname(CLAUDE_CLI)}:${env.PATH || ''}`;
        const child = spawn(CLAUDE_CLI, ['-p', prompt, '--model', ANALYSIS_MODEL, '--output-format', 'text'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`analysis timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`claude exited ${code}: ${(err || out).slice(-200)}`));
        });
    });
}

/**
 * One fast AI pass over ALL failed specs of a report → short root cause +
 * category per spec. Cached per report; concurrent callers share one run.
 * Falls back to the heuristic classifier when the CLI is unavailable.
 */
async function analyzeReport(reportId, failed) {
    if (!analysisCache.has(reportId)) {
        // Another process (scan pre-warm) may have written it since startup.
        const disk = loadAnalysisCache();
        if (disk.has(reportId)) analysisCache.set(reportId, disk.get(reportId));
    }
    if (analysisCache.has(reportId)) return analysisCache.get(reportId);
    if (analysisInFlight.has(reportId)) return analysisInFlight.get(reportId);

    const run = (async () => {
        const specsBlock = failed
            .slice(0, 10)
            .map((entry, i) => {
                const errs = entry.errors
                    .slice(0, 5)
                    .map((e) => `  - test: ${e.title.slice(0, 160)}\n    error: ${e.message.replace(/\s+/g, ' ').slice(0, 500)}`)
                    .join('\n');
                return `[${i}] ${entry.spec}\n${errs}${entry.errors.length > 5 ? `\n  (+${entry.errors.length - 5} more failures)` : ''}`;
            })
            .join('\n\n');

        const prompt = `You are a senior QA automation engineer triaging Cypress E2E failures from a CI run against the Almosafer travel site (hotels/flights funnels).

For EACH failed spec below, infer the most likely root cause from its error message(s) and classify it.

Rules:
- rootCause: ONE sentence, max 25 words, concrete (name the selector/assertion/page if visible in the error). No hedging filler.
- category: "TEST_CODE" (selector drift, bad wait, stale assertion — automation can fix), "PRODUCT_BUG" (app/data genuinely wrong — must NOT be forced green), "ENVIRONMENT" (page unreachable, 403, infra), or "UNCLEAR".
- Same-pattern failures within a spec share one root cause.

Return ONLY a JSON array, no prose, one item per spec index:
[{"i": 0, "rootCause": "...", "category": "TEST_CODE"}, ...]

Failed specs:
${specsBlock}`;

        const out = await runClaudeQuick(prompt);
        const m = out.match(/\[[\s\S]*\]/);
        if (!m) throw new Error('no JSON in analysis output');
        const arr = JSON.parse(m[0]);
        const results = failed.map((entry, i) => {
            const hit = arr.find((a) => Number(a.i) === i) || {};
            return {
                rootCause: (hit.rootCause || classifyError(entry.errors[0]?.message)).slice(0, 240),
                category: CATEGORY_BADGE[hit.category] ? hit.category : 'UNCLEAR',
            };
        });
        analysisCache.set(reportId, results);
        if (analysisCache.size > 50) analysisCache.delete(analysisCache.keys().next().value);
        persistAnalysisCache();
        return results;
    })().finally(() => analysisInFlight.delete(reportId));

    analysisInFlight.set(reportId, run);
    return run;
}

/** Heuristic-only fallback rows, shaped like analyzeReport's output. */
function heuristicAnalysis(failed) {
    return failed.map((entry) => ({
        rootCause: classifyError(entry.errors[0]?.message),
        category: 'UNCLEAR',
    }));
}

// ---- Jenkins crash analysis (console-log driven, no report exists) -------------
const JENKINS_BUILD_RE = /https?:\/\/[^\s"'<>\\|]+\/job\/[^\s"'<>\\|]+?\/(\d+)\/?/i;

/** Detect a Jenkins Crash Monitor message and return its build URL (+ any
 *  question the monitor asked in its Action line, so the AI can answer it). */
function extractJenkinsBuild(msg) {
    const raw = JSON.stringify(msg);
    if (!/Jenkins Crash/i.test(raw)) return null;
    const m = raw.match(JENKINS_BUILD_RE);
    if (!m) return null;
    const url = m[0].replace(/\\+$/, '').replace(/\/?$/, '/');
    const job = (url.match(/\/job\/(.+?)\/\d+\/$/) || [])[1]?.replace(/\/job\//g, '/') || 'unknown-job';
    // "Action: 👥 Hotel Team: @Renuka - DO WE NEED TO MAKE SMALL JOB!!" → the question part
    let question = '';
    const qi = raw.indexOf('Action:');
    if (qi >= 0) {
        question = raw
            .slice(qi + 7, qi + 260)
            .split('\\n')[0]
            .replace(/<[^>]*>/g, '')
            .replace(/:[a-z_]+:/g, '')
            .replace(/\\+u[0-9a-f]{4}/gi, '')
            .replace(/["\\]/g, '')
            .trim();
    }
    return { url, job, build: m[1], question };
}

/** Session cookie for any internal host, read live from Chrome (cached 5 min). */
const hostCookies = new Map();
async function cookieFor(baseUrl) {
    const host = new URL(baseUrl).hostname;
    const hit = hostCookies.get(host);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
    const value = await getQualityCookieHeader(baseUrl);
    if (!value) throw new Error(`no ${host} session in Chrome — log in there first`);
    hostCookies.set(host, { at: Date.now(), value });
    return value;
}

/**
 * Condense a (potentially huge) Jenkins console log for analysis: keep the
 * head (job setup), every error-ish line, and a generous tail (where the
 * timeout/abort actually shows).
 */
function condenseConsoleLog(text) {
    const lines = text.split(/\r?\n/);
    const head = lines.slice(0, 20);
    const errRe = /error|failed|failing|timeout|timed out|exception|aborted|killed|OOM|ECONN|✖|✗|CypressError|AssertionError|Executing spec|Running: |spec\.js/i;
    const errLines = lines.filter((l) => errRe.test(l)).slice(-150);
    const tail = text.slice(-6000);
    return `--- HEAD ---\n${head.join('\n')}\n\n--- ERROR-MATCHED LINES ---\n${errLines.join('\n')}\n\n--- TAIL ---\n${tail}`;
}

/** Fetch + AI-analyze a crashed Jenkins build's console log. Cached. */
async function analyzeCrash(buildUrl, jobLabel, question = '') {
    const key = `crash:${buildUrl}`;
    if (!analysisCache.has(key)) {
        const disk = loadAnalysisCache();
        if (disk.has(key)) analysisCache.set(key, disk.get(key));
    }
    if (analysisCache.has(key)) return analysisCache.get(key);
    if (analysisInFlight.has(key)) return analysisInFlight.get(key);

    const run = (async () => {
        const cookie = await cookieFor(buildUrl);
        const res = await fetch(`${buildUrl}consoleText`, { headers: { cookie }, redirect: 'manual' });
        if (!res.ok) throw new Error(`Jenkins consoleText ${res.status} — check VPN / Jenkins login in Chrome`);
        const log = await res.text();
        const condensed = condenseConsoleLog(log);

        const prompt = `You are a senior CI/QA engineer investigating a CRASHED/TIMED-OUT Jenkins build of a Cypress E2E job.

Job: ${jobLabel}
Below is a condensed console log (head + error-matched lines + tail). Determine what the build was doing when it died and why.

Return ONLY a JSON object:
{
  "rootCause": "<one sentence, max 30 words, concrete>",
  "stuckAt": "<the stage/spec/test it was executing when it stalled, or 'unknown'>",
  "category": "TEST_HANG" | "INFRA" | "APP" | "TOO_BIG_JOB" | "UNCLEAR",
  "recommendation": "<one actionable sentence: e.g. split the job, fix a hanging spec (name it), raise a specific timeout, infra fix>"${
      question ? `,\n  "answerToTeamQuestion": "<direct yes/no + one-line reason answering: ${question.replace(/"/g, "'")}>"` : ''
  }
}

CONSOLE LOG (condensed from ${log.length} chars):
${condensed.slice(0, 24000)}`;

        const out = await runClaudeQuick(prompt);
        const m = out.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('no JSON in crash analysis output');
        const result = { ...JSON.parse(m[0]), logChars: log.length };
        analysisCache.set(key, result);
        persistAnalysisCache();
        return result;
    })().finally(() => analysisInFlight.delete(key));

    analysisInFlight.set(key, run);
    return run;
}

const CRASH_BADGE = {
    TEST_HANG: '🪝 hanging test',
    INFRA: '🌐 infrastructure',
    APP: '🐞 application issue',
    TOO_BIG_JOB: '📦 job too big / needs splitting',
    UNCLEAR: '❓ unclear',
};

/** Thread reply blocks for a crash message. */
function crashButtonBlocks(build) {
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `🧠 Crashed build \`${build.job} #${build.build}\` — click to get an AI root-cause analysis from the Jenkins *console log* (no test report exists for a crashed run).`,
            },
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    style: 'primary',
                    text: { type: 'plain_text', text: '🧠 AI Analyse Crash' },
                    action_id: 'crash_analyse',
                    value: JSON.stringify({ u: build.url, q: (build.question || '').slice(0, 200) }).slice(0, 1990),
                },
            ],
        },
    ];
}

/** RCA text for the thread (team-visible — crashes have no auto-fix step). */
function crashRcaText(jobLabel, buildNo, a, buildUrl) {
    return (
        `🧠 *AI Crash Analysis — \`${jobLabel} #${buildNo}\`* · ${CRASH_BADGE[a.category] || a.category}\n` +
        `*Root cause:* ${a.rootCause}\n` +
        `*Stuck at:* ${a.stuckAt}\n` +
        `*Recommendation:* ${a.recommendation}` +
        (a.answerToTeamQuestion ? `\n💬 *Re: the team's question* — ${a.answerToTeamQuestion}` : '') +
        `\n_Analyzed ${Math.round((a.logChars || 0) / 1000)}k chars of console log · <${buildUrl}console|full log>_`
    );
}

/** Post the RCA into the thread once per build (dedupe via the cache entry). */
async function shareCrashRca({ client, channel, threadTs, buildUrl, jobLabel, buildNo, a }) {
    if (a.sharedTs) return;
    const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: crashRcaText(jobLabel, buildNo, a, buildUrl),
    });
    a.sharedTs = res.ts;
    analysisCache.set(`crash:${buildUrl}`, a);
    persistAnalysisCache();
}

// ---- crash button → loading modal → console-log AI analysis ---------------------
app.action('crash_analyse', async ({ ack, body, client, action }) => {
    await ack();
    let buildUrl = action.value || '';
    let question = '';
    try {
        const v = JSON.parse(action.value);
        buildUrl = v.u || buildUrl;
        question = v.q || '';
    } catch {
        /* legacy plain-URL button values */
    }
    const jobLabel = (buildUrl.match(/\/job\/(.+?)\/\d+\/$/) || [])[1]?.replace(/\/job\//g, '/') || 'build';
    const buildNo = (buildUrl.match(/\/(\d+)\/$/) || [])[1] || '?';

    const loading = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'AI Crash Analysis' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `🧠 *Analyzing the console log of* \`${jobLabel} #${buildNo}\`*…*\nFetching from Jenkins and inferring the root cause — this view updates itself (~30-60s on first run).`,
                    },
                },
            ],
        },
    });

    let blocks;
    try {
        const a = await analyzeCrash(buildUrl, `${jobLabel} #${buildNo}`, question);
        // Crashes can't be auto-fixed — the analysis IS the deliverable, so
        // share it in the thread for the whole team (once per build).
        await shareCrashRca({
            client,
            channel: body.channel.id,
            threadTs: body.message.thread_ts || body.message.ts,
            buildUrl,
            jobLabel,
            buildNo,
            a,
        });
        blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text:
                        `*${jobLabel} #${buildNo}* · ${CRASH_BADGE[a.category] || a.category}\n\n` +
                        `🧠 *Root cause:* ${a.rootCause}\n` +
                        `📍 *Stuck at:* ${a.stuckAt}\n` +
                        `✅ *Recommendation:* ${a.recommendation}` +
                        (a.answerToTeamQuestion ? `\n💬 *Re: the team's question* — ${a.answerToTeamQuestion}` : '') +
                        `\n\n_The RCA has also been posted in the thread for the team._`,
                },
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `Analyzed ${Math.round((a.logChars || 0) / 1000)}k chars of console log · <${buildUrl}console|open full log>`,
                    },
                ],
            },
        ];
    } catch (e) {
        blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `:warning: Could not analyze the crash:\n> ${e.message}\n\nCheck you are on VPN and logged in to Jenkins in Chrome, then click again.`,
                },
            },
        ];
    }

    await client.views.update({
        view_id: loading.view.id,
        view: {
            type: 'modal',
            title: { type: 'plain_text', text: 'AI Crash Analysis' },
            close: { type: 'plain_text', text: 'Close' },
            blocks,
        },
    });
});

/** Turn a spec's failures into the CI context the heal prompt consumes. */
function failureContextFor(entry) {
    const parts = entry.errors
        .slice(0, 10)
        .map((e, i) => `${i + 1}) ${e.title}\n${e.message}`);
    return `Failed tests in ${entry.spec} (from the CI run report):\n\n${parts.join('\n\n')}`;
}

/**
 * Thread reply for a reporter message: ALWAYS the Auto-fix button when the
 * message links a report — no data fetching at post time. The report detail
 * (root-cause triage) loads when the button is clicked, so an expired quality
 * session never degrades the UI; it just asks for a re-login in the modal.
 * The legacy full-spec dropdown remains only for messages with no Report link.
 */
async function pickerBlocksFor(msg, failedCount, cfg) {
    const reportId = extractReportId(msg);
    if (!reportId) return specPickerBlocks(failedCount, cfg);
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `🧠 *${failedCount} failed test(s)* — click to get an AI root-cause analysis per spec, then optionally pick one to auto-fix. Fixes are verified by a real Cypress rerun (max 3 fix→verify loops; product bugs are reported, never forced green).`,
            },
        },
        analyseButtonBlock(reportId),
    ];
}

const specName = (spec) => spec.split('/').pop();

/**
 * Instant, heuristic root-cause classification of a Cypress error message —
 * shown in the spec-selection modal so the human can triage at a glance.
 * (Deliberately not an LLM call: the modal must open within Slack's 3s
 * trigger window; the full AI analysis happens after selection anyway.)
 */
function classifyError(msg = '') {
    const m = msg.toLowerCase();
    if (/expected to find element/.test(m)) {
        const sel = (msg.match(/`([^`]+)`/) || [])[1];
        return `Selector not found${sel ? ` (\`${sel.slice(0, 60)}\`)` : ''} — likely selector drift after a UI change`;
    }
    if (/being covered|is covered by|not visible|element is detached/.test(m))
        return 'Element not clickable (covered/hidden/detached) — overlay or timing issue';
    if (/event_assertion|event should exist/.test(m))
        return 'Analytics event not fired — possible product bug, will NOT be forced green';
    if (/cy\.visit\(\)|failed trying to load|net::|econnrefused|403 forbidden/.test(m))
        return 'Page failed to load — environment/access issue, not test code';
    if (/expected .+ to (equal|eq|deep|contain|match|have length)/.test(m))
        return 'Assertion/data mismatch — expected vs actual differ; could be data drift or a product change';
    if (/timed out retrying/.test(m)) return 'Timeout waiting for app state — wait/sync issue or slow environment';
    return (msg.split('\n')[0] || 'Unclassified failure').slice(0, 120);
}

/** Thread reply: CI summary (reporter's own style) + an Auto-fix button that
 *  opens the spec-selection modal. */
async function reportPickerBlocks(reportId, failedCount) {
    const { failed, stats } = await fetchFailedSpecs(reportId);
    if (!failed.length) throw new Error('report has no failed tests with detail');
    const summary =
        stats.total != null
            ? `\`\`\`🧪 Total: ${stats.total}   ✔️ Passed: ${stats.passed ?? '?'}   ✖️ Failed: ${stats.failed ?? failedCount}   ⏳ Pending/Skipped: ${stats.skipped ?? 0}\`\`\``
            : `*${failedCount} test(s) failed*`;
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `${summary}\n🔧 *${failed.length} failed spec(s)* can be auto-fixed — AI repairs from the report's error detail, then a real Cypress rerun verifies (max 3 fix→verify loops; product bugs are reported, never forced green).`,
            },
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    style: 'primary',
                    text: { type: 'plain_text', text: '🔧 Auto-fix' },
                    action_id: 'autofix_open_modal',
                    value: `r:${reportId}`,
                },
            ],
        },
    ];
}

/** The analyse button block (used on post and when restoring after loading). */
function analyseButtonBlock(reportId) {
    return {
        type: 'actions',
        elements: [
            {
                type: 'button',
                style: 'primary',
                text: { type: 'plain_text', text: '🧠 AI Analyse Failures' },
                action_id: 'autofix_open_modal',
                value: `r:${reportId}`,
            },
        ],
    };
}

// ---- Auto-fix button → modal with spec choice -----------------------------------
app.action('autofix_open_modal', async ({ ack, body, client, action }) => {
    await ack();
    const rm = /^r:([a-f0-9]{24})$/i.exec(action.value || '');
    if (!rm) return;
    const threadTs = body.message.thread_ts || body.message.ts;

    // While the AI pass runs (cold cache only — scan pre-warms), swap the
    // button for a loading notice: no native spinner in Slack, and removing
    // the button also blocks concurrent duplicate runs.
    const analysisReady = analysisCache.has(rm[1]) || loadAnalysisCache().has(rm[1]);
    const introText = body.message.blocks?.[0]?.text?.text || '';
    const setButtonMsg = (blocks, fallback) =>
        client.chat
            .update({ channel: body.channel.id, ts: body.message.ts, text: fallback, blocks })
            .catch(() => {});
    if (!analysisReady) {
        await setButtonMsg(
            [
                { type: 'section', text: { type: 'mrkdwn', text: introText } },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: `⏳ *AI analysis in progress…* started by <@${body.user.id}>. The button returns here when the analysis is ready (~1-2 min).`,
                        },
                    ],
                },
            ],
            'AI analysis in progress…',
        );
    }
    let failed;
    try {
        ({ failed } = await fetchFailedSpecs(rm[1]));
    } catch (e) {
        // Put the button back before reporting — never leave the loading state.
        if (!analysisReady) {
            await setButtonMsg(
                [{ type: 'section', text: { type: 'mrkdwn', text: introText } }, analyseButtonBlock(rm[1])],
                'AI failure analysis',
            );
        }
        // Show the problem in a modal (private to the clicker) instead of
        // spamming the thread or degrading to a context-free spec list.
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                title: { type: 'plain_text', text: 'Report unavailable' },
                close: { type: 'plain_text', text: 'Close' },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text:
                                `:warning: Could not read the test report:\n> ${e.message}\n\n` +
                                `If the quality-dashboard session expired, open quality.almosafer.io in Chrome, sign in, then click *Auto-fix* again.`,
                        },
                    },
                ],
            },
        });
        return;
    }
    const MAX_SHOWN = 10;

    // Phase 1: open instantly (Slack's 3s trigger window) with a loading view;
    // Phase 2: update in place once the AI triage is ready (cached → instant).
    const loading = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal',
            callback_id: 'autofix_modal',
            private_metadata: JSON.stringify({ channel: body.channel.id, threadTs }),
            title: { type: 'plain_text', text: 'AI Failure Analysis' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `🧠 *Analyzing ${Math.min(failed.length, MAX_SHOWN)} failed spec(s) with AI…*\nRoot causes are being inferred from the report's errors — this view updates itself in ~10-20 seconds.`,
                    },
                },
            ],
        },
    });

    let analysis;
    try {
        analysis = await analyzeReport(rm[1], failed);
    } catch (e) {
        console.error(`AI analysis failed (${rm[1]}): ${e.message} — using heuristics.`);
        analysis = heuristicAnalysis(failed);
    }

    // Analysis finished — restore the button in the thread (loading state off).
    if (!analysisReady) {
        await setButtonMsg(
            [{ type: 'section', text: { type: 'mrkdwn', text: introText } }, analyseButtonBlock(rm[1])],
            'AI failure analysis ready',
        );
    }

    const shown = failed.slice(0, MAX_SHOWN);
    const listBlocks = shown.flatMap((entry, i) => [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `*${i + 1}. ${specName(entry.spec)}* — ${entry.errors.length} failed · ${CATEGORY_BADGE[analysis[i].category]}\n` +
                    `🧠 ${analysis[i].rootCause}\n` +
                    `📁 \`${entry.spec}\``,
            },
        },
        ...(i < shown.length - 1 ? [{ type: 'divider' }] : []),
    ]);

    const options = shown.map((entry, i) => ({
        text: { type: 'plain_text', text: `${i + 1}. ${specName(entry.spec)}`.slice(0, 75) },
        description: { type: 'plain_text', text: analysis[i].rootCause.replace(/[`_*]/g, '').slice(0, 75) },
        value: `r:${rm[1]}:${i}`,
    }));

    await client.views.update({
        view_id: loading.view.id,
        view: {
            type: 'modal',
            callback_id: 'autofix_modal',
            private_metadata: JSON.stringify({ channel: body.channel.id, threadTs }),
            title: { type: 'plain_text', text: 'AI Failure Analysis' },
            submit: { type: 'plain_text', text: 'Start auto-fix' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
                ...listBlocks,
                ...(failed.length > MAX_SHOWN
                    ? [
                          {
                              type: 'context',
                              elements: [
                                  { type: 'mrkdwn', text: `…and ${failed.length - MAX_SHOWN} more failed spec(s) not shown.` },
                              ],
                          },
                      ]
                    : []),
                { type: 'divider' },
                {
                    type: 'input',
                    block_id: 'spec_block',
                    label: { type: 'plain_text', text: 'Which spec should be auto-fixed?' },
                    element: {
                        type: 'static_select',
                        action_id: 'spec_select',
                        placeholder: { type: 'plain_text', text: 'Choose from the list above…' },
                        options,
                    },
                },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text:
                                '*What happens:* the AI fixes the spec starting from this root-cause analysis, then a real Cypress rerun verifies it. ' +
                                'If still failing it refixes + reruns (max 3 loops). Genuine product bugs are reported — never forced green. ' +
                                'Ends with a *draft PR* for review.',
                        },
                    ],
                },
            ],
        },
    });
});

// ---- modal submit → resolve spec + errors → run ----------------------------------
app.view('autofix_modal', async ({ ack, body, view, client }) => {
    await ack();
    let meta = {};
    try {
        meta = JSON.parse(view.private_metadata || '{}');
    } catch {
        /* ignore */
    }
    const value = view.state.values?.spec_block?.spec_select?.selected_option?.value || '';
    const rm = /^r:([a-f0-9]{24}):(\d+)$/i.exec(value);
    if (!rm || !meta.channel) return;
    let spec = value;
    let failureContext = '';
    try {
        const { failed } = await fetchFailedSpecs(rm[1]);
        const entry = failed[Number(rm[2])];
        if (!entry) throw new Error('spec not found in report');
        spec = entry.spec;
        failureContext = failureContextFor(entry);
    } catch (e) {
        await client.chat.postMessage({
            channel: meta.channel,
            thread_ts: meta.threadTs,
            text: `:x: Could not resolve the selected spec: ${e.message}`,
        });
        return;
    }
    await runAndReport({
        client,
        channel: meta.channel,
        threadTs: meta.threadTs,
        user: body.user.id,
        spec,
        failureContext,
    });
});

async function specPickerBlocks(failedCount, cfg) {
    const specs = await listSpecs(cfg);
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `:wrench: *${failedCount} test(s) failed* — pick a spec to auto-fix ` +
                    `(reruns it, self-heals via the local AI CLI, re-verifies, opens a draft PR):`,
            },
            accessory: {
                type: 'static_select',
                action_id: 'autofix_pick',
                placeholder: { type: 'plain_text', text: 'Select a spec…' },
                options: specs.slice(0, 100).map(specOption),
                confirm: confirmDialog('the selected spec', cfg.repo),
            },
        },
    ];
}

// ---- portal client ------------------------------------------------------------
async function startHeal(spec, failureContext, cfg) {
    if (!cfg?.repo) throw new Error('no specs repo configured for this channel — set AUTOFIX_REPO or AUTOFIX_CHANNEL_CONFIG');
    const res = await fetch(`${PORTAL}/api/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            repoUrl: cfg.repo,
            branch: cfg.branch || '',
            spec,
            openPr: true,
            cliType: 'claude',
            framework: cfg.framework || 'cypress',
            failureContext: failureContext || '',
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `portal responded ${res.status}`);
    return data.jobId;
}

async function pollHeal(jobId) {
    const res = await fetch(`${PORTAL}/api/heal/${jobId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    return res.json();
}

// ---- run a heal and thread progress under the triggering message --------------
async function runAndReport({ client, channel, threadTs, user, spec, failureContext, cfg }) {
    const say = (text) =>
        client.chat.postMessage({ channel, thread_ts: threadTs, text }).catch(() => {});

    await say(
        `:hourglass_flowing_sand: <@${user}> started auto-fix for \`${spec}\`` +
            (failureContext
                ? ` — analysing the report's failure detail, fixing, then verifying… (no reproduction run needed)`
                : ` — cloning, healing with the local AI CLI, re-verifying… (can take 10-25 min)`),
    );

    let jobId;
    try {
        jobId = await startHeal(spec, failureContext, cfg || (await cfgForChannelId(channel)));
    } catch (e) {
        await say(`:x: Could not start the heal: ${e.message}\nIs the QA portal running at ${PORTAL}?`);
        return;
    }

    let lastLoops = 0;
    const started = Date.now();
    const TIMEOUT_MS = 45 * 60 * 1000;
    while (Date.now() - started < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 10_000));
        let job;
        try {
            job = await pollHeal(jobId);
        } catch {
            continue; // transient poll failure
        }
        if ((job.healLoops?.length || 0) > lastLoops) {
            lastLoops = job.healLoops.length;
            const l = job.healLoops[lastLoops - 1];
            await say(`Loop ${l.attempt}: ${l.cypressPassed ? ':white_check_mark:' : ':x:'} ${l.verdict}`);
        }
        if (['done', 'error', 'stopped'].includes(job.status)) {
            if (job.pr?.url) {
                const verifyLine =
                    job.verified === true
                        ? ':white_check_mark: verified by an independent Cypress rerun'
                        : `:warning: ${job.verifyNote || 'not independently verified'}`;
                await say(
                    `:white_check_mark: *${job.pr.draft ? 'Draft PR' : 'PR'} opened:* ${job.pr.url}\n` +
                        `Branch \`${job.pr.branch}\` → \`${job.pr.base}\` · Verdict *${job.verdict}* (${verifyLine}) · ${job.changedFiles.length} file(s) changed.\n` +
                        `Review it, then mark ready to merge.`,
                );
            } else if (job.verdict === 'PRODUCT_BUG') {
                await say(`:beetle: Verdict *PRODUCT_BUG* — real app bug, not the test. No PR opened; raise it with the team.`);
            } else if (job.status === 'error') {
                await say(`:x: Heal failed: ${job.error || 'unknown error'}`);
            } else {
                await say(
                    `:warning: Finished with verdict *${job.verdict || 'UNKNOWN'}* — ${job.prError ? `PR failed: ${job.prError}` : 'no PR opened.'} Check the portal for the diff.`,
                );
            }
            return;
        }
    }
    await say(`:warning: Gave up waiting after 45 min — check the portal UI for job ${jobId}.`);
}

// ---- AUTO: thread a spec picker under failing Sanity Reports -------------------
const seenReports = new Set(); // message ts we've already replied to
app.event('message', async ({ event, client }) => {
    try {
        if (event.thread_ts || seenReports.has(event.ts)) return; // top-level, once
        // React to failing reports (Sanity/Monitoring Report shapes) AND to
        // Jenkins Crash Monitor messages (console-log analysis, no report).
        const failed = failedCountOf(event);
        const crash = failed ? null : extractJenkinsBuild(event);
        if (!failed && !crash) return;

        seenReports.add(event.ts);
        if (seenReports.size > 500) seenReports.clear(); // bounded memory
        const blocks = crash
            ? crashButtonBlocks(crash)
            : await pickerBlocksFor(event, failed, await cfgForChannelId(event.channel));
        await client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.ts,
            text: crash
                ? `Crashed build ${crash.job} #${crash.build} — AI analyse from console log`
                : `${failed} test(s) failed — pick a spec to auto-fix`,
            blocks,
        });
    } catch (e) {
        console.error('report-watch error:', e.message);
    }
});

// ---- picker selection → run ----------------------------------------------------
app.action('autofix_pick', async ({ ack, body, client, action }) => {
    await ack();
    const value = action.selected_option?.value;
    if (!value) return;

    let spec = value;
    let failureContext = '';
    // Report-driven picks carry "r:<reportId>:<idx>" — resolve the spec and its
    // captured errors from the report (cache first, refetch if bot restarted).
    const rm = /^r:([a-f0-9]{24}):(\d+)$/i.exec(value);
    if (rm) {
        try {
            const { failed } = await fetchFailedSpecs(rm[1]);
            const entry = failed[Number(rm[2])];
            if (!entry) throw new Error('spec index not found in report');
            spec = entry.spec;
            failureContext = failureContextFor(entry);
        } catch (e) {
            await client.chat.postMessage({
                channel: body.channel.id,
                thread_ts: body.message.thread_ts || body.message.ts,
                text: `:x: Could not load the report detail (${e.message}) — cannot resolve the selected spec.`,
            });
            return;
        }
    }

    await runAndReport({
        client,
        channel: body.channel.id,
        threadTs: body.message.thread_ts || body.message.ts,
        user: body.user.id,
        spec,
        failureContext,
    });
});

// ---- MANUAL: one-off card with a button ----------------------------------------
app.action('autofix_run', async ({ ack, body, client, action }) => {
    await ack();
    const { spec } = JSON.parse(action.value);
    await runAndReport({
        client,
        channel: body.channel.id,
        threadTs: body.message.ts,
        user: body.user.id,
        spec,
    });
});

function failedTestCard({ spec, testName }) {
    return [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text:
                    `:red_circle: *Cypress test failed*\n` +
                    `*Test:* ${testName || '(see spec)'}\n` +
                    `*Spec:* \`${spec}\``,
            },
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    style: 'primary',
                    text: { type: 'plain_text', text: '🔧 Auto-fix & PR' },
                    action_id: 'autofix_run',
                    value: JSON.stringify({ spec }),
                    confirm: confirmDialog(spec, cfgForName(CHANNEL).repo || 'the specs repo'),
                },
            ],
        },
    ];
}

// ---- helpers for scan mode -------------------------------------------------------
async function channelIdByName(client, name) {
    const clean = name.replace(/^#/, '');
    let cursor;
    do {
        const res = await client.conversations.list({ types: 'public_channel', limit: 1000, cursor });
        const hit = res.channels.find((c) => c.name === clean);
        if (hit) return hit.id;
        cursor = res.response_metadata?.next_cursor || '';
    } while (cursor);
    throw new Error(`channel ${name} not found (is the bot in the workspace?)`);
}

function failedCountOf(msg) {
    const raw = JSON.stringify(msg);
    // Matches the CI reporter's message styles: "Sanity Report | …" and
    // "Monitoring Report | …", or anything posted by the reporter app itself.
    if (
        !/Sanity Report|Monitoring Report|Cypress Test Reporter/i.test(raw) &&
        msg.bot_profile?.name !== 'Cypress Test Reporter'
    )
        return 0;
    const m = raw.match(/Failed:\s*\*?(\d+)/i);
    return m ? Number(m[1]) : 0;
}

/**
 * Find the most recent failing report in channel history and thread the spec
 * picker under it. Lets the flow be demoed on an EXISTING report instead of
 * waiting for CI to post a new one.
 */
async function scanAndThread(client, maxReports = 1, scanChannel = CHANNEL) {
    // History reads go through readClient (user token if set — no membership
    // needed); the picker itself is posted by the bot via chat:write.public.
    if (!scanChannel) throw new Error('no channel — set SLACK_AUTOFIX_CHANNEL or pass one: scan [N] [#channel]');
    const channel = await channelIdByName(readClient, scanChannel);
    const hist = await readClient.conversations.history({ channel, limit: 10 });
    let threaded = 0;
    for (const msg of hist.messages || []) {
        if (threaded >= maxReports) break;
        // skip thread replies and our own messages
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;
        if (msg.bot_profile?.name === 'QA Auto-fix') continue;
        const failed = failedCountOf(msg);
        const crash = failed ? null : extractJenkinsBuild(msg);
        if (!failed && !crash) continue;
        // don't double-thread: check whether we already replied under it
        if (msg.reply_count) {
            const replies = await readClient.conversations.replies({ channel, ts: msg.ts, limit: 20 });
            if ((replies.messages || []).some((r) => r.bot_profile?.name === 'QA Auto-fix')) {
                console.log(`Failing report ts ${msg.ts} already has a picker — skipping.`);
                continue;
            }
        }
        const blocks = crash ? crashButtonBlocks(crash) : await pickerBlocksFor(msg, failed, cfgForName(scanChannel));
        await client.chat.postMessage({
            channel,
            thread_ts: msg.ts,
            text: crash
                ? `Crashed build ${crash.job} #${crash.build} — AI analyse from console log`
                : `${failed} test(s) failed — pick a spec to auto-fix`,
            blocks,
        });
        threaded += 1;
        console.log(
            crash
                ? `Threaded crash-analysis button under ${crash.job} #${crash.build} (ts ${msg.ts}).`
                : `Threaded spec picker under report ts ${msg.ts} (Failed: ${failed}).`,
        );
        if (crash) continue; // no report pre-warm for crashes (analysis runs on click)
        // Pre-warm the AI triage (persisted to disk) so the bot's modal is
        // instant AND rich on click. Awaited: the scan process must not exit
        // before the analysis lands in the shared cache file.
        const reportId = extractReportId(msg);
        if (reportId) {
            try {
                const { failed: f } = await fetchFailedSpecs(reportId);
                console.log(`Pre-warming AI triage for report ${reportId} (${f.length} failed spec(s))…`);
                await analyzeReport(reportId, f);
                console.log(`AI triage ready for report ${reportId}.`);
            } catch (e) {
                console.log(`Pre-warm skipped for ${reportId}: ${e.message} (modal will analyze on first click)`);
            }
        }
    }
    if (!threaded) console.log('No failing Cypress report found (without an existing picker) in the last 10 messages.');
}

// ---- CLI ------------------------------------------------------------------------
const [, , cmd, specArg, ...nameParts] = process.argv;
if (cmd === 'crash-rca') {
    // Analyze a crashed build and post the RCA into its Slack thread directly:
    //   node scripts/slack-autofix-bot.mjs crash-rca <thread-ts>
    (async () => {
        const threadTs = specArg;
        if (!threadTs) throw new Error('Usage: crash-rca <thread-ts of the Jenkins crash message>');
        const channel = await channelIdByName(readClient, CHANNEL);
        const hist = await readClient.conversations.replies({ channel, ts: threadTs, limit: 1 });
        const msg = hist.messages?.[0];
        if (!msg) throw new Error('crash message not found at that ts');
        const build = extractJenkinsBuild(msg);
        if (!build) throw new Error('no Jenkins build link in that message');
        console.log(`Analyzing ${build.job} #${build.build}${build.question ? ` (question: ${build.question})` : ''}…`);
        const a = await analyzeCrash(build.url, `${build.job} #${build.build}`, build.question);
        await shareCrashRca({
            client: app.client,
            channel,
            threadTs,
            buildUrl: build.url,
            jobLabel: build.job,
            buildNo: build.build,
            a,
        });
        console.log('RCA posted to the thread:');
        console.log(crashRcaText(build.job, build.build, a, build.url));
        process.exit(0);
    })().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
} else if (cmd === 'warm') {
    // Pre-run the AI triage for a report id (or ids) into the shared cache.
    const ids = [specArg, ...nameParts].filter((s) => /^[a-f0-9]{24}$/i.test(s || ''));
    if (!ids.length) {
        console.error('Usage: node scripts/slack-autofix-bot.mjs warm <reportId> [reportId…]');
        process.exit(1);
    }
    (async () => {
        for (const id of ids) {
            const { failed } = await fetchFailedSpecs(id);
            console.log(`Report ${id}: ${failed.length} failed spec(s) — analyzing…`);
            const analysis = await analyzeReport(id, failed);
            failed.forEach((entry, i) =>
                console.log(`  ${i + 1}. ${specName(entry.spec)} [${analysis[i].category}]\n     ${analysis[i].rootCause}`),
            );
        }
        process.exit(0);
    })().catch((e) => {
        console.error(e.message);
        process.exit(1);
    });
} else if (cmd === 'scan') {
    const chanArg = [specArg, ...nameParts].find((a) => a?.startsWith('#'));
    scanAndThread(app.client, Math.max(1, Number(specArg) || 1), chanArg || CHANNEL)
        .then(() => process.exit(0))
        .catch((e) => {
            console.error(`Scan failed: ${e.message}`);
            process.exit(1);
        });
} else if (cmd === 'post') {
    if (!specArg) {
        console.error('Usage: node scripts/slack-autofix-bot.mjs post <spec-path> [test name…]');
        process.exit(1);
    }
    app.client.chat
        .postMessage({
            channel: CHANNEL,
            text: `Cypress test failed: ${specArg}`,
            blocks: failedTestCard({ spec: specArg, testName: nameParts.join(' ') }),
        })
        .then((r) => {
            console.log(`Posted card to ${CHANNEL} (ts ${r.ts}).`);
            process.exit(0);
        })
        .catch((e) => {
            console.error(`Failed to post: ${e.message}\nIs the bot invited to ${CHANNEL}? (/invite @QA Auto-fix)`);
            process.exit(1);
        });
} else {
    (async () => {
        await app.start();
        console.log('⚡ QA Auto-fix bot connected (Socket Mode).');
        console.log(`   Portal: ${PORTAL} · Default repo: ${REPO || '(unset)'}${BRANCH ? '@' + BRANCH : ''} · Default channel: ${CHANNEL || '(unset)'}`);
        const mapped = Object.keys(CHANNEL_CONFIG);
        if (mapped.length) console.log(`   Channel map: ${mapped.map((c) => `${c} → ${CHANNEL_CONFIG[c].repo || REPO}`).join(' · ')}`);
        console.log('   Watching for "Cypress Test Reporter" failure reports; will thread a spec picker.');
        console.log('   Manual card:  node scripts/slack-autofix-bot.mjs post <spec-path> [test name]');
    })();
}
