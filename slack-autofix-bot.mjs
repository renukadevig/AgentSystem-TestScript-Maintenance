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
import bolt from '@slack/bolt';
import {
    BOT_TOKEN,
    APP_TOKEN,
    USER_TOKEN,
    CHANNEL,
    PORTAL,
    REPO,
    BRANCH,
    CHANNEL_CONFIG,
    cfgForName,
} from './lib/config.mjs';
import { analysisCache, loadAnalysisCache } from './lib/store.mjs';
import { analyzeReport, heuristicAnalysis, CATEGORY_BADGE } from './lib/ai.mjs';
import {
    extractReportId,
    fetchFailedSpecs,
    failureContextFor,
    listSpecs,
    specOption,
} from './lib/reports.mjs';
import { extractJenkinsBuild, analyzeCrash, CRASH_BADGE, crashRcaText, shareCrashRca } from './lib/crash.mjs';
import { startHeal, pollHeal } from './lib/portal.mjs';

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

    // Cold cache → swap the thread button for a loading notice (no double runs).
    const crashKey = `crash:${buildUrl}`;
    const crashReady = analysisCache.has(crashKey) || loadAnalysisCache().has(crashKey);
    const crashIntro = body.message.blocks?.[0]?.text?.text || '';
    const setCrashMsg = (blocks, fallback) =>
        client.chat
            .update({ channel: body.channel.id, ts: body.message.ts, text: fallback, blocks })
            .catch(() => {});
    if (!crashReady) {
        await setCrashMsg(
            [
                { type: 'section', text: { type: 'mrkdwn', text: crashIntro } },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: `⏳ *AI crash analysis in progress…* started by <@${body.user.id}>. The button returns when the RCA is posted (~30-60s).`,
                        },
                    ],
                },
            ],
            'AI crash analysis in progress…',
        );
    }

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

    if (!crashReady) {
        await setCrashMsg(
            [
                { type: 'section', text: { type: 'mrkdwn', text: crashIntro } },
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            style: 'primary',
                            text: { type: 'plain_text', text: '🧠 AI Analyse Crash' },
                            action_id: 'crash_analyse',
                            value: action.value,
                        },
                    ],
                },
            ],
            'AI crash analysis ready',
        );
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
    const rm = /^r:([a-f0-9]{12,40})$/i.exec(action.value || '');
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
    const rm = /^r:([a-f0-9]{12,40}):(\d+)$/i.exec(value);
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
                // Copy-paste-ready bug report so the finding can go straight
                // into Jira without digging through the portal logs.
                const b = job.bugReport;
                if (b && (b.summary || b.steps?.length)) {
                    const steps = (b.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
                    await say(
                        `:beetle: *Verdict: PRODUCT_BUG* — the app is broken, not the test. No PR opened; the test was left untouched.\n\n` +
                            `*🐞 Bug report (copy-paste ready):*\n` +
                            `*Summary:* ${b.summary || '(see below)'}\n` +
                            (steps ? `*Steps to reproduce:*\n${steps}\n` : '') +
                            (b.expected ? `*Expected result:* ${b.expected}\n` : '') +
                            (b.actual ? `*Actual result:* ${b.actual}\n` : '') +
                            (b.evidence ? `*Evidence:* ${b.evidence}\n` : '') +
                            `*Spec:* \`${spec}\``,
                    );
                } else {
                    // Older jobs / missing structured fields — fall back to the AI's own summary tail.
                    await say(
                        `:beetle: *Verdict: PRODUCT_BUG* — real app bug, not the test. No PR opened.\n` +
                            `_AI findings:_\n>>> ${(job.healSummary || 'see portal job log').slice(-1200)}`,
                    );
                }
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
    const rm = /^r:([a-f0-9]{12,40}):(\d+)$/i.exec(value);
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
    const ids = [specArg, ...nameParts].filter((s) => /^[a-f0-9]{12,40}$/i.test(s || ''));
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

        // Scheduled scan: real-time-ish auto-threading WITHOUT needing the bot
        // invited to the channel (history reads use the user token). Covers the
        // default channel plus every channel in AUTOFIX_CHANNEL_CONFIG.
        const intervalMin = Number(process.env.SCAN_INTERVAL_MINUTES || 0);
        if (intervalMin > 0) {
            const channels = [...new Set([CHANNEL, ...Object.keys(CHANNEL_CONFIG)].filter(Boolean))];
            const tick = async () => {
                for (const ch of channels) {
                    try {
                        await scanAndThread(app.client, 3, ch);
                    } catch (e) {
                        console.error(`[poll ${ch}] ${e.message}`);
                    }
                }
            };
            setInterval(tick, intervalMin * 60 * 1000);
            console.log(`   Auto-scan: ${channels.join(', ')} every ${intervalMin} min (SCAN_INTERVAL_MINUTES=0 to disable).`);
            tick();
        }
        console.log(`   Portal: ${PORTAL} · Default repo: ${REPO || '(unset)'}${BRANCH ? '@' + BRANCH : ''} · Default channel: ${CHANNEL || '(unset)'}`);
        const mapped = Object.keys(CHANNEL_CONFIG);
        if (mapped.length) console.log(`   Channel map: ${mapped.map((c) => `${c} → ${CHANNEL_CONFIG[c].repo || REPO}`).join(' · ')}`);
        console.log('   Watching for "Cypress Test Reporter" failure reports; will thread a spec picker.');
        console.log('   Manual card:  node scripts/slack-autofix-bot.mjs post <spec-path> [test name]');
    })();
}
