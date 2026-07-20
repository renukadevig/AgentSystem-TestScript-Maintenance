"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Findings are grouped by lens for scannability.
const LENS_ORDER = ["UI/UX", "Arabic/RTL", "i18n", "Automation"];
const CATEGORY_TO_LENS = {
  UI: "UI/UX",
  UX: "UI/UX",
  Accessibility: "UI/UX",
  Visual: "UI/UX",
  "Arabic/RTL": "Arabic/RTL",
  i18n: "i18n",
  Automation: "Automation",
};
function lensOf(b) {
  return b.lens || CATEGORY_TO_LENS[b.category] || "Other";
}
const SEVERITY_RANK = { Blocker: 0, Critical: 1, Major: 2, Minor: 3, Trivial: 4 };
function groupByLens(bugs) {
  const groups = {};
  for (const b of bugs) (groups[lensOf(b)] ??= []).push(b);
  // Within each lens, surface the most severe defects first.
  for (const l of Object.keys(groups)) {
    groups[l].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5)
    );
  }
  const order = [...LENS_ORDER, ...Object.keys(groups).filter((l) => !LENS_ORDER.includes(l))];
  return order.filter((l) => groups[l]?.length).map((l) => [l, groups[l]]);
}

/** Log console that auto-scrolls to the bottom whenever lines change. */
function LiveLog({ lines, style }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines?.length]);
  return (
    <div className="console" ref={ref} style={style}>
      {(lines || []).join("\n") || "…"}
    </div>
  );
}

/** Small coloured dot showing install/login state. */
function StatusDot({ info }) {
  const installed = info?.installed !== false;
  const loggedIn = info?.loggedIn;
  const color = !installed ? "#cbd5e1" : loggedIn ? "#22c55e" : "#f59e0b";
  const label = !installed ? "not installed" : loggedIn ? "logged in" : "not logged in";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block" }} />
      <span style={{ fontSize: 11, color: "#94a3b8" }}>{label}</span>
    </span>
  );
}

/** One login row inside a CLI card. */
function LoginRow({ label, sublabel, onLogin, disabled, locked }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: locked ? "#94a3b8" : "#334155" }}>{label}</div>
        {sublabel && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{sublabel}</div>}
      </div>
      <button
        className="link"
        style={{ fontSize: 12, whiteSpace: "nowrap", opacity: locked ? 0.4 : 1 }}
        onClick={onLogin}
        disabled={disabled}
        title={locked ? "Not configured" : "Open browser to log in"}
      >
        {locked ? "Not set" : "Login →"}
      </button>
    </div>
  );
}

function BugCard({ b, ctx, jiraEnabled, screenshots, onAutoFix, autoFixBusy }) {
  const [zoom, setZoom] = useState(false);
  const [showShot, setShowShot] = useState(false); // screenshot opens on click
  const [showLog, setShowLog] = useState(false); // log opens on click
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState(null); // { key, url }
  const [fileErr, setFileErr] = useState("");

  // The image lives once on the job, keyed by screen name; bugs reference it.
  const shotB64 =
    (screenshots && b.screenshot_name && screenshots[b.screenshot_name]) ||
    b.screenshot_b64 || // backward-compat with older runs
    "";
  const shotLabel = b.screenshot_name || b.screenshot_ref || "screenshot";

  // Automation failures dump a Cypress stack/log into actual_result. A multi-line
  // or long value is a log — show it behind a "View log" link (a raw wall of text
  // in the card is unreadable). Short values stay inline.
  const actual = b.actual_result || "";
  const isLog = /\n/.test(actual) || actual.length > 160;

  // The spec this failure came from (requirement_ref). Auto-fix only makes
  // sense for a single, resolvable spec path — a multi-spec summary ref isn't
  // something one heal run can fix, so the button is hidden there.
  const specRef = (b.requirement_ref || "").split(",")[0].trim();
  const canAutoFix =
    typeof onAutoFix === "function" &&
    /\.(cy|spec|test)\.[jt]sx?$/i.test(specRef) &&
    !(b.requirement_ref || "").includes(",");

  async function reportToJira() {
    setFileErr("");
    const projectKey = window.prompt(
      "Jira project key to file this bug under (e.g. TRN, CTH):",
      ""
    );
    if (projectKey === null) return; // cancelled
    const key = projectKey.trim().toUpperCase();
    if (!key) {
      setFileErr("Project key is required.");
      return;
    }
    setFiling(true);
    try {
      // Strip any heavy base64 before sending — the API doesn't need it.
      const { screenshot_b64, ...bug } = b;
      void screenshot_b64;
      const r = await fetch("/api/jira", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bug, projectKey: key, ctx }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to file Jira bug");
      setFiled({ key: d.key, url: d.url });
    } catch (e) {
      setFileErr(e.message);
    } finally {
      setFiling(false);
    }
  }

  return (
    <div className="bug">
      <h4>{b.title}</h4>
      <div className="meta">
        <span className={`tag sev-${b.severity}`}>{b.severity}</span>
        <span className="tag">{b.category}</span>
        {b.requirement_ref && <span className="tag">{b.requirement_ref}</span>}
      </div>
      {shotB64 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="link"
            onClick={() => setShowShot((v) => !v)}
            style={{ padding: 0 }}
          >
            📷 {showShot ? "Hide" : "View"} screenshot — {shotLabel}
          </button>
          {showShot && (
            <img
              src={`data:image/png;base64,${shotB64}`}
              alt={shotLabel}
              onClick={() => setZoom((v) => !v)}
              title="Click to enlarge"
              style={{
                width: zoom ? "100%" : 180,
                maxWidth: "100%",
                cursor: "zoom-in",
                borderRadius: 6,
                border: "1px solid #ddd",
                display: "block",
                marginTop: 6,
              }}
            />
          )}
        </div>
      )}
      <div className="row">{b.description}</div>
      {b.steps?.length > 0 && (
        <ol>
          {b.steps.map((s, j) => (
            <li key={j}>{s}</li>
          ))}
        </ol>
      )}
      {b.expected_result && (
        <div className="row">
          <b>Expected: </b>
          {b.expected_result}
        </div>
      )}
      {actual && !isLog && (
        <div className="row">
          <b>Actual: </b>
          {actual}
        </div>
      )}
      {actual && isLog && (
        <div className="row">
          <b>Actual: </b>
          <button
            type="button"
            className="link"
            onClick={() => setShowLog((v) => !v)}
            style={{ padding: 0 }}
          >
            📄 {showLog ? "Hide" : "View"} log
          </button>
          {showLog && <pre className="console" style={{ marginTop: 6 }}>{actual}</pre>}
        </div>
      )}
      <div className="row" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
        {filed ? (
          <span className="tag">
            ✅ Filed{" "}
            <a href={filed.url} target="_blank" rel="noreferrer">
              {filed.key}
            </a>
          </span>
        ) : (
          <button
            className="link"
            onClick={reportToJira}
            disabled={filing || !jiraEnabled}
            title={jiraEnabled ? "" : "Jira not configured"}
          >
            {filing ? "Filing…" : "🐛 Report to Jira"}
          </button>
        )}
        {canAutoFix && (
          <button
            className="link"
            onClick={() => onAutoFix(specRef)}
            disabled={autoFixBusy}
            title={`Rerun ${specRef}, self-heal it with the local CLI, verify, and open a PR`}
          >
            {autoFixBusy ? "Auto-fixing…" : "🔧 Auto-fix & PR"}
          </button>
        )}
        {fileErr && <span className="err">{fileErr}</span>}
      </div>
    </div>
  );
}

export default function Home() {
  const [caps, setCaps] = useState({ gemini: false, jira: false, slack: false, cursor: false, cursorModel: "claude-4.6-sonnet-medium" });
  const [cliStatus, setCliStatus] = useState(null);       // { claude, cursor, cursorModel }
  const [loginSession, setLoginSession] = useState(null); // { sessionId, cli, account, status, log }
  const [loginPolling, setLoginPolling] = useState(false);
  const loginPollRef = useRef(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [prLoading, setPrLoading] = useState(false);
  const [prNote, setPrNote] = useState("");

  const [tree, setTree] = useState(null); // { platforms, tree, repo, branch, ... }
  const [loading, setLoading] = useState(false);

  const [platform, setPlatform] = useState("");
  const [product, setProduct] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [baseUrl, setBaseUrl] = useState("");

  const [vlmEngine, setVlmEngine] = useState("gemini"); // "gemini" | "claude" | "cursor"

  const [job, setJob] = useState(null);
  const [running, setRunning] = useState(false);
  const [runType, setRunType] = useState(""); // which run is active: "automation" | "uiux"
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  // --- self-heal ---
  const [healJob, setHealJob] = useState(null);
  const [healing, setHealing] = useState(false);
  const [healPrompt, setHealPrompt] = useState(""); // optional extra instructions for Claude
  const [healModalOpen, setHealModalOpen] = useState(false);
  const [vlmModalOpen, setVlmModalOpen] = useState(false);

  // Demo mode: the Review PR button can be hidden/shown via the eye toggle
  // next to it; persisted so it survives reloads.
  const [showReviewBtn, setShowReviewBtn] = useState(true);
  useEffect(() => {
    setShowReviewBtn(localStorage.getItem("showReviewPr") !== "0");
  }, []);
  function toggleReviewBtn() {
    setShowReviewBtn((v) => {
      localStorage.setItem("showReviewPr", v ? "0" : "1");
      return !v;
    });
  }

  // Dev-server watchdog: ping the backend; if it stops answering, show a
  // banner with a restart button (served by guard.js on :8082 — the dead
  // server itself can't take the restart request).
  const [serverDown, setServerDown] = useState(false);
  const [restartMsg, setRestartMsg] = useState("");
  useEffect(() => {
    let fails = 0;
    const t = setInterval(async () => {
      try {
        await fetch("/api/products", { method: "HEAD", cache: "no-store" });
        fails = 0;
        setServerDown(false);
      } catch {
        fails += 1;
        if (fails >= 2) setServerDown(true);
      }
    }, 4000);
    return () => clearInterval(t);
  }, []);

  async function restartServer() {
    setRestartMsg("Restarting…");
    try {
      await fetch("http://127.0.0.1:8082/restart", { method: "POST" });
    } catch {
      setRestartMsg(
        "Guard isn't running. In a terminal: cd node-portal && npm run guard (use it instead of npm run dev)."
      );
      return;
    }
    // Wait for the server to come back, then reload for a clean state.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await fetch("/api/products", { cache: "no-store" });
        window.location.reload();
        return;
      } catch {
        /* not up yet */
      }
    }
    setRestartMsg("Server didn't come back after 30s — check the guard terminal.");
  }
  const [healAccount, setHealAccount] = useState(""); // "" default login | "business" | "personal"
  const [healCli, setHealCli] = useState("claude"); // "claude" | "cursor"
  const [committing, setCommitting] = useState(false);
  const [applyingFc, setApplyingFc] = useState(false);
  const healPollRef = useRef(null);

  // --- PR review (draft only — never auto-posted) ---
  const [reviewJob, setReviewJob] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [reviewPrompt, setReviewPrompt] = useState(""); // optional focus notes
  const [reviewAccount, setReviewAccount] = useState("");
  const [reviewCli, setReviewCli] = useState("claude");
  const [draftCopied, setDraftCopied] = useState(false);
  const reviewPollRef = useRef(null);

  const [projectKey, setProjectKey] = useState("");
  const [reportingAll, setReportingAll] = useState(false);
  const [reportAllErr, setReportAllErr] = useState("");

  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then((d) => setCaps(d.capabilities || {}))
      .catch(() => {});
    fetchCliStatus();
    return () => {
      clearInterval(pollRef.current);
      clearInterval(healPollRef.current);
      clearInterval(loginPollRef.current);
      clearInterval(reviewPollRef.current);
    };
  }, []);

  async function fetchCliStatus() {
    try {
      const r = await fetch("/api/cli-auth");
      const d = await r.json();
      setCliStatus(d);
    } catch {}
  }

  async function startLogin(cli, account) {
    setLoginSession({ cli, account, status: "running", log: ["Starting login…"] });
    setLoginPolling(true);
    try {
      const r = await fetch("/api/cli-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cli, account }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to start login");
      const { sessionId } = d;
      loginPollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/cli-auth?sessionId=${sessionId}`);
          const sd = await sr.json();
          setLoginSession((prev) => ({ ...prev, ...sd }));
          if (["done", "error"].includes(sd.status)) {
            clearInterval(loginPollRef.current);
            setLoginPolling(false);
            fetchCliStatus(); // refresh status after login
          }
        } catch {}
      }, 1500);
    } catch (e) {
      setLoginSession((prev) => ({ ...prev, status: "error", log: [e.message] }));
      setLoginPolling(false);
    }
  }

  // ---- derived, all repo-driven ----
  const platforms = tree?.platforms || [];
  const products = useMemo(
    () => (platform && tree ? Object.keys(tree.tree[platform] || {}).sort() : []),
    [platform, tree]
  );
  const funnelSpecs = useMemo(
    () =>
      platform && product && tree ? tree.tree[platform]?.[product] || [] : [],
    [platform, product, tree]
  );

  // strip the `cypress/e2e/<platform>/funnels/<product>/` prefix for a short label
  function shortLabel(spec) {
    const marker = `funnels/${product}/`;
    const i = spec.indexOf(marker);
    return i >= 0 ? spec.slice(i + marker.length) : spec;
  }

  // Resolve a PR link → fill the repo + branch fields from its head branch.
  async function loadPr() {
    setPrNote("");
    setError("");
    if (!prUrl.trim()) return;
    setPrLoading(true);
    try {
      const r = await fetch(`/api/pr?url=${encodeURIComponent(prUrl.trim())}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not resolve PR");
      setRepoUrl(d.repoUrl);
      setBranch(d.branch);
      setPrNote(`PR #${d.number} → ${d.repoUrl} @ ${d.branch}. Now click “Load repo”.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setPrLoading(false);
    }
  }

  async function loadRepo() {
    setError("");
    setTree(null);
    setPlatform("");
    setProduct("");
    setSelected(new Set());
    setLoading(true);
    try {
      const r = await fetch("/api/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, branch }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to load repo");
      setTree(d);
      const p0 = d.platforms?.[0] || "";
      setPlatform(p0);
      const prod0 = p0 ? Object.keys(d.tree[p0] || {}).sort()[0] || "" : "";
      setProduct(prod0);
      // Start with nothing selected — the user opts in to specific scripts.
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function onPlatform(p) {
    setPlatform(p);
    const prod0 = Object.keys(tree.tree[p] || {}).sort()[0] || "";
    setProduct(prod0);
    setSelected(new Set()); // reset selection; user picks
  }

  function onProduct(pr) {
    setProduct(pr);
    setSelected(new Set()); // reset selection; user picks
  }

  function toggle(spec) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(spec) ? next.delete(spec) : next.add(spec);
      return next;
    });
  }
  const allSelected =
    funnelSpecs.length > 0 && funnelSpecs.every((s) => selected.has(s));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(funnelSpecs));
  }

  async function runQA(testType) {
    setError("");
    setJob(null);
    setRunning(true);
    setRunType(testType);
    setProjectKey("");
    setReportAllErr("");
    clearInterval(pollRef.current);
    try {
      const r = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl,
          branch,
          productId: product,
          baseUrl,
          specs: [...selected],
          testType,
          vlmEngine,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start run");
      setJob(d);
      poll(d.jobId);
    } catch (e) {
      setError(e.message);
      setRunning(false);
    }
  }

  function poll(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/test/${jobId}`, { cache: "no-store" });
        if (r.status === 404) {
          // Server restarted — the in-memory job (and its processes) are gone.
          clearInterval(pollRef.current);
          setRunning(false);
          setError("The server restarted mid-run; this run was killed. Start it again.");
          return;
        }
        const d = await r.json();
        setJob(d);
        if (["done", "error", "stopped"].includes(d.status)) {
          clearInterval(pollRef.current);
          setRunning(false);
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
  }

  // Stop whichever run is active (kills its child processes server-side).
  // A 404 means the server restarted and the job is already gone — reset the
  // UI directly, since the poller would otherwise keep showing "running".
  async function stopRun() {
    try {
      if (running && job?.id) {
        const r = await fetch(`/api/test/${job.id}/stop`, { method: "POST" });
        if (r.status === 404) {
          clearInterval(pollRef.current);
          setRunning(false);
          setError("This run no longer exists on the server (it restarted mid-run).");
        }
      }
      if (healing && healJob?.id) {
        const r = await fetch(`/api/heal/${healJob.id}/stop`, { method: "POST" });
        if (r.status === 404) {
          clearInterval(healPollRef.current);
          setHealing(false);
          setError("This heal no longer exists on the server (it restarted mid-run).");
        }
      }
      if (reviewing && reviewJob?.id) {
        const r = await fetch(`/api/review/${reviewJob.id}/stop`, { method: "POST" });
        if (r.status === 404) {
          clearInterval(reviewPollRef.current);
          setReviewing(false);
          setError("This review no longer exists on the server (it restarted mid-run).");
        }
      }
    } catch {
      /* poller will reflect the final state */
    }
  }

  // ---- self-heal: fix the one selected spec via Claude Code, review, commit ----
  async function selfHeal() {
    const spec = [...selected][0];
    if (!spec) return;
    setHealModalOpen(false);
    setError("");
    setHealJob(null);
    setHealing(true);
    clearInterval(healPollRef.current);
    try {
      const r = await fetch("/api/heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, branch, spec, baseUrl, extraPrompt: healPrompt, account: healAccount, cliType: healCli }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start self-heal");
      setHealJob(d);
      pollHeal(d.jobId);
    } catch (e) {
      setError(e.message);
      setHealing(false);
    }
  }

  // ---- one-click auto-fix: rerun the failed spec, self-heal via the local
  //      CLI, re-verify, and open a PR for the fix. Reuses the heal job UI. ----
  async function autoFix(spec) {
    if (!spec || healing || running) return;
    const repo = job?.input?.repoUrl || repoUrl;
    const br = job?.input?.branch || branch;
    if (!repo) {
      setError("No repo for this run — can't auto-fix.");
      return;
    }
    setError("");
    setHealJob(null);
    setHealing(true);
    clearInterval(healPollRef.current);
    try {
      const r = await fetch("/api/heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repo,
          branch: br,
          spec,
          baseUrl,
          account: healAccount,
          cliType: healCli,
          openPr: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start auto-fix");
      setHealJob(d);
      pollHeal(d.jobId);
      // Bring the heal panel into view so the user sees progress immediately.
      if (typeof window !== "undefined") setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }), 50);
    } catch (e) {
      setError(e.message);
      setHealing(false);
    }
  }

  function pollHeal(jobId) {
    healPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/heal/${jobId}`, { cache: "no-store" });
        if (r.status === 404) {
          clearInterval(healPollRef.current);
          setHealing(false);
          setError("The server restarted mid-heal; this run was killed. Start it again.");
          return;
        }
        const d = await r.json();
        setHealJob(d);
        if (["done", "error", "stopped"].includes(d.status)) {
          clearInterval(healPollRef.current);
          setHealing(false);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

  async function approveCommit() {
    if (!healJob?.id) return;
    setCommitting(true);
    setError("");
    try {
      const r = await fetch(`/api/heal/${healJob.id}/commit`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Commit failed");
      setHealJob(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setCommitting(false);
    }
  }

  // Apply a reverify FEATURE_CHANGED finding: commit the AI's test update to a
  // new branch and open a draft PR — only after the human agrees.
  async function applyFeatureChange() {
    if (!healJob?.id) return;
    setApplyingFc(true);
    setError("");
    try {
      const r = await fetch(`/api/heal/${healJob.id}/apply-feature-change`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not apply the feature change");
      setHealJob(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setApplyingFc(false);
    }
  }

  // ---- PR review: AI drafts the review; the human edits + posts it ----
  async function reviewPr() {
    if (!prUrl.trim()) return;
    setReviewModalOpen(false);
    setError("");
    setReviewJob(null);
    setDraftCopied(false);
    setReviewing(true);
    clearInterval(reviewPollRef.current);
    try {
      const r = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prUrl: prUrl.trim(),
          extraPrompt: reviewPrompt,
          account: reviewAccount,
          cliType: reviewCli,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start PR review");
      setReviewJob(d);
      pollReview(d.jobId);
    } catch (e) {
      setError(e.message);
      setReviewing(false);
    }
  }

  function pollReview(jobId) {
    reviewPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/review/${jobId}`, { cache: "no-store" });
        if (r.status === 404) {
          clearInterval(reviewPollRef.current);
          setReviewing(false);
          setError("The server restarted mid-review; this run was killed. Start it again.");
          return;
        }
        const d = await r.json();
        setReviewJob(d);
        if (["done", "error", "stopped"].includes(d.status)) {
          clearInterval(reviewPollRef.current);
          setReviewing(false);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

  async function copyDraft() {
    if (!reviewJob?.reviewDraft) return;
    try {
      await navigator.clipboard.writeText(reviewJob.reviewDraft);
      setDraftCopied(true);
      setTimeout(() => setDraftCopied(false), 2500);
    } catch {
      /* clipboard denied — user can select manually */
    }
  }

  async function reportAllToJira() {
    if (!job) return;
    setReportAllErr("");
    setReportingAll(true);
    try {
      const r = await fetch("/api/jira/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, projectKey: projectKey.trim().toUpperCase() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to report bugs to Jira");
      setJob(d.job);
    } catch (e) {
      setReportAllErr(e.message);
    } finally {
      setReportingAll(false);
    }
  }

  return (
    <div className="wrap">
      {serverDown && (
        <div className="server-down" role="alert">
          <span>
            ⚠ <b>Dev server is down</b> — any run in progress was killed.
          </span>
          <button onClick={restartServer}>Restart server</button>
          {restartMsg && <span className="msg">{restartMsg}</span>}
        </div>
      )}
      <header className="hero">
        <div className="brand">
          <span className="logo-mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="26"
              height="26"
              fill="none"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="8" width="16" height="12" rx="3.5" />
              <path d="M12 8V4.5" />
              <circle cx="12" cy="3.2" r="1.25" fill="#fff" stroke="none" />
              <circle cx="9" cy="13.5" r="1.35" fill="#fff" stroke="none" />
              <circle cx="15" cy="13.5" r="1.35" fill="#fff" stroke="none" />
              <path d="M2.5 13v3M21.5 13v3" />
            </svg>
          </span>
          <div>
            <h1>
              <span className="brand-name">AutoTest</span>
              <span className="brand-ai">.ai</span>
            </h1>
          </div>
        </div>
        <a className="link" href="/wakeel" style={{ fontSize: 13 }}>
          Wakeel coverage →
        </a>
      </header>

      {/* ---- AI CLI Status ---- */}
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>AI CLI</h2>
          <button className="link" style={{ fontSize: 12 }} onClick={fetchCliStatus} disabled={loginPolling}>
            ↻ Refresh status
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

          {/* ── Claude card ── */}
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>🤖</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Claude</span>
              <StatusDot info={cliStatus?.claude} />
            </div>
            <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <LoginRow
                label="Default account"
                sublabel={cliStatus?.claude?.info || ""}
                onLogin={() => startLogin("claude", "")}
                disabled={loginPolling}
              />
              <LoginRow
                label="Business account"
                sublabel={caps.claudeAccounts?.business ? "Config dir set" : "Set CLAUDE_CONFIG_DIR_BUSINESS in .env.local"}
                onLogin={() => startLogin("claude", "business")}
                disabled={loginPolling || !caps.claudeAccounts?.business}
                locked={!caps.claudeAccounts?.business}
              />
              <LoginRow
                label="Personal account"
                sublabel={caps.claudeAccounts?.personal ? "Config dir set" : "Set CLAUDE_CONFIG_DIR_PERSONAL in .env.local"}
                onLogin={() => startLogin("claude", "personal")}
                disabled={loginPolling || !caps.claudeAccounts?.personal}
                locked={!caps.claudeAccounts?.personal}
              />
            </div>
          </div>

          {/* ── Cursor card ── */}
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>⚡</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Cursor</span>
              <StatusDot info={cliStatus?.cursor} />
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>
                {cliStatus?.cursorModel || caps.cursorModel || "claude-4.6-sonnet-medium"}
              </span>
            </div>
            <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              {cliStatus?.cursor?.installed === false ? (
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  <p style={{ margin: "0 0 8px" }}>Cursor CLI not installed. Run this in your terminal:</p>
                  <code style={{ background: "#f1f5f9", padding: "4px 8px", borderRadius: 4, fontSize: 11, display: "block" }}>
                    curl https://cursor.com/install -fsS | bash
                  </code>
                </div>
              ) : (
                <LoginRow
                  label="Cursor account"
                  sublabel={cliStatus?.cursor?.info || ""}
                  onLogin={() => startLogin("cursor", "")}
                  disabled={loginPolling}
                />
              )}
            </div>
          </div>
        </div>

        {/* ── Active login session log ── */}
        {loginSession && (
          <div style={{ marginTop: 14, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`dot ${loginSession.status}`} style={{ width: 8, height: 8, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {loginSession.cli === "cursor" ? "Cursor" : `Claude${loginSession.account ? ` · ${loginSession.account}` : ""}`}
                {" "}login — {loginSession.status}
              </span>
              {loginSession.status === "running" && (
                <span style={{ fontSize: 12, color: "#888" }}>Complete auth in the browser tab…</span>
              )}
              <button className="link" style={{ marginLeft: "auto", fontSize: 12 }} onClick={() => setLoginSession(null)}>
                Dismiss
              </button>
            </div>
            <LiveLog lines={loginSession.log} style={{ maxHeight: 120, fontSize: 12, borderRadius: 0, border: "none" }} />
          </div>
        )}
      </div>

      {/* ---- Step 1: load repo ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="step">1</span>
          <div>
            <h2>Source</h2>
            <p className="sub">Paste a PR link to auto-fill it — or point at a repository directly.</p>
          </div>
        </div>
        <div>
          <label>PR link — fills repo &amp; branch from the PR</label>
          <div style={{ display: "flex", gap: "12px", alignItems: "stretch" }}>
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="https://github.com/tajawal/qa-frontend-cypress/pull/1234"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
            />
            <button
              onClick={loadPr}
              disabled={prLoading || !prUrl.trim()}
              style={{ whiteSpace: "nowrap" }}
            >
              {prLoading ? "Resolving…" : "Load PR"}
            </button>
            {showReviewBtn && (
              <button
                className="btn-heal"
                onClick={() => setReviewModalOpen(true)}
                disabled={reviewing || !prUrl.trim()}
                style={{ whiteSpace: "nowrap" }}
                title="AI drafts a review of this PR — you edit and post it yourself"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 15l2 2 4-4" />
                </svg>
                {reviewing ? "Reviewing…" : "Review PR"}
              </button>
            )}
            <button
              className="eye-toggle"
              onClick={toggleReviewBtn}
              title={showReviewBtn ? "Hide the Review PR button (demo)" : "Show the Review PR button"}
              aria-label={showReviewBtn ? "Hide Review PR button" : "Show Review PR button"}
            >
              {showReviewBtn ? (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94" />
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              )}
            </button>
          </div>
        </div>
        {prNote && <div className="note">🔗 {prNote}</div>}

        <div className="or-divider">OR</div>

        <div className="grid">
          <div className="full">
            <label>GitHub repository URL</label>
            <input
              type="text"
              placeholder="https://github.com/tajawal/qa-frontend-cypress  (or owner/repo)"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
          </div>
          <div>
            <label>Branch (optional)</label>
            <input
              type="text"
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button onClick={loadRepo} disabled={loading || !repoUrl}>
              {loading ? "Loading repo…" : "Load repo"}
            </button>
          </div>
        </div>

        {!caps.gemini && (
          <div className="note">
            ⚠️ GOOGLE_API_KEY is not set — Cypress will run but the VLM
            assessment step will be skipped.
          </div>
        )}
        {error && <div className="note err">⚠️ {error}</div>}
      </div>

      {/* ---- Step 2: platform + product + funnel scripts (repo-driven) ---- */}
      {tree && (
        <div className="panel">
          <div className="panel-head">
            <span className="step">2</span>
            <div>
              <h2>Select &amp; run</h2>
              <p className="sub">
                {tree.repo} @ {tree.branch} · {tree.totalFunnelSpecs} funnel script(s)
                across {platforms.length} platform(s)
              </p>
            </div>
          </div>
          <div className="grid">
            <div>
              <label>Platform</label>
              <select value={platform} onChange={(e) => onPlatform(e.target.value)}>
                {platforms.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Product</label>
              <select value={product} onChange={(e) => onProduct(e.target.value)}>
                {products.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="full" style={{ marginTop: 16 }}>
            <label>
              Base URL override (optional — ORIGIN only, no path/query; blank =
              repo config)
            </label>
            <input
              type="text"
              placeholder="https://almosafer.com  (origin only — specs add their own paths)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="listhead">
              <label style={{ margin: 0 }}>
                Funnel scripts — {platform}/{product} ({funnelSpecs.length})
              </label>
              {funnelSpecs.length > 0 && (
                <button className="link" onClick={toggleAll}>
                  {allSelected ? "Clear all" : "Select all"}
                </button>
              )}
            </div>
            {funnelSpecs.length === 0 ? (
              <p className="muted">No funnel scripts for this selection.</p>
            ) : (
              <div className="scriptlist">
                {funnelSpecs.map((s) => (
                  <label className="scriptrow" key={s} title={s}>
                    <input
                      type="checkbox"
                      checked={selected.has(s)}
                      onChange={() => toggle(s)}
                    />
                    <span>{shortLabel(s)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="actions" style={{ display: "flex", gap: 10 }}>
            <button
              className="btn-test"
              onClick={() => runQA("automation")}
              disabled={running || healing || selected.size === 0}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M8 5v14l11-7z" />
              </svg>
              {running && runType === "automation" ? "Running…" : "Run Test"}
            </button>
            <button
              className="btn-heal"
              onClick={() => setHealModalOpen(true)}
              disabled={healing || running || selected.size !== 1}
              title={selected.size === 1 ? "" : "Select exactly one spec to self-heal"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 3v4M3 5h4M6 17v4M4 19h4" />
                <path d="M13 3l3.5 8.5L24 15l-7.5 3.5L13 27l-3.5-8.5L2 15l7.5-3.5z" transform="scale(0.62) translate(6 2)" />
              </svg>
              {healing ? "Self-healing…" : "Self heal"}
            </button>
            <button
              className="btn-vlm"
              onClick={() => setVlmModalOpen(true)}
              disabled={running || healing || selected.size === 0}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {running && runType === "uiux" ? "Running…" : "Run VLM-ArabicTesting"}
            </button>
            {(running || healing) && (
              <>
                <span className="spacer" />
                <button className="btn-stop" onClick={stopRun}>
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop run
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- Run results ---- */}
      {job && (
        <div className="panel">
          <div className="status">
            <span className={`dot ${job.status}`} />
            <span>
              Run {job.id} — {job.status}
            </span>
            <button
              className="link"
              style={{ marginLeft: "auto", fontSize: 12, color: "#888" }}
              onClick={() => { setJob(null); clearInterval(pollRef.current); setRunning(false); setRunType(""); }}
              title="Clear results"
            >
              ✕ Clear
            </button>
          </div>

          {job.cypress && !job.cypress.error && (
            <div className="summary" style={{ marginTop: 12 }}>
              <span>
                <b>{job.cypress.totalPassed ?? 0}</b> passed
              </span>
              <span>
                <b>{job.cypress.totalFailed ?? 0}</b> failed
              </span>
              {typeof job.cypress.totalTests === "number" && (
                <span>
                  <b>{job.cypress.totalTests}</b> total
                </span>
              )}
              {typeof job.cypress.exitCode === "number" && (
                <span className="muted">exit {job.cypress.exitCode}</span>
              )}
            </div>
          )}
          {job.cypress?.loadError && (
            <div className="note err">
              ⚠ Cypress ran, but the app didn't load — <b>{job.cypress.loadError}</b>.
              The funnel can't execute against a blocked page. Set a reachable{" "}
              <b>Base URL</b> (e.g. production) or run on VPN, then re-run.
            </div>
          )}
          {job.cypress?.error && (
            <div className="note err">Cypress: {job.cypress.error}</div>
          )}

          <div style={{ marginTop: 14 }}>
            <label>Log</label>
            <LiveLog lines={job.log} />
          </div>

          <h3 style={{ marginTop: 20 }}>
            Findings {job.totalBugs ? `(${job.totalBugs})` : ""}
          </h3>
          {(!job.bugs || job.bugs.length === 0) && job.status === "done" && (
            <p className="muted">No bugs reported. 🎉</p>
          )}
          {job.bugs?.length > 0 && (
            <div
              className="row"
              style={{ display: "flex", gap: 10, alignItems: "center", margin: "8px 0 16px" }}
            >
              <input
                type="text"
                placeholder="Jira project key (e.g. TRN)"
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                style={{ maxWidth: 220 }}
              />
              <button
                className="primary"
                onClick={reportAllToJira}
                disabled={reportingAll || !caps.jira || !projectKey.trim()}
                title={caps.jira ? "" : "Jira not configured"}
              >
                {reportingAll ? "Reporting…" : `🐛 Report to Jira (${job.bugs.length})`}
              </button>
              {reportAllErr && <span className="err">{reportAllErr}</span>}
            </div>
          )}
          {groupByLens(job.bugs || []).map(([lens, items]) => (
            <div className="lensgroup" key={lens}>
              <h4 className="lenshead">
                <span className={`lensdot lens-${lens.replace(/[^a-z]/gi, "")}`} />
                {lens} <span className="lenscount">({items.length})</span>
              </h4>
              {items.map((b, i) => (
                <BugCard
                  b={b}
                  key={`${b.id}-${i}`}
                  jiraEnabled={caps.jira}
                  screenshots={job.screenshots}
                  onAutoFix={lens === "Automation" ? autoFix : undefined}
                  autoFixBusy={healing || running}
                  ctx={{
                    repoUrl: job.input?.repoUrl,
                    branch: job.input?.branch,
                    productId: job.input?.productId,
                    specName: b.requirement_ref,
                  }}
                />
              ))}
            </div>
          ))}

          {job.dispatched?.length > 0 && (
            <div className="dispatched" style={{ marginTop: 16 }}>
              <h3>Dispatched</h3>
              <ul>
                {job.dispatched.map((d, i) => (
                  <li key={i}>
                    {d.target === "jira" && d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer">
                        {d.key}
                      </a>
                    ) : (
                      <span>{d.target}</span>
                    )}{" "}
                    — {d.bug}
                    {d.error && <span className="err"> ({d.error})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ---- Self-heal results + approve/commit ---- */}
      {healJob && (
        <div className="panel">
          <div className="status">
            <span className={`dot ${healJob.status}`} />
            <span>
              {healJob.input?.openPr ? "Auto-fix & PR" : "Self-heal"} {healJob.id} — {healJob.status}
              {healJob.verdict ? ` · ${healJob.verdict}` : ""}
            </span>
            <button
              className="link"
              style={{ marginLeft: "auto", fontSize: 12, color: "#888" }}
              onClick={() => { setHealJob(null); clearInterval(healPollRef.current); setHealing(false); }}
              title="Clear results"
            >
              ✕ Clear
            </button>
          </div>

          {healJob.error && <div className="note err">{healJob.error}</div>}

          <div style={{ marginTop: 14 }}>
            <label>Log</label>
            <LiveLog lines={healJob.log} style={{ maxHeight: 360 }} />
          </div>

          {/* ── Heal loop progress ── */}
          {healJob.healLoops?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label>Fix loops ({healJob.healLoops.length} / 3)</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
                {healJob.healLoops.map((loop) => {
                  const passed = loop.cypressPassed;
                  const isBug = loop.verdict === "PRODUCT_BUG";
                  const bg = passed ? "#dcfce7" : isBug ? "#fef3c7" : "#fee2e2";
                  const fg = passed ? "#15803d" : isBug ? "#92400e" : "#b91c1c";
                  const border = passed ? "#86efac" : isBug ? "#fde68a" : "#fca5a5";
                  const failures = loop.cypressSummary?.failures || [];
                  const logTail = loop.cypressSummary?.logTail || "";
                  return (
                    <div key={loop.attempt} style={{ border: `1px solid ${border}`, borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ padding: "6px 12px", background: bg, color: fg, fontWeight: 600, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                        <span>{passed ? "✅" : "❌"} Attempt {loop.attempt} — {loop.verdict}</span>
                        {loop.cypressSummary?.totalPassed != null && (
                          <span style={{ fontWeight: 400 }}>
                            ({loop.cypressSummary.totalPassed} passed, {loop.cypressSummary.totalFailed ?? 0} failed)
                          </span>
                        )}
                      </div>
                      {!passed && (failures.length > 0 || logTail) && (
                        <div className="console" style={{ maxHeight: 200, fontSize: 11.5, borderRadius: 0, border: "none", borderTop: `1px solid ${border}` }}>
                          {failures.length > 0
                            ? failures.map((f, i) => `✗ ${f.title}\n  ${f.error}`).join("\n\n")
                            : logTail.slice(-1500)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {healJob.healSummary && (
            <div style={{ marginTop: 14 }}>
              <label>{healJob.cliUsed ? `${healJob.cliUsed} summary` : "AI summary"}</label>
              <div className="console" style={{ whiteSpace: "pre-wrap" }}>
                {healJob.healSummary}
              </div>
            </div>
          )}

          {/* ── Reverify finding: recent feature change, not a product bug ── */}
          {healJob.verdict === "FEATURE_CHANGED" && (
            <div
              style={{
                marginTop: 14,
                border: "1px solid #fde68a",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "8px 12px",
                  background: "#fef3c7",
                  color: "#92400e",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                🔁 Reverify finding: not a product bug — a recent feature change
              </div>
              <div style={{ padding: 12, fontSize: 13, lineHeight: 1.5 }}>
                <p style={{ marginTop: 0 }}>
                  This first looked like a product bug, so the {healJob.input?.framework === "playwright" ? "Playwright" : "Cypress"} runner was
                  run once to reverify. The finding: the feature still works but changed recently,
                  so the test was out of date — not an app bug.
                </p>
                {healJob.featureChange?.summary && (
                  <p style={{ margin: "6px 0" }}>
                    <strong>What changed:</strong> {healJob.featureChange.summary}
                  </p>
                )}
                {healJob.featureChange?.reason && (
                  <p style={{ margin: "6px 0" }}>
                    <strong>Why it&apos;s not a bug:</strong> {healJob.featureChange.reason}
                  </p>
                )}
                {healJob.bugReverify && (
                  <p style={{ margin: "6px 0", color: "#666" }}>
                    <strong>Reverify run:</strong>{" "}
                    {healJob.bugReverify.loadError
                      ? `could not reach the app (${healJob.bugReverify.loadError})`
                      : `${healJob.bugReverify.totalPassed} passed, ${healJob.bugReverify.totalFailed} failed`}
                  </p>
                )}
                <p style={{ margin: "6px 0 0", color: "#666" }}>
                  Review the proposed test update in the diff below, then agree to apply it and open a PR.
                </p>
              </div>
            </div>
          )}

          {healJob.changedFiles?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <label>Changed files ({healJob.changedFiles.length})</label>
              <ul>
                {healJob.changedFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {healJob.diff && (
            <div style={{ marginTop: 14 }}>
              <label>Diff (review before committing)</label>
              <pre
                className="console"
                style={{ maxHeight: 420, overflow: "auto", whiteSpace: "pre" }}
              >
                {healJob.diff}
              </pre>
            </div>
          )}

          {healJob.prError && (
            <div className="note err" style={{ marginTop: 12 }}>
              PR could not be opened: {healJob.prError}. The diff above is ready — you can still Commit &amp; push manually.
            </div>
          )}

          {healJob.status === "done" && (
            <div
              className="row"
              style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}
            >
              {healJob.pr ? (
                <span className="tag">
                  ✅ {healJob.pr.draft ? "Draft PR" : "PR"} #{healJob.pr.number} opened (
                  {healJob.pr.branch} → {healJob.pr.base}) —{" "}
                  <a href={healJob.pr.url} target="_blank" rel="noreferrer">
                    view on GitHub
                  </a>
                  {healJob.pr.draft ? " · review, then mark ready to merge" : ""}
                </span>
              ) : healJob.committed ? (
                <span className="tag">
                  ✅ {healJob.verdict === "FEATURE_CHANGED" ? "Feature-change update applied" : "Committed & pushed"} to{" "}
                  {healJob.verdict === "FEATURE_CHANGED" ? "a new PR branch" : healJob.input?.branch || "the branch"}
                </span>
              ) : healJob.verdict === "FEATURE_CHANGED" && healJob.changedFiles?.length > 0 ? (
                <button className="primary" onClick={applyFeatureChange} disabled={applyingFc}>
                  {applyingFc
                    ? "Applying…"
                    : "Agree to apply for feature change (open PR)"}
                </button>
              ) : healJob.changedFiles?.length > 0 ? (
                <button className="primary" onClick={approveCommit} disabled={committing}>
                  {committing
                    ? "Committing…"
                    : `Commit & push to branch (${healJob.changedFiles.length} file${
                        healJob.changedFiles.length === 1 ? "" : "s"
                      })`}
                </button>
              ) : healJob.verdict === "PRODUCT_BUG" ? (
                <span className="err">
                  Real product bug — nothing to commit. See the summary above.
                </span>
              ) : (
                <span className="muted">No changes were made.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---- PR review results ---- */}
      {reviewJob && (
        <div className="panel">
          <div className="status">
            <span className={`dot ${reviewJob.status}`} />
            <span>
              PR review {reviewJob.id} — {reviewJob.status}
              {reviewJob.reviewVerdict ? ` · ${reviewJob.reviewVerdict}` : ""}
            </span>
            {reviewing && (
              <button
                className="link"
                style={{ marginLeft: "auto", fontSize: 12, color: "#b91c1c" }}
                onClick={() => fetch(`/api/review/${reviewJob.id}/stop`, { method: "POST" }).catch(() => {})}
              >
                ■ Stop
              </button>
            )}
            <button
              className="link"
              style={{ marginLeft: reviewing ? 0 : "auto", fontSize: 12, color: "#888" }}
              onClick={() => { setReviewJob(null); clearInterval(reviewPollRef.current); setReviewing(false); }}
              title="Clear results"
            >
              ✕ Clear
            </button>
          </div>

          {reviewJob.pr && (
            <div className="summary" style={{ marginTop: 12, flexWrap: "wrap" }}>
              <span>
                <a href={reviewJob.pr.url} target="_blank" rel="noreferrer">
                  <b>#{reviewJob.pr.number}</b>
                </a>{" "}
                {reviewJob.pr.title}
              </span>
              <span className="muted">
                @{reviewJob.pr.author} · {reviewJob.pr.headRef} → {reviewJob.pr.baseRef} ·{" "}
                {reviewJob.pr.changedFiles} file(s) +{reviewJob.pr.additions}/−{reviewJob.pr.deletions}
              </span>
            </div>
          )}

          {reviewJob.error && <div className="note err">{reviewJob.error}</div>}

          <div style={{ marginTop: 14 }}>
            <label>Log</label>
            <LiveLog lines={reviewJob.log} style={{ maxHeight: 220 }} />
          </div>

          {reviewJob.reviewDraft && (
            <div style={{ marginTop: 14 }}>
              <div className="listhead">
                <label style={{ margin: 0 }}>
                  Draft review{reviewJob.cliUsed ? ` — ${reviewJob.cliUsed}` : ""}
                  {reviewJob.reviewVerdict && (
                    <span
                      className="tag"
                      style={{
                        marginLeft: 8,
                        background:
                          reviewJob.reviewVerdict === "APPROVE"
                            ? "#dcfce7"
                            : reviewJob.reviewVerdict === "REQUEST_CHANGES"
                            ? "#fee2e2"
                            : "#fef3c7",
                        color:
                          reviewJob.reviewVerdict === "APPROVE"
                            ? "#15803d"
                            : reviewJob.reviewVerdict === "REQUEST_CHANGES"
                            ? "#b91c1c"
                            : "#92400e",
                      }}
                    >
                      {reviewJob.reviewVerdict}
                      {reviewJob.reviewBlockers > 0 ? ` · ${reviewJob.reviewBlockers} blocking` : ""}
                    </span>
                  )}
                </label>
                <button className="link" onClick={copyDraft}>
                  {draftCopied ? "✅ Copied" : "📋 Copy draft"}
                </button>
              </div>
              <pre
                className="console"
                style={{ maxHeight: 520, overflow: "auto", whiteSpace: "pre-wrap", marginTop: 8 }}
              >
                {reviewJob.reviewDraft}
              </pre>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Draft only — nothing was posted to GitHub. Edit it (fill the OWNER
                placeholders with real @mentions), then paste it on the PR.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---- Self-heal prompt modal ---- */}
      {healModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setHealModalOpen(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Self-heal</h3>
            <p className="sub">
              Repairing <b>{shortLabel([...selected][0] || "")}</b>. Choose which AI
              CLI to run, then optionally add instructions.
            </p>

            <label>AI CLI</label>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className={healCli === "claude" ? "on" : ""}
                onClick={() => setHealCli("claude")}
              >
                Claude
              </button>
              <button
                type="button"
                className={healCli === "cursor" ? "on" : ""}
                onClick={() => setHealCli("cursor")}
                disabled={!caps.cursor}
                title={caps.cursor ? `Cursor CLI · ${caps.cursorModel}` : "Cursor CLI not found — install it: curl https://cursor.com/install -fsS | bash"}
              >
                Cursor {caps.cursor ? `· ${caps.cursorModel}` : "(not installed)"}
              </button>
            </div>

            {healCli === "claude" && (
              <>
                <label>Claude account</label>
                <div className="seg" style={{ marginBottom: 14 }}>
                  <button
                    type="button"
                    className={healAccount === "" ? "on" : ""}
                    onClick={() => setHealAccount("")}
                  >
                    Default login
                  </button>
                  <button
                    type="button"
                    className={healAccount === "business" ? "on" : ""}
                    onClick={() => setHealAccount("business")}
                    disabled={!caps.claudeAccounts?.business}
                    title={caps.claudeAccounts?.business ? "" : "Set CLAUDE_CONFIG_DIR_BUSINESS in .env.local"}
                  >
                    Business{caps.claudeAccounts?.business ? "" : " (not set)"}
                  </button>
                  <button
                    type="button"
                    className={healAccount === "personal" ? "on" : ""}
                    onClick={() => setHealAccount("personal")}
                    disabled={!caps.claudeAccounts?.personal}
                    title={caps.claudeAccounts?.personal ? "" : "Set CLAUDE_CONFIG_DIR_PERSONAL in .env.local"}
                  >
                    Personal{caps.claudeAccounts?.personal ? "" : " (not set)"}
                  </button>
                </div>
              </>
            )}

            <label>Extra instructions (optional)</label>
            <textarea
              rows={4}
              autoFocus
              placeholder="e.g. “the login modal moved to a new selector”, “focus on the payment step”, “don't touch the intercepts”."
              value={healPrompt}
              onChange={(e) => setHealPrompt(e.target.value)}
              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
            />
            <div className="modal-actions">
              <button className="link" onClick={() => setHealModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-heal" onClick={selfHeal}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3v4M3 5h4M6 17v4M4 19h4" />
                  <path d="M13 3l3.5 8.5L24 15l-7.5 3.5L13 27l-3.5-8.5L2 15l7.5-3.5z" transform="scale(0.62) translate(6 2)" />
                </svg>
                Start self-heal
              </button>
            </div>
          </div>
        </div>
      )}

      {vlmModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setVlmModalOpen(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Run VLM-ArabicTesting</h3>
            <p className="sub">
              Assessing <b>{selected.size}</b> funnel script(s). Choose which VLM engine to run.
            </p>

            <label>VLM engine</label>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className={vlmEngine === "gemini" ? "on" : ""}
                onClick={() => setVlmEngine("gemini")}
                disabled={!caps.gemini}
                title={caps.gemini ? "" : "Set GOOGLE_API_KEY or OPENROUTER_API_KEY in .env.local"}
              >
                Gemini/OpenRouter {caps.gemini ? "" : "(not configured)"}
              </button>
              <button
                type="button"
                className={vlmEngine === "claude" ? "on" : ""}
                onClick={() => setVlmEngine("claude")}
              >
                Claude CLI
              </button>
              <button
                type="button"
                className={vlmEngine === "cursor" ? "on" : ""}
                onClick={() => setVlmEngine("cursor")}
                disabled={!caps.cursor}
                title={caps.cursor ? `Cursor CLI · ${caps.cursorModel}` : "Cursor CLI not found — install it: curl https://cursor.com/install -fsS | bash"}
              >
                Cursor {caps.cursor ? `· ${caps.cursorModel}` : "(not installed)"}
              </button>
            </div>
            {vlmEngine !== "gemini" && (
              <p className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 12 }}>
                {vlmEngine === "claude" ? "Claude CLI" : "Cursor CLI"} runs one consolidated pass
                (all lenses) per screenshot via your local CLI subscription — no OpenRouter/Gemini
                key needed, but slower per screenshot.
              </p>
            )}

            <div className="modal-actions">
              <button className="link" onClick={() => setVlmModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-vlm"
                onClick={() => {
                  setVlmModalOpen(false);
                  runQA("uiux");
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Start VLM test
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- PR review modal ---- */}
      {reviewModalOpen && (
        <div className="modal-overlay" onClick={() => setReviewModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Review PR</h3>
            <p className="sub">
              The AI clones the PR's head branch, cross-checks the description
              against the diff, greps the repo for hidden assumptions and broken
              references, and produces a <b>draft review</b> for you to edit and
              post — nothing is sent to GitHub.
            </p>

            <label>AI CLI</label>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className={reviewCli === "claude" ? "on" : ""}
                onClick={() => setReviewCli("claude")}
              >
                Claude
              </button>
              <button
                type="button"
                className={reviewCli === "cursor" ? "on" : ""}
                onClick={() => setReviewCli("cursor")}
                disabled={!caps.cursor}
                title={caps.cursor ? `Cursor CLI · ${caps.cursorModel}` : "Cursor CLI not found — install it: curl https://cursor.com/install -fsS | bash"}
              >
                Cursor {caps.cursor ? `· ${caps.cursorModel}` : "(not installed)"}
              </button>
            </div>

            {reviewCli === "claude" && (
              <>
                <label>Claude account</label>
                <div className="seg" style={{ marginBottom: 14 }}>
                  <button
                    type="button"
                    className={reviewAccount === "" ? "on" : ""}
                    onClick={() => setReviewAccount("")}
                  >
                    Default login
                  </button>
                  <button
                    type="button"
                    className={reviewAccount === "business" ? "on" : ""}
                    onClick={() => setReviewAccount("business")}
                    disabled={!caps.claudeAccounts?.business}
                    title={caps.claudeAccounts?.business ? "" : "Set CLAUDE_CONFIG_DIR_BUSINESS in .env.local"}
                  >
                    Business{caps.claudeAccounts?.business ? "" : " (not set)"}
                  </button>
                  <button
                    type="button"
                    className={reviewAccount === "personal" ? "on" : ""}
                    onClick={() => setReviewAccount("personal")}
                    disabled={!caps.claudeAccounts?.personal}
                    title={caps.claudeAccounts?.personal ? "" : "Set CLAUDE_CONFIG_DIR_PERSONAL in .env.local"}
                  >
                    Personal{caps.claudeAccounts?.personal ? "" : " (not set)"}
                  </button>
                </div>
              </>
            )}

            <label>Focus notes (optional)</label>
            <textarea
              rows={4}
              autoFocus
              placeholder="e.g. “this touches the AB-testing helper — check it holds for payments”, “the skills hard-code file paths, verify refs”."
              value={reviewPrompt}
              onChange={(e) => setReviewPrompt(e.target.value)}
              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
            />
            <div className="modal-actions">
              <button className="link" onClick={() => setReviewModalOpen(false)}>
                Cancel
              </button>
              <button className="btn-heal" onClick={reviewPr}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M9 15l2 2 4-4" />
                </svg>
                Start review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
