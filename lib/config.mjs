import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- env: load .env.local the same way the portal does -----------------------
// NOTE: this file lives in lib/, so the repo-root .env is one level up.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
}

export const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const APP_TOKEN = process.env.SLACK_APP_TOKEN || '';
// Optional user token (xoxp-…): lets `scan` read channel history AS the user
// (already a member) so the bot never needs to be invited to the channel.
export const USER_TOKEN = process.env.SLACK_USER_TOKEN || '';
// ---- team-configurable targets (no hardcoded org defaults) --------------------
// Global defaults come from .env; AUTOFIX_CHANNEL_CONFIG optionally maps each
// Slack channel to its own specs repo / branch / spec filter, e.g.:
//   AUTOFIX_CHANNEL_CONFIG={"#hotel-cypress-logs":{"repo":"org/hotel-specs","branch":"master","filter":"hotel"},
//                           "#flights-cypress-logs":{"repo":"org/flight-specs","filter":"flight"}}
export const CHANNEL = process.env.SLACK_AUTOFIX_CHANNEL || '';
export const PORTAL = (process.env.PORTAL_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
export const REPO = process.env.AUTOFIX_REPO || '';
export const BRANCH = process.env.AUTOFIX_BRANCH || '';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const SPEC_FILTER_RAW = process.env.AUTOFIX_SPEC_FILTER || '';

export let CHANNEL_CONFIG = {};
try {
    const parsed = JSON.parse(process.env.AUTOFIX_CHANNEL_CONFIG || '{}');
    for (const [k, v] of Object.entries(parsed)) CHANNEL_CONFIG[k.toLowerCase().replace(/^#?/, '#')] = v;
} catch (e) {
    console.error(`AUTOFIX_CHANNEL_CONFIG is not valid JSON — ignoring it (${e.message})`);
}

/** Effective config for a channel name; channel map wins over global env. */
export function cfgForName(channelName) {
    const c = CHANNEL_CONFIG[(channelName || '').toLowerCase().replace(/^#?/, '#')] || {};
    return {
        repo: c.repo || REPO,
        branch: c.branch ?? BRANCH,
        filter: c.filter ?? SPEC_FILTER_RAW,
        framework: (c.framework || process.env.AUTOFIX_FRAMEWORK || 'cypress').toLowerCase() === 'playwright' ? 'playwright' : 'cypress',
    };
}

// Quality dashboard (report source). QUALITY_COOKIE is a logged-in session's
// Cookie header — the "public" report pages still require an Okta session.
export const QUALITY_URL = (process.env.QUALITY_URL || '').replace(/\/+$/, ''); // quality dashboard base — required for report-driven triage
export const QUALITY_COOKIE = process.env.QUALITY_COOKIE || '';

export const REPORT_LINK_HINT = (process.env.REPORT_LINK_HINT || '').toLowerCase();

export const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
// Model for the pre-modal root-cause triage. Fable 5 for analysis quality;
// override with AUTOFIX_ANALYSIS_MODEL (e.g. "haiku" for speed).
export const ANALYSIS_MODEL = process.env.AUTOFIX_ANALYSIS_MODEL || 'claude-fable-5';
