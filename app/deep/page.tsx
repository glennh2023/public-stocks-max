"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import styles from "../paper/research.module.css";
import {
  buildMoneyTree,
  huntTreeValue,
  setTreeValue,
  SOURCE_AGENTS,
  type Finding,
  type ResearchRun,
  type SourceStatus,
} from "@/lib/gff-research";
import { buildDeepDesk, DESK_AGENTS, type DeepDeskReport, type DeskAgentStatus } from "@/lib/deep-desk";
import MoneyMap from "@/components/MoneyMap";

// Deep Desk — the combined prototype: Research Brief sourcing (grounded
// sweeps + story-editor gap loop, [n]-cited findings) feeding the Paper
// Writer's structure (parallel analyst sections + lead synthesis with a
// rating), plus the money tree over the same evidence.

const SOURCE_BADGE: Record<Finding["source"], string> = {
  youtube: "▶️ youtube",
  web: "🌐 web",
  news: "📰 news",
  hn: "🗣 hn",
  edgar: "🏛 edgar",
};

const RUNS_KEY = "gff_sandbox_deepdesk_reports";

export default function DeepDeskPage() {
  const [topic, setTopic] = useState("Is Adobe a value trap or a bargain?");
  const [ticker, setTicker] = useState("ADBE");
  const [maxRounds, setMaxRounds] = useState(3);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<SourceStatus>({});
  const [agents, setAgents] = useState<DeskAgentStatus>({});
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<DeepDeskReport | null>(null);
  const [saved, setSaved] = useState<DeepDeskReport[]>([]);
  const [openFinding, setOpenFinding] = useState<number | null>(null);
  const [treeBusy, setTreeBusy] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RUNS_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {}
  }, []);

  const persist = (reports: DeepDeskReport[]) => {
    try { localStorage.setItem(RUNS_KEY, JSON.stringify(reports)); } catch {}
  };

  /** Replace the current report and its saved copy (tree edits mutate it). */
  const commit = useCallback((updated: DeepDeskReport) => {
    const clone = JSON.parse(JSON.stringify(updated)) as DeepDeskReport;
    setReport(clone);
    setSaved((prev) => {
      const next = prev.map((r) => (r.generatedAt === clone.generatedAt ? clone : r));
      persist(next);
      return next;
    });
  }, []);

  const launch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (running || !topic.trim()) return;
    setRunning(true); setError(null); setLog([]); setStatus({}); setAgents({}); setOpenFinding(null);
    try {
      const r = await buildDeepDesk({
        topic,
        ticker: ticker.trim() || undefined,
        maxRounds,
        onStatus: setStatus,
        onAgents: setAgents,
        onLog: (m) => setLog((l) => [...l, m]),
      });
      // Phase 4 — the money tree builds automatically from the desk's evidence
      // (non-fatal: a tree failure still leaves a complete paper, and the
      // "Build money tree" button remains as the retry path).
      try {
        setLog((l) => [...l, "— Phase 4: money tree agent…"]);
        r.run.moneyMap = await buildMoneyTree(r.run, (m) => setLog((l) => [...l, m]));
      } catch (err) {
        setLog((l) => [...l, `⚠ Money tree failed (paper is intact — retry with the button): ${err instanceof Error ? err.message : String(err)}`]);
      }
      setReport(r);
      setSaved((prev) => {
        const next = [r, ...prev].slice(0, 8);
        persist(next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [topic, ticker, maxRounds, running]);

  async function makeTree() {
    if (!report || treeBusy) return;
    setTreeBusy(true); setError(null);
    try {
      const working = JSON.parse(JSON.stringify(report)) as DeepDeskReport;
      working.run.moneyMap = await buildMoneyTree(working.run, (m) => setLog((l) => [...l, m]));
      commit(working);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTreeBusy(false);
    }
  }

  const handleHunt = useCallback(async (path: string[], period: string) => {
    if (!report) return;
    const working = JSON.parse(JSON.stringify(report)) as DeepDeskReport;
    try {
      await huntTreeValue(working.run, path, period, (m) => setLog((l) => [...l, m]));
    } finally {
      commit(working);
    }
  }, [report, commit]);

  const handleSetValue = useCallback((path: string[], period: string, value: string) => {
    if (!report) return;
    const working = JSON.parse(JSON.stringify(report)) as DeepDeskReport;
    setTreeValue(working.run, path, period, value); // throws on invalid input
    commit(working);
  }, [report, commit]);

  const run: ResearchRun | null = report?.run ?? null;

  return (
    <section className={styles.wrapper}>
      <h1 style={{ margin: 0 }}>Deep Desk</h1>
      <p className={styles.hint}>
        The combined prototype: the <b>Research Brief&apos;s sourcing engine</b> (SEC
        XBRL grounding, five parallel source agents, the story-editor gap loop)
        feeds the <b>Paper Writer&apos;s structure</b> — parallel analyst agents each
        write a section of an institutional paper, a lead analyst synthesizes the
        thesis and rating — but here every claim must carry a [n] citation into
        findings that were actually swept, and a dedicated <b>The Story</b> agent
        turns the evidence into a narrative arc. The 💸 money tree runs over the
        same evidence.
      </p>

      <form className={styles.controls} onSubmit={launch}>
        <label className={`${styles.field} ${styles.grow}`}>
          <span>Research question</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder='e.g. "Is Adobe a value trap or a bargain?"' />
        </label>
        <label className={styles.field}>
          <span>Ticker (grounds in SEC XBRL)</span>
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="ADBE" style={{ width: 90 }} maxLength={8} />
        </label>
        <label className={styles.field}>
          <span>Max rounds</span>
          <select className={styles.styleSelect} value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className={styles.buildBtn} type="submit" disabled={running}>
          {running ? "Desk working…" : "Run the desk"}
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
          <div className={styles.savedBar}>
            {DESK_AGENTS.map((a) => {
              const st = agents[a.id] ?? "pending";
              return (
                <span key={a.id}
                  className={`${styles.agentStatus} ${st === "done" ? styles.agentDone : st === "writing" ? styles.agentBusy : ""}`}>
                  {st === "done" ? "✓" : st === "writing" ? "✍" : st === "error" ? "✕" : "·"} {a.label}
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
          <span className={styles.agentRowLabel}>Saved papers:</span>
          {saved.map((r) => (
            <button key={r.generatedAt} className={styles.pdfBtn} type="button"
              style={report?.generatedAt === r.generatedAt ? { borderColor: "var(--accent)" } : undefined}
              onClick={() => setReport(r)}>
              {r.run.topic.slice(0, 32)} · {r.generatedAt.slice(0, 10)}
            </button>
          ))}
          <button className={styles.pdfBtn} type="button"
            onClick={() => { setSaved([]); try { localStorage.removeItem(RUNS_KEY); } catch {} }}>
            Clear
          </button>
        </div>
      )}

      {report && run ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 14, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 14 }}>
            <div className="card" style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>{report.rating.action}</span>
              {report.rating.conviction != null ? (
                <span className="badge">conviction {report.rating.conviction}/5</span>
              ) : null}
              {report.rating.priceTarget != null ? (
                <span className="badge">target ${report.rating.priceTarget.toFixed(2)} · {report.rating.horizonMonths ?? 12}m</span>
              ) : (
                <span className="badge">no price target — evidence gave no price basis</span>
              )}
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{report.rating.rationale}</span>
            </div>

            {run.moneyMap ? (
              <MoneyMap root={run.moneyMap}
                handlers={{ onHunt: handleHunt, onSetValue: handleSetValue, busy: treeBusy }} />
            ) : (
              <div>
                <button className={styles.pdfBtn} type="button" onClick={makeTree} disabled={treeBusy}>
                  {treeBusy ? "Tree agent hunting the numbers…" : "💸 Build money tree from this desk's evidence"}
                </button>
              </div>
            )}

            <div className="card markdown" style={{ fontSize: 14, lineHeight: 1.65 }}>
              <h2 style={{ marginTop: 0 }}>Executive summary</h2>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.executiveSummary}</ReactMarkdown>
              <h2>Thesis</h2>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.thesis}</ReactMarkdown>
              {report.sections.map((s) => (
                <div key={s.id}>
                  <h2>{s.title}</h2>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.markdown}</ReactMarkdown>
                </div>
              ))}
              <p style={{ fontSize: 11, color: "var(--muted)", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                Deep Desk prototype: {report.sections.length} analyst sections over {run.findings.length} cited
                findings{run.factSheet ? " + verified SEC XBRL fact sheet" : ""}. Demo output — not investment advice.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="label" style={{ marginBottom: 8 }}>
              Findings ({run.findings.length}) — the [n] citations
            </div>
            <div style={{ maxHeight: 720, overflowY: "auto" }}>
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
            Enter a research question (and ideally a ticker) and hit Run the
            desk. Phase 1 sources the evidence, phase 2 writes the paper from
            it, phase 3 rates it — watch both agent rows above.
          </p>
        )
      )}
    </section>
  );
}
