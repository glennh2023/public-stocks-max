"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "../paper/research.module.css";
import {
  buildMoneyTree,
  huntTreeValue,
  runResearch,
  setTreeValue,
  SOURCE_AGENTS,
  type Finding,
  type ResearchRun,
  type SourceStatus,
} from "@/lib/gff-research";
import MoneyMap from "@/components/MoneyMap";

// Sandbox port of the StocksMax Research sourcing tool
// (`components/ResearchTool.tsx`): launch a run, watch the source agents
// sweep in parallel, read the cited brief with [n] markers, and browse the
// findings each citation points to.

const SOURCE_BADGE: Record<Finding["source"], string> = {
  youtube: "▶️ youtube",
  web: "🌐 web",
  news: "📰 news",
  hn: "🗣 hn",
  edgar: "🏛 edgar",
};

const RUNS_KEY = "gff_sandbox_research_runs";

export default function ResearchPage() {
  const [topic, setTopic] = useState("NVDA data center demand");
  const [ticker, setTicker] = useState("NVDA");
  const [maxRounds, setMaxRounds] = useState(3);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<SourceStatus>({});
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [saved, setSaved] = useState<ResearchRun[]>([]);
  const [openFinding, setOpenFinding] = useState<number | null>(null);
  const [mapBusy, setMapBusy] = useState(false);

  const persist = (runs: ResearchRun[]) => {
    try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); } catch {}
  };

  /** Replace the current run and its saved copy (hunts/manual edits mutate it). */
  const commitRun = useCallback((updated: ResearchRun) => {
    const clone = JSON.parse(JSON.stringify(updated)) as ResearchRun;
    setRun(clone);
    setSaved((prev) => {
      const next = prev.map((r) => (r.generatedAt === clone.generatedAt ? clone : r));
      persist(next);
      return next;
    });
  }, []);

  async function makeMoneyMap() {
    if (!run || mapBusy) return;
    setMapBusy(true); setError(null);
    try {
      // The tree agent mutates run.findings too (its hunts become citable).
      const working = JSON.parse(JSON.stringify(run)) as ResearchRun;
      working.moneyMap = await buildMoneyTree(working, (m) => setLog((l) => [...l, m]));
      commitRun(working);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMapBusy(false);
    }
  }

  /** Targeted hunt for one tree cell (node + period) from the MoneyMap UI. */
  const handleHunt = useCallback(async (path: string[], period: string) => {
    if (!run) return;
    const working = JSON.parse(JSON.stringify(run)) as ResearchRun;
    try {
      await huntTreeValue(working, path, period, (m) => setLog((l) => [...l, m]));
    } finally {
      commitRun(working); // persist even a not_found — it's the honesty ledger
    }
  }, [run, commitRun]);

  /** Manual value entry for one tree cell — parseMoney-validated (throws). */
  const handleSetValue = useCallback((path: string[], period: string, value: string) => {
    if (!run) return;
    const working = JSON.parse(JSON.stringify(run)) as ResearchRun;
    setTreeValue(working, path, period, value); // throws on invalid input
    commitRun(working);
  }, [run, commitRun]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RUNS_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {}
  }, []);

  const launch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (running || !topic.trim()) return;
    setRunning(true); setError(null); setLog([]); setStatus({}); setOpenFinding(null);
    try {
      const r = await runResearch({
        topic,
        ticker: ticker.trim() || undefined,
        maxRounds,
        onStatus: setStatus,
        onLog: (m) => setLog((l) => [...l, m]),
      });
      setRun(r);
      setSaved((prev) => {
        const next = [r, ...prev].slice(0, 10);
        try { localStorage.setItem(RUNS_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [topic, ticker, maxRounds, running]);

  return (
    <section className={styles.wrapper}>
      <h1 style={{ margin: 0 }}>Research Brief</h1>
      <p className={styles.hint}>
        The StocksMax Research sourcing tool, sandbox edition: a planner
        frames the search angles, parallel source agents sweep Google News, Hacker
        News and SEC EDGAR full-text search, and then the <b>story-editor gap
        loop</b> runs — each round the editor reviews what the findings establish,
        names the gaps, and dispatches new targeted queries — before a writer
        drafts a brief where every claim carries a [n] citation into the findings
        below. Five source agents sweep in parallel: YouTube (analyst videos),
        the web (DuckDuckGo), Google News, Hacker News and SEC EDGAR full-text
        search — with a ticker, the run is grounded first in verified SEC XBRL
        financials. After a run, the 💸 <b>money tree</b> traces where the money
        comes from <i>over time</i>: a dedicated tree agent hunts sizes and
        period history, every node time-travels across quarters/years, and each
        cell is honest about its state — found, n/a (didn&apos;t exist yet), red
        &quot;cannot find&quot; only after actually searching, or not-searched-yet with a
        per-cell 🔍 hunt and validated manual entry. (The full pipeline adds
        YouTube transcript mining, a Reddit agent and per-claim extraction —
        full version only.)
      </p>

      <form className={styles.controls} onSubmit={launch}>
        <label className={`${styles.field} ${styles.grow}`}>
          <span>Topic — a company, ticker, product or question</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder='e.g. "NVDA data center demand" or "Boeing quality control"' />
        </label>
        <label className={styles.field}>
          <span>Ticker (optional — grounds the run in SEC XBRL)</span>
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="e.g. NVDA" style={{ width: 90 }} maxLength={8} />
        </label>
        <label className={styles.field}>
          <span>Max rounds</span>
          <select className={styles.styleSelect} value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
            title="How many sweep → editor-review rounds the gap loop may run before writing.">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className={styles.buildBtn} type="submit" disabled={running}>
          {running ? "Researching…" : "Run research"}
        </button>
      </form>

      {(running || log.length > 0) && (
        <>
          <div className={styles.savedBar}>
            {SOURCE_AGENTS.map((a) => {
              const st = status[a.id] ?? "pending";
              return (
                <span key={a.id}
                  className={`${styles.agentStatus} ${st === "done" ? styles.agentDone : st === "searching" ? styles.agentBusy : ""}`}>
                  {st === "done" ? "✓" : st === "searching" ? "🔎" : st === "error" ? "✕" : st === "empty" ? "∅" : "·"} {a.label}
                </span>
              );
            })}
          </div>
          {log.length > 0 && (
            <div className="card" style={{ maxHeight: 180, overflowY: "auto", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
              {log.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          )}
        </>
      )}
      {error ? <div className={styles.errorBox}>{error}</div> : null}

      {saved.length > 0 && (
        <div className={styles.savedBar}>
          <span className={styles.agentRowLabel}>Saved runs:</span>
          {saved.map((r) => (
            <button key={r.generatedAt} className={styles.pdfBtn} type="button"
              style={run?.generatedAt === r.generatedAt ? { borderColor: "var(--accent)" } : undefined}
              onClick={() => setRun(r)}>
              {r.topic.slice(0, 32)} · {r.generatedAt.slice(0, 10)}
            </button>
          ))}
          <button className={styles.pdfBtn} type="button"
            onClick={() => { setSaved([]); try { localStorage.removeItem(RUNS_KEY); } catch {} }}>
            Clear
          </button>
        </div>
      )}

      {run ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 14, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 14 }}>
          {run.moneyMap ? (
            <MoneyMap root={run.moneyMap}
              handlers={{ onHunt: handleHunt, onSetValue: handleSetValue, busy: mapBusy }} />
          ) : (
            <div>
              <button className={styles.pdfBtn} type="button" onClick={makeMoneyMap} disabled={mapBusy}>
                {mapBusy ? "Tree agent hunting the numbers…" : "💸 Build money tree (trace the revenue, over time)"}
              </button>
            </div>
          )}
          <div className="card markdown" style={{ fontSize: 14, lineHeight: 1.65 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.report}</ReactMarkdown>
            <p style={{ fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              Generated by the limited sandbox from {run.findings.length} findings across{" "}
              {SOURCE_AGENTS.length} public sources. Demo output — not investment advice.
            </p>
          </div>
          </div>

          <div className="card">
            <div className="label" style={{ marginBottom: 8 }}>
              Findings ({run.findings.length}) — the [n] citations
            </div>
            <div style={{ maxHeight: 640, overflowY: "auto" }}>
              {run.findings.map((f) => (
                <div key={f.id} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 13 }}>[{f.id}]</span>
                    <a href={f.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, flex: 1 }}>
                      {f.title}
                    </a>
                  </div>
                  <div className="label">
                    {SOURCE_BADGE[f.source]}{f.published ? ` · ${f.published}` : ""}
                    {" · "}
                    <a href="#" onClick={(e) => { e.preventDefault(); setOpenFinding(openFinding === f.id ? null : f.id); }}>
                      {openFinding === f.id ? "hide" : "details"}
                    </a>
                  </div>
                  {openFinding === f.id && (
                    <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap", marginTop: 4 }}>
                      {f.content.slice(0, 1200)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        !running && (
          <p className={styles.hint}>
            Enter a topic and hit Run research. Sources are keyless and public;
            the writer uses your OpenRouter key from Settings (or the server&apos;s
            dev fallback).
          </p>
        )
      )}
    </section>
  );
}
