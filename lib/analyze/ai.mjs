import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_CLI, ANALYSIS_MODEL } from '../config.mjs';
import { analysisCache, analysisInFlight, loadAnalysisCache, persistAnalysisCache } from '../memory/store.mjs';

// ---- AI root-cause triage (fast Haiku pass over the report's errors) ----------
export const CATEGORY_BADGE = {
    TEST_CODE: '🔧 likely test-code fix',
    PRODUCT_BUG: '🐞 possible product bug',
    ENVIRONMENT: '🌐 environment/access issue',
    OBSOLETE_TEST: '📦 feature removed/replaced — spec likely obsolete',
    UNCLEAR: '❓ unclear — needs a look',
};

export function runClaudeQuick(prompt, { timeoutMs = 240_000 } = {}) {
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
export async function analyzeReport(reportId, failed) {
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

        const prompt = `You are a senior QA automation engineer triaging end-to-end test failures from a CI run.

For EACH failed spec below, infer the most likely root cause from its error message(s) and classify it.

Rules:
- rootCause: ONE sentence, max 25 words, concrete (name the selector/assertion/page if visible in the error). No hedging filler.
- category: "TEST_CODE" (selector drift, bad wait, stale assertion — automation can fix), "PRODUCT_BUG" (app/data genuinely wrong — must NOT be forced green), "ENVIRONMENT" (page unreachable, 403, infra), "OBSOLETE_TEST" (the tested element/feature appears COMPLETELY absent — likely intentionally removed or replaced by a new feature; the spec needs retiring, not the app fixing), or "UNCLEAR".
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
export function heuristicAnalysis(failed) {
    return failed.map((entry) => ({
        rootCause: classifyError(entry.errors[0]?.message),
        category: 'UNCLEAR',
    }));
}

/**
 * Instant, heuristic root-cause classification of a Cypress error message —
 * shown in the spec-selection modal so the human can triage at a glance.
 * (Deliberately not an LLM call: the modal must open within Slack's 3s
 * trigger window; the full AI analysis happens after selection anyway.)
 */
export function classifyError(msg = '') {
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

/** Universal fallback: let the AI read ANY report (HTML page, custom JSON,
 *  plain text) and extract the failed tests as structured data. */
export async function aiExtractFailures(content) {
    const text = content
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&\w+;/g, ' ')
        .replace(/\s{3,}/g, '\n')
        .slice(0, 30000);
    const prompt = `You are reading a QA test-run report (format unknown — could be extracted HTML, JSON or text). Identify the FAILED tests.

Return ONLY JSON:
{"stats": {"total": <n|null>, "passed": <n|null>, "failed": <n|null>, "skipped": <n|null>},
 "failures": [{"spec": "<spec/test file path, '' if not shown>", "title": "<test name>", "error": "<error message, max 300 chars>"}]}

REPORT CONTENT:
${text}`;
    const out = await runClaudeQuick(prompt);
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI could not extract failures from the report');
    const parsed = JSON.parse(m[0]);
    const bySpec = new Map();
    for (const f of parsed.failures || []) {
        const spec = f.spec || '';
        if (!bySpec.has(spec)) bySpec.set(spec, []);
        bySpec.get(spec).push({ title: f.title || '(untitled)', message: f.error || '' });
    }
    return {
        failed: [...bySpec.entries()].map(([spec, errors]) => ({ spec, errors })),
        stats: parsed.stats || { total: null, passed: null, failed: (parsed.failures || []).length, skipped: null },
    };
}
