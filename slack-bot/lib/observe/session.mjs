import { getQualityCookieHeader } from '../../quality-cookie.mjs';
import { QUALITY_URL, QUALITY_COOKIE } from '../config.mjs';

// Cookie source: explicit env override, else read live from the user's own
// Chrome session (scripts/quality-cookie.mjs) — cached briefly.
let liveCookie = { at: 0, value: '' };
export async function qualityCookie() {
    if (QUALITY_COOKIE) return QUALITY_COOKIE;
    if (Date.now() - liveCookie.at < 5 * 60 * 1000 && liveCookie.value) return liveCookie.value;
    const value = await getQualityCookieHeader(QUALITY_URL);
    if (!value) throw new Error(`no ${QUALITY_URL || 'quality dashboard'} session in Chrome — log in there first`);
    liveCookie = { at: Date.now(), value };
    return value;
}

/** Drop the cached quality-dashboard cookie (used when the session expired). */
export function resetQualityCookie() {
    liveCookie = { at: 0, value: '' };
}

/** Session cookie for any internal host, read live from Chrome (cached 5 min). */
const hostCookies = new Map();
export async function cookieFor(baseUrl) {
    const host = new URL(baseUrl).hostname;
    const hit = hostCookies.get(host);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
    const value = await getQualityCookieHeader(baseUrl);
    if (!value) throw new Error(`no ${host} session in Chrome — log in there first`);
    hostCookies.set(host, { at: Date.now(), value });
    return value;
}
