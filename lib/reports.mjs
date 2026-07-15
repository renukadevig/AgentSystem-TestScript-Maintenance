import { GITHUB_TOKEN, QUALITY_URL, REPORT_LINK_HINT } from './config.mjs';
import { reportCache, reportCategory, refKeyForUrl, rememberRef, lookupRef } from './store.mjs';
import { aiExtractFailures } from './ai.mjs';
import { qualityCookie, cookieFor, resetQualityCookie } from './session.mjs';
import { JENKINS_BUILD_RE } from './crash.mjs';

// ---- spec list (for the picker) — from the GitHub tree, cached ---------------
const specCache = new Map(); // `${repo}@${branch}|${filter}` → { at, specs }
export async function listSpecs(cfg) {
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
export function specOption(spec) {
    const tail = spec.length > 73 ? `…${spec.slice(-72)}` : spec;
    return {
        text: { type: 'plain_text', text: tail },
        value: spec, // ≤150 chars for repo-relative spec paths
    };
}

/**
 * Find the report link in a CI message and return a short cache key for it.
 * Priority: quality-dashboard insights link (native JSON API) → any other
 * http(s) link (fetched and parsed generically, AI fallback for HTML/unknown).
 * REPORT_LINK_HINT (env) picks the right link when a message carries several.
 */
export function extractReportId(msg) {
    const raw = JSON.stringify(msg);
    const m = raw.match(/public\/insights\/(\w[\w-]*)\/([a-f0-9]{24})/i);
    if (m) {
        reportCategory.set(m[2], m[1]);
        rememberRef(m[2], { kind: 'insights', category: m[1] });
        return m[2];
    }
    // generic report link: any URL except Slack itself and Jenkins build links
    const urls = (raw.match(/https?:\/\/[^\s"'<>\\|]+/gi) || [])
        .map((u) => u.replace(/[\\").,]+$/, ''))
        .filter((u) => !/slack\.com|slack-edge\.com/i.test(u))
        .filter((u) => !JENKINS_BUILD_RE.test(u))
        .filter((u) => !/\.(png|jpe?g|gif|svg)(\?|$)/i.test(u));
    if (!urls.length) return null;
    const pick = REPORT_LINK_HINT ? urls.find((u) => u.toLowerCase().includes(REPORT_LINK_HINT)) || urls[0] : urls[0];
    const key = refKeyForUrl(pick);
    rememberRef(key, { kind: 'generic', url: pick });
    return key;
}

// ---- format parsers → the shared { failed:[{spec,errors:[{title,message}]}], stats } shape ----

/** Our quality dashboard's shape: results[]/buildResults[].results[] suites. */
export function parseDashboardReport(data) {
    const report = data?.report || data?.rawReport || data?.data?.report || data?.data || data;
    const suites = [...(report?.results || []), ...(report?.buildResults || []).flatMap((b) => b?.results || [])];
    if (!suites.length) return null;
    const bySpec = new Map();
    for (const suite of suites) {
        const spec = suite?._flattenMetadata?.filePath || suite?.file || '';
        if (!spec) continue;
        for (const t of suite?.tests || []) {
            if ((t.state || '').toLowerCase() !== 'failed') continue;
            if (!bySpec.has(spec)) bySpec.set(spec, []);
            bySpec.get(spec).push({ title: t.fullTitle || t.title || '(untitled test)', message: t.err?.message || '(no error message captured)' });
        }
    }
    const st = report?.stats || {};
    return {
        failed: [...bySpec.entries()].map(([spec, errors]) => ({ spec, errors })),
        stats: { total: st.tests ?? null, passed: st.passes ?? null, failed: st.failures ?? null, skipped: (st.skipped ?? 0) + (st.pending ?? 0) || null },
    };
}

/** mochawesome merged JSON: results[] with nested suites[]/tests[]. */
export function parseMochawesome(data) {
    if (!data?.stats || !Array.isArray(data?.results)) return null;
    const bySpec = new Map();
    const walk = (node, file) => {
        const f = node.fullFile || node.file || file || '';
        for (const t of node.tests || []) {
            if ((t.state || '').toLowerCase() !== 'failed') continue;
            const spec = f || 'unknown';
            if (!bySpec.has(spec)) bySpec.set(spec, []);
            bySpec.get(spec).push({ title: t.fullTitle || t.title || '(untitled)', message: t.err?.message || t.err?.estack || '(no error captured)' });
        }
        for (const su of node.suites || []) walk(su, f);
    };
    for (const r of data.results) walk(r, r.fullFile || r.file);
    const st = data.stats;
    return {
        failed: [...bySpec.entries()].map(([spec, errors]) => ({ spec: spec.replace(/^.*?(cypress|tests?|e2e)\//, '$1/'), errors })),
        stats: { total: st.tests ?? null, passed: st.passes ?? null, failed: st.failures ?? null, skipped: (st.pending ?? 0) + (st.skipped ?? 0) || null },
    };
}

/** Playwright JSON reporter: suites[].specs[].tests[].results[].status. */
export function parsePlaywrightJson(data) {
    if (!Array.isArray(data?.suites)) return null;
    const bySpec = new Map();
    let total = 0, passed = 0, failedN = 0, skipped = 0;
    const walk = (suite) => {
        for (const sp of suite.specs || []) {
            for (const t of sp.tests || []) {
                total += 1;
                const results = t.results || [];
                const status = results[results.length - 1]?.status || '';
                if (status === 'passed') passed += 1;
                else if (status === 'skipped') skipped += 1;
                else if (status) {
                    failedN += 1;
                    const spec = sp.file || suite.file || 'unknown';
                    if (!bySpec.has(spec)) bySpec.set(spec, []);
                    bySpec.get(spec).push({ title: sp.title || t.title || '(untitled)', message: results[results.length - 1]?.error?.message || `status: ${status}` });
                }
            }
        }
        for (const su of suite.suites || []) walk(su);
    };
    for (const su of data.suites) walk(su);
    if (!total) return null;
    return { failed: [...bySpec.entries()].map(([spec, errors]) => ({ spec, errors })), stats: { total, passed, failed: failedN, skipped: skipped || null } };
}

/**
 * Universal failure fetcher. Insights ids use the dashboard JSON API; any
 * other report URL is fetched (operator Chrome session first, anonymous
 * fallback) and parsed: known JSON shapes natively, everything else via AI.
 */
export async function fetchFailedSpecs(key) {
    if (reportCache.has(key)) return reportCache.get(key);
    const ref = lookupRef(key) || (/^[a-f0-9]{24}$/i.test(key) ? { kind: 'insights', category: reportCategory.get(key) || 'cypress' } : null);
    if (!ref) throw new Error('unknown report reference — re-run scan on this message');

    let entry;
    if (ref.kind === 'insights') {
        if (!QUALITY_URL) throw new Error('QUALITY_URL not set — configure the quality dashboard base URL in .env');
        const cookie = await qualityCookie();
        const res = await fetch(`${QUALITY_URL}/api/insights/${ref.category || 'cypress'}/${key}`, {
            headers: { cookie, 'user-agent': 'qa-autofix-bot' },
            redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
            resetQualityCookie();
            throw new Error(`quality session expired — log in to ${QUALITY_URL} in Chrome`);
        }
        if (!res.ok) throw new Error(`quality API ${res.status}`);
        entry = parseDashboardReport(await res.json());
        if (!entry) throw new Error('dashboard report had no suites');
    } else {
        // generic URL: try the operator's Chrome session, fall back to anonymous
        let cookie = '';
        try { cookie = await cookieFor(ref.url); } catch { /* public report */ }
        const res = await fetch(ref.url, { headers: { ...(cookie ? { cookie } : {}), 'user-agent': 'qa-autofix-bot' } });
        if (!res.ok) throw new Error(`report fetch ${res.status} from ${new URL(ref.url).hostname}`);
        const bodyText = await res.text();
        let json = null;
        try { json = JSON.parse(bodyText); } catch { /* not JSON */ }
        entry = (json && (parseDashboardReport(json) || parseMochawesome(json) || parsePlaywrightJson(json))) || null;
        if (!entry || !entry.failed.length) entry = await aiExtractFailures(bodyText);
    }

    reportCache.set(key, entry);
    if (reportCache.size > 50) reportCache.delete(reportCache.keys().next().value);
    return entry;
}

/** Turn a spec's failures into the CI context the heal prompt consumes. */
export function failureContextFor(entry) {
    const parts = entry.errors
        .slice(0, 10)
        .map((e, i) => `${i + 1}) ${e.title}\n${e.message}`);
    return `Failed tests in ${entry.spec} (from the CI run report):\n\n${parts.join('\n\n')}`;
}
