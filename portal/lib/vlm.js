/**
 * Gemini single-screenshot assessment. For each screenshot we run three
 * independent lenses — UI/UX, Arabic/RTL, and i18n localization — and merge the
 * findings. No baseline needed. Each pass is independent so one bad response
 * never sinks the others.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config, geminiConfigured } from "./config.js";
import {
  UIUX_SYSTEM,
  ARABIC_RTL_SYSTEM,
  I18N_SYSTEM,
  buildScreenshotPrompt,
  buildConsolidatedSystem,
  buildConsolidatedPrompt,
} from "./prompts.js";
import { runCliVlmPass } from "./cliVlm.js";

// The three single-screenshot lenses. All run on every screenshot the funnel
// produced — there is no Figma/baseline to diff against, so each lens reviews
// the screenshot on its own. The Arabic/RTL + i18n prompts self-limit (they say
// so and stop) when a screenshot clearly isn't an Arabic/localized screen.
const ALL_LENSES = [
  { key: "uiux", label: "UI/UX", system: UIUX_SYSTEM },
  { key: "arabic", label: "Arabic/RTL", system: ARABIC_RTL_SYSTEM },
  { key: "i18n", label: "i18n", system: I18N_SYSTEM },
];

// VLM_LENSES (comma list of keys, e.g. "uiux,arabic") restricts which lenses run
// — fewer lenses = fewer Gemini calls per screenshot. Blank = all three.
function activeLenses() {
  const want = (process.env.VLM_LENSES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!want.length) return ALL_LENSES;
  const picked = ALL_LENSES.filter((l) => want.includes(l.key));
  return picked.length ? picked : ALL_LENSES;
}
const LENSES = activeLenses();

function imagePart(img) {
  return { inlineData: { mimeType: "image/png", data: img.b64 } };
}

async function runPass({ system, prompt, image }) {
  const cfg = config();
  if (cfg.openRouterKey) return runPassOpenRouter({ system, prompt, image, cfg });

  // --- Google Gemini direct (legacy path) ---
  const genAI = new GoogleGenerativeAI(cfg.googleApiKey);
  const model = genAI.getGenerativeModel({
    model: cfg.vlmModel,
    systemInstruction: system,
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const resp = await model.generateContent([{ text: prompt }, imagePart(image)]);
  return parseBugs(resp.response.text());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- OpenRouter (OpenAI-compatible) path ---
// One key, many vision models, no Gemini free-tier daily/RPM wall. VLM_MODEL is
// an OpenRouter slug, e.g. "google/gemini-2.5-flash".
// Free-tier (":free") models are shared across everyone on OpenRouter and get
// upstream-rate-limited under load (429, "temporarily rate-limited upstream.
// Please retry shortly") — a few retries with backoff rides that out instead
// of dropping the finding.
async function runPassOpenRouter({ system, prompt, image, cfg }) {
  const MAX_ATTEMPTS = 4;
  const BACKOFF_MS = [2000, 5000, 10000];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vlm-test-hub.local",
        "X-Title": "VLM Test Hub",
      },
      body: JSON.stringify({
        model: cfg.vlmModel,
        temperature: 0.2,
        // Cap output modestly: i18n is consolidated to one finding so responses
        // are short, and a lower cap keeps OpenRouter's upfront credit reservation
        // small (the free-tier allowance shrinks as it's used, and a high cap then
        // 402s). 4000 fits comfortably while avoiding JSON truncation.
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${image.b64}` },
              },
            ],
          },
        ],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return parseBugs(data?.choices?.[0]?.message?.content || "");
    }

    const bodyText = (await res.text()).slice(0, 200);
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    if (res.status === 429 && !isLastAttempt) {
      await sleep(BACKOFF_MS[attempt]);
      continue;
    }
    throw new Error(`OpenRouter ${res.status}: ${bodyText}`);
  }
}

// Local CLI-agent engines (Claude Code / Cursor) run ALL active lenses in one
// consolidated pass per screenshot instead of one process per lens — each spawn
// is a full agent session (slow, and draws on that CLI's own usage quota), so
// fanning out 3x per screenshot the way the hosted-API path does would be
// wasteful and risks tripping the same usage limit Self-heal depends on.
async function assessScreenshotCli(shot, ctx, engine) {
  const state = shot.state || "default";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vlm-shot-"));
  const imagePath = path.join(tmpDir, "screenshot.png");
  const label = engine === "cursor" ? "Cursor" : "Claude";
  try {
    await fs.writeFile(imagePath, Buffer.from(shot.b64, "base64"));
    const system = buildConsolidatedSystem(LENSES);
    const prompt = buildConsolidatedPrompt({
      lensLabels: LENSES.map((l) => l.label),
      specName: ctx.specName,
      targetUrl: ctx.targetUrl,
      screenshotName: shot.name,
      state,
      imagePath,
    });

    let out;
    try {
      out = await runCliVlmPass({ engine, system, prompt, cwd: tmpDir });
    } catch (e) {
      ctx.onLog?.(`  ${label} CLI VLM pass on ${shot.name} failed: ${e.message}`);
      return [];
    }

    const found = parseBugs(out);
    const validLenses = new Set(LENSES.map((l) => l.label));
    for (const b of found) {
      if (!validLenses.has(b.lens)) b.lens = LENSES[0]?.label || "UI/UX";
      b.screenshot_name = shot.name;
    }
    ctx.onLog?.(
      `  ${label} CLI on ${shot.name} (${state}): ${found.length} issue(s) across ${LENSES.length} lens(es).`
    );
    return found;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Assess one screenshot through all applicable lenses.
 * @param shot  { name, b64, state: "default" | "rtl" }
 * @param ctx   { specName, targetUrl, onLog, engine?: "gemini" | "claude" | "cursor" }
 * @returns flat array of bugs, each tagged with .lens
 */
export async function assessScreenshot(shot, ctx = {}) {
  const engine = ctx.engine === "claude" || ctx.engine === "cursor" ? ctx.engine : "gemini";
  if (engine !== "gemini") return assessScreenshotCli(shot, ctx, engine);

  if (!geminiConfigured()) {
    throw new Error("GOOGLE_API_KEY not set — cannot run VLM assessment.");
  }
  const state = shot.state || "default";
  const bugs = [];

  for (const lens of LENSES) {
    try {
      const prompt = buildScreenshotPrompt({
        lens: lens.label,
        specName: ctx.specName,
        targetUrl: ctx.targetUrl,
        screenshotName: shot.name,
        state,
      });
      const found = await runPass({ system: lens.system, prompt, image: shot });
      // Reference the screen by name (the job holds one copy of the image);
      // avoids duplicating a ~250KB base64 blob onto every bug from this screen.
      for (const b of found) { b.lens = lens.label; b.screenshot_name = shot.name; }
      bugs.push(...found);
      ctx.onLog?.(`  ${lens.label} on ${shot.name} (${state}): ${found.length} issue(s).`);
    } catch (e) {
      ctx.onLog?.(`  ${lens.label} on ${shot.name} failed: ${e.message}`);
    }
  }
  return bugs;
}

const SEVERITIES = ["Blocker", "Critical", "Major", "Minor", "Trivial"];

export function parseBugs(raw) {
  let text = (raw || "").trim();
  text = text
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Salvage a truncated response: pull out every complete {...} bug object
    // that did parse, so a cut-off JSON array doesn't lose ALL its findings.
    const salvaged = salvageBugObjects(text);
    if (salvaged.length) return salvaged.map(normalizeBug);
    return [
      {
        id: "PARSE-1",
        title: "VLM returned unparseable output",
        severity: "Minor",
        category: "UX",
        description: "The model response was not valid JSON.",
        steps: ["Re-run the analysis"],
        expected_result: "Structured JSON",
        actual_result: text.slice(0, 500),
        requirement_ref: "",
        screenshot_ref: "",
      },
    ];
  }

  const items = Array.isArray(data) ? data : data.bugs || [];
  return items.map((it, i) => normalizeBug(it, i));
}

function normalizeBug(it, i = 0) {
  return {
    id: it.id || `BUG-${i + 1}`,
    title: it.title || "Untitled",
    severity: SEVERITIES.includes(it.severity) ? it.severity : "Minor",
    category: it.category || "UI",
    description: it.description || "",
    steps: Array.isArray(it.steps) ? it.steps : [],
    expected_result: it.expected_result || "",
    actual_result: it.actual_result || "",
    requirement_ref: it.requirement_ref || "",
    screenshot_ref: it.screenshot_ref || "",
    screenshot_b64: it.screenshot_b64 || "",
  };
}

// Pull every COMPLETE {...} object out of a (possibly truncated) JSON string by
// scanning for balanced braces. Lets a cut-off response keep the bugs that did
// fully serialize instead of discarding the entire lens result.
function salvageBugObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && (obj.title || obj.description)) out.push(obj);
        } catch {
          /* skip this fragment */
        }
        start = -1;
      }
    }
  }
  return out;
}
