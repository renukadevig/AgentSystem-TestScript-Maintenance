import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// NOTE: this file lives in lib/memory/, so the repo-root cache file is two levels up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- report-driven failures (quality.almosafer.io) -----------------------------
// key → { failed: [{ spec, errors: [{ title, message }] }], stats }
export const reportCache = new Map();

// ---- report references: works with ANY report link, not just the dashboard ----
// Insights links keep their 24-hex id as the key; any other report URL gets a
// short hash key. Refs are persisted (analysisCache file) so buttons survive
// bot restarts.
export const reportCategory = new Map();

export function refKeyForUrl(url) {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
}
export function rememberRef(key, ref) {
    analysisCache.set(`ref:${key}`, ref);
    persistAnalysisCache();
}
export function lookupRef(key) {
    if (analysisCache.has(`ref:${key}`)) return analysisCache.get(`ref:${key}`);
    const disk = loadAnalysisCache();
    return disk.get(`ref:${key}`) || null;
}

// Disk-backed so the short-lived `scan` process can pre-warm the triage and
// the long-running bot picks it up on click (separate processes, shared file).
export const ANALYSIS_CACHE_FILE = path.join(__dirname, '..', '..', '.analysis-cache.json');
export function loadAnalysisCache() {
    try {
        return new Map(Object.entries(JSON.parse(fs.readFileSync(ANALYSIS_CACHE_FILE, 'utf8'))));
    } catch {
        return new Map();
    }
}
export const analysisCache = loadAnalysisCache(); // reportId → [{rootCause, category}] aligned with failed[]
export function persistAnalysisCache() {
    try {
        fs.writeFileSync(ANALYSIS_CACHE_FILE, JSON.stringify(Object.fromEntries(analysisCache)));
    } catch {
        /* cache persistence is best-effort */
    }
}
export const analysisInFlight = new Map(); // reportId → Promise
