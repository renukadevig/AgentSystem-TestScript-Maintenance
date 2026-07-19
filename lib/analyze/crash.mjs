import { analysisCache, analysisInFlight, loadAnalysisCache, persistAnalysisCache } from '../memory/store.mjs';
import { runClaudeQuick } from './ai.mjs';
import { cookieFor } from '../observe/session.mjs';

// ---- Jenkins crash analysis (console-log driven, no report exists) -------------
export const JENKINS_BUILD_RE = /https?:\/\/[^\s"'<>\\|]+\/job\/[^\s"'<>\\|]+?\/(\d+)\/?/i;

/** Detect a Jenkins Crash Monitor message and return its build URL (+ any
 *  question the monitor asked in its Action line, so the AI can answer it). */
export function extractJenkinsBuild(msg) {
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

/**
 * Condense a (potentially huge) Jenkins console log for analysis: keep the
 * head (job setup), every error-ish line, and a generous tail (where the
 * timeout/abort actually shows).
 */
export function condenseConsoleLog(text) {
    const lines = text.split(/\r?\n/);
    const head = lines.slice(0, 20);
    const errRe = /error|failed|failing|timeout|timed out|exception|aborted|killed|OOM|ECONN|✖|✗|CypressError|AssertionError|Executing spec|Running: |spec\.js/i;
    const errLines = lines.filter((l) => errRe.test(l)).slice(-150);
    const tail = text.slice(-6000);
    return `--- HEAD ---\n${head.join('\n')}\n\n--- ERROR-MATCHED LINES ---\n${errLines.join('\n')}\n\n--- TAIL ---\n${tail}`;
}

/** Fetch + AI-analyze a crashed Jenkins build's console log. Cached. */
export async function analyzeCrash(buildUrl, jobLabel, question = '') {
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

export const CRASH_BADGE = {
    TEST_HANG: '🪝 hanging test',
    INFRA: '🌐 infrastructure',
    APP: '🐞 application issue',
    TOO_BIG_JOB: '📦 job too big / needs splitting',
    UNCLEAR: '❓ unclear',
};

/** RCA text for the thread (team-visible — crashes have no auto-fix step). */
export function crashRcaText(jobLabel, buildNo, a, buildUrl) {
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
export async function shareCrashRca({ client, channel, threadTs, buildUrl, jobLabel, buildNo, a }) {
    if (a.sharedTs) return;
    a.sharedTs = 'posting'; // claim synchronously — concurrent clickers bail out here
    const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: crashRcaText(jobLabel, buildNo, a, buildUrl),
    });
    a.sharedTs = res.ts;
    analysisCache.set(`crash:${buildUrl}`, a);
    persistAnalysisCache();
}
