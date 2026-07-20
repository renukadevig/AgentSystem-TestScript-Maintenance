"use client";

import { useMemo, useState } from "react";

/** Used ✓ / Not used ✗ chip with the reason underneath when not used. */
function AgentCell({ verdict }) {
  if (verdict.used) {
    return (
      <span className="wk-chip wk-used" title="Wakeel agent was used">
        ✓ Used
      </span>
    );
  }
  return (
    <div>
      <span className="wk-chip wk-unused">✗ Not used</span>
      {verdict.reason && <div className="wk-reason">{verdict.reason}</div>}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`wk-stat ${tone || ""}`}>
      <div className="wk-stat-v">{value}</div>
      <div className="wk-stat-l">{label}</div>
    </div>
  );
}

const FILTERS = [
  { id: "all", label: "All Stories" },
  { id: "tp-not", label: "Test Plan not used" },
  { id: "au-not", label: "Automation not used" },
  { id: "none", label: "Neither used" },
  { id: "gap", label: "Coverage gaps (eligible)" },
];

export default function WakeelPage() {
  const [projectKeys, setProjectKeys] = useState("APL,CTH,EXT,EB,RMS");
  const [extraJql, setExtraJql] = useState("");
  const [maxIssues, setMaxIssues] = useState(200);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  async function fetchReport() {
    setLoading(true);
    setError("");
    setReport(null);
    try {
      const r = await fetch("/api/wakeel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKeys, extraJql, maxIssues: Number(maxIssues) || 200 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to fetch the report");
      setReport(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const rows = report?.rows || [];
  const filtered = useMemo(() => {
    let out = rows;
    if (filter === "tp-not") out = out.filter((r) => !r.testPlan.used);
    else if (filter === "au-not") out = out.filter((r) => !r.automation.used);
    else if (filter === "none") out = out.filter((r) => !r.testPlan.used && !r.automation.used);
    else if (filter === "gap")
      out = out.filter(
        (r) =>
          (!r.testPlan.used || !r.automation.used) &&
          (r.testPlan.reason.startsWith("Coverage gap") ||
            r.automation.reason.startsWith("Coverage gap"))
      );
    const needle = q.trim().toLowerCase();
    if (needle)
      out = out.filter(
        (r) =>
          r.key.toLowerCase().includes(needle) ||
          (r.summary || "").toLowerCase().includes(needle) ||
          (r.status || "").toLowerCase().includes(needle)
      );
    return out;
  }, [rows, filter, q]);

  function exportCsv() {
    if (!rows.length) return;
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = [
      "Key", "Project", "Summary", "Status", "Reached QA",
      "Test Plan used", "Test Plan reason",
      "Automation used", "Automation reason",
      "Desc chars", "Has AC",
    ];
    const lines = [header.map(esc).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.key, r.project, r.summary, r.status, r.reachedQA ? "yes" : "no",
          r.testPlan.used ? "yes" : "no", r.testPlan.reason,
          r.automation.used ? "yes" : "no", r.automation.reason,
          r.descChars, r.hasAC ? "yes" : "no",
        ].map(esc).join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wakeel-coverage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const s = report?.stats;

  return (
    <div className="wrap">
      <header className="hero" style={{ marginBottom: 18 }}>
        <div className="brand">
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </span>
          <div>
            <h1>
              <span className="brand-name">Wakeel</span>
              <span className="brand-ai"> coverage</span>
            </h1>
          </div>
        </div>
        <a className="link" href="/" style={{ fontSize: 13 }}>← Back to AutoTest.ai</a>
      </header>

      {/* ---- Controls ---- */}
      <div className="panel">
        <div className="panel-head">
          <span className="step">1</span>
          <div>
            <h2>Scope</h2>
            <p className="sub">
              On demand, pull every <b>Story</b> in scope and check whether each Wakeel agent
              (QA Test Plan / QA Automation Author) was used — with the reason when it wasn&apos;t.
            </p>
          </div>
        </div>
        <div className="grid">
          <div className="full">
            <label>Project keys (comma-separated — blank = all projects)</label>
            <input type="text" placeholder="APL,CTH,EXT,EB,RMS" value={projectKeys}
              onChange={(e) => setProjectKeys(e.target.value)} />
          </div>
          <div className="full">
            <label>Extra JQL (optional — e.g. <code>fixVersion = &quot;Sprint 42&quot;</code>)</label>
            <input type="text" placeholder='updated >= -30d' value={extraJql}
              onChange={(e) => setExtraJql(e.target.value)} />
          </div>
          <div>
            <label>Max issues</label>
            <input type="number" min={1} max={500} value={maxIssues}
              onChange={(e) => setMaxIssues(e.target.value)} />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button onClick={fetchReport} disabled={loading}>
              {loading ? "Fetching…" : "↻ Fetch report"}
            </button>
          </div>
        </div>
        {error && <div className="note err">⚠️ {error}</div>}
      </div>

      {/* ---- Results ---- */}
      {report && (
        <div className="panel">
          <div className="status" style={{ marginBottom: 12 }}>
            <span className="dot done" />
            <span>
              {s.total} Stories · Wakeel field: <b>{report.field.name}</b>
              {report.truncated && <span className="muted"> · capped at {report.maxIssues} — narrow the scope for the rest</span>}
            </span>
            <button className="link" style={{ marginLeft: "auto", fontSize: 12 }} onClick={exportCsv}>
              ⬇ Export CSV
            </button>
          </div>

          <div className="wk-stats">
            <Stat label="Test Plan used" value={`${s.testPlanUsed}/${s.total}`} tone="good" />
            <Stat label="Automation used" value={`${s.automationUsed}/${s.total}`} tone="good" />
            <Stat label="Either agent" value={`${s.eitherUsed}/${s.total}`} />
            <Stat label="Both agents" value={`${s.bothUsed}/${s.total}`} />
            <Stat label="Neither agent" value={`${s.noneUsed}/${s.total}`} tone={s.noneUsed ? "bad" : ""} />
          </div>

          {Object.keys(s.reasons || {}).length > 0 && (
            <div className="wk-reasons">
              <span className="section-label">Why agents weren&apos;t used</span>
              <div className="wk-reason-chips">
                {Object.entries(s.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([r, n]) => (
                    <span className="tag" key={r}>{r} <b>· {n}</b></span>
                  ))}
              </div>
            </div>
          )}

          <div className="wk-toolbar">
            <div className="seg">
              {FILTERS.map((fl) => (
                <button key={fl.id} className={filter === fl.id ? "active" : ""}
                  onClick={() => setFilter(fl.id)}>
                  {fl.label}
                </button>
              ))}
            </div>
            <input className="wk-search" type="text" placeholder="Search key / summary / status…"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="wk-tablewrap">
            <table className="wk-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Status</th>
                  <th>QA Test Plan agent</th>
                  <th>QA Automation Author agent</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.key}>
                    <td className="wk-ticket">
                      <a href={r.url} target="_blank" rel="noreferrer">{r.key}</a>
                      <div className="wk-summary">{r.summary}</div>
                      <div className="wk-meta">
                        {r.project} · {r.descChars} chars{r.hasAC ? " · has AC" : " · no AC"}
                      </div>
                    </td>
                    <td>
                      <span className={`wk-status ${r.reachedQA ? "wk-qa" : "wk-preqa"}`}>{r.status}</span>
                    </td>
                    <td><AgentCell verdict={r.testPlan} /></td>
                    <td><AgentCell verdict={r.automation} /></td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ padding: 20, textAlign: "center" }}>No Stories match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style jsx>{`
        .wk-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 4px 0 16px; }
        .wk-stat { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; text-align: center; }
        .wk-stat.good { background: var(--green-soft); border-color: #bfe6cd; }
        .wk-stat.bad { background: var(--red-soft); border-color: #f4c9c9; }
        .wk-stat-v { font-size: 22px; font-weight: 700; }
        .wk-stat-l { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
        .wk-reasons { margin-bottom: 14px; }
        .wk-reason-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
        .wk-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
        .wk-search { flex: 1; min-width: 180px; }
        .wk-tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
        .wk-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .wk-table th { text-align: left; background: var(--surface-2); padding: 10px 12px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); border-bottom: 1px solid var(--border); position: sticky; top: 0; }
        .wk-table td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
        .wk-table tr:last-child td { border-bottom: none; }
        .wk-ticket a { font-weight: 600; }
        .wk-summary { font-size: 12.5px; color: var(--text); margin-top: 2px; max-width: 320px; }
        .wk-meta { font-size: 11px; color: var(--muted); margin-top: 3px; }
        .wk-status { display: inline-block; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
        .wk-status.wk-qa { background: var(--accent-soft); color: var(--accent); }
        .wk-status.wk-preqa { background: var(--amber-soft); color: var(--amber); }
        .wk-chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
        .wk-used { background: var(--green-soft); color: var(--green); }
        .wk-unused { background: var(--red-soft); color: var(--red); }
        .wk-reason { font-size: 11.5px; color: var(--muted); margin-top: 5px; line-height: 1.4; max-width: 300px; }
        .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
        .seg button { border: none; background: var(--surface); padding: 6px 11px; font-size: 12px; cursor: pointer; color: var(--muted); border-right: 1px solid var(--border); }
        .seg button:last-child { border-right: none; }
        .seg button.active { background: var(--accent); color: #fff; }
      `}</style>
    </div>
  );
}
