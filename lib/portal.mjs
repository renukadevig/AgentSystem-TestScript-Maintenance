import { PORTAL } from './config.mjs';

// ---- portal client ------------------------------------------------------------
export async function startHeal(spec, failureContext, cfg) {
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
            compareUrl: cfg.prodUrl || '',
            failureContext: failureContext || '',
        }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `portal responded ${res.status}`);
    return data.jobId;
}

export async function pollHeal(jobId) {
    const res = await fetch(`${PORTAL}/api/heal/${jobId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    return res.json();
}
