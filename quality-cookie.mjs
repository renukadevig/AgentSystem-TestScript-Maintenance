/**
 * Runtime cookie provider: reads the logged-in quality.almosafer.io session
 * straight from the user's own Chrome profile, so the Slack bot never needs a
 * manually pasted QUALITY_COOKIE.
 *
 * How: Chrome (macOS) stores cookies AES-128-CBC-encrypted in a SQLite file;
 * the encryption password lives in the macOS Keychain ("Chrome Safe Storage").
 * First use triggers a Keychain permission dialog — click "Always Allow".
 * Only cookies for the QUALITY_URL host are read; nothing else is touched.
 *
 * CLI self-test:  node scripts/quality-cookie.mjs [reportId]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pexecFile = promisify(execFile);

const CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

/** Keychain password → AES key (Chrome's fixed macOS KDF params). */
async function chromeAesKey() {
    const { stdout } = await pexecFile('security', [
        'find-generic-password',
        '-w',
        '-s',
        'Chrome Safe Storage',
    ]);
    const password = stdout.trim();
    return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookie(buf, key, hostKey) {
    if (buf.length <= 3 || buf.subarray(0, 3).toString() !== 'v10') return '';
    const iv = Buffer.alloc(16, ' ');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);
    let out;
    try {
        out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    } catch {
        return '';
    }
    // Chrome ≥ m130 prefixes the value with SHA256(host_key) — strip it.
    if (out.length > 32) {
        const digest = crypto.createHash('sha256').update(hostKey).digest();
        if (digest.equals(out.subarray(0, 32))) out = out.subarray(32);
    }
    return out.toString('utf8');
}

/** Copy the (possibly locked) Cookies DB and read rows for the host. */
async function cookieRowsFor(profileDir, host) {
    const src = path.join(CHROME_DIR, profileDir, 'Cookies');
    try {
        await fs.access(src);
    } catch {
        return [];
    }
    const tmp = path.join(os.tmpdir(), `ck-${process.pid}-${profileDir.replace(/\W/g, '')}.sqlite`);
    await fs.copyFile(src, tmp);
    try {
        const sql = `SELECT name, hex(encrypted_value), host_key FROM cookies WHERE host_key LIKE '%${host}%';`;
        const { stdout } = await pexecFile('/usr/bin/sqlite3', ['-separator', '\t', tmp, sql]);
        return stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [name, hexVal, hostKey] = line.split('\t');
                return { name, encrypted: Buffer.from(hexVal || '', 'hex'), hostKey };
            });
    } finally {
        await fs.rm(tmp, { force: true });
    }
}

/**
 * Build a Cookie header for the quality dashboard from the user's own Chrome
 * session. Scans Default + numbered profiles; first profile with cookies for
 * the host wins. Returns '' when Chrome has no session (user logged out).
 */
export async function getQualityCookieHeader(qualityUrl = 'https://quality.almosafer.io') {
    const host = new URL(qualityUrl).hostname;
    let key;
    try {
        key = await chromeAesKey();
    } catch (e) {
        throw new Error(
            `Keychain access failed (${e.message.trim().slice(0, 120)}) — approve the "Chrome Safe Storage" dialog and retry.`,
        );
    }
    const entries = await fs.readdir(CHROME_DIR).catch(() => []);
    const profiles = entries.filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
    for (const profile of profiles) {
        const rows = await cookieRowsFor(profile, host);
        const pairs = rows
            .map((r) => ({ name: r.name, value: decryptCookie(r.encrypted, key, r.hostKey) }))
            .filter((r) => r.value);
        if (pairs.length) {
            return pairs.map((r) => `${r.name}=${r.value}`).join('; ');
        }
    }
    return '';
}

// ---- CLI self-test ---------------------------------------------------------
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
    const reportId = process.argv[2] || '';
    const qualityUrl = process.env.QUALITY_URL || 'https://quality.almosafer.io';
    getQualityCookieHeader(qualityUrl)
        .then(async (cookie) => {
            if (!cookie) {
                console.error('No quality session found in Chrome — open quality.almosafer.io and log in first.');
                process.exit(1);
            }
            console.log(`Cookie header built from Chrome (${cookie.length} chars, ${cookie.split('; ').length} cookies) — value not printed.`);
            if (!reportId) return;
            const res = await fetch(`${qualityUrl}/api/insights/cypress/${reportId}`, {
                headers: { cookie, 'user-agent': 'qa-autofix-bot' },
                redirect: 'manual',
            });
            console.log(`Report API status: ${res.status}`);
            if (res.ok) {
                const data = await res.json();
                const report = data?.report || data?.rawReport || data?.data?.report || data?.data || data;
                const suites = [
                    ...(report?.results || []),
                    ...(report?.buildResults || []).flatMap((b) => b?.results || []),
                ];
                let failed = 0;
                for (const s of suites)
                    for (const t of s?.tests || [])
                        if ((t.state || '').toLowerCase() === 'failed') {
                            failed += 1;
                            console.log(`✗ [${s?._flattenMetadata?.filePath || s?.file}] ${t.fullTitle || t.title}`);
                            console.log(`  ${String(t.err?.message || '').split('\n')[0].slice(0, 140)}`);
                        }
                console.log(`stats: total=${report?.stats?.tests} passed=${report?.stats?.passes} failed=${failed} skipped=${(report?.stats?.skipped ?? 0) + (report?.stats?.pending ?? 0)}`);
            }
        })
        .catch((e) => {
            console.error(e.message);
            process.exit(1);
        });
}
