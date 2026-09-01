"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "./research.module.css";
import {
  ANALYST_AGENTS,
  fmtMoney,
  fmtPct,
  REPORT_STYLES,
  type ReportStyle,
  type StockReport,
} from "./types";
import { buildReport, type AgentStatus, type ReportDepth } from "@/lib/report";
import { getJSON, setJSON } from "@/lib/settings";

// Sandbox port of the StocksMax Research Report tab: same controls (style
// picker, analyst-agent toggles, client focus), same printed-note layout
// (rating header, sections interleaved with charts, citations, print-to-PDF).
// Grounding is Tiingo-only; EDGAR fundamentals and the proprietary style
// prompts are full-version only.

const PRINT_TOOLTIP = {
  contentStyle: { background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, color: "#111827", fontSize: 12 },
  labelStyle: { color: "#111827", fontWeight: 600 },
} as const;

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
}

function ratingClass(action: string): string {
  if (/buy/i.test(action)) return styles.ratingBuy;
  if (/sell/i.test(action)) return styles.ratingSell;
  return styles.ratingHold;
}

function ReportBody({ report }: { report: StockReport }) {
  const c = report.charts;
  const valuationBars = [
    ...c.valuationModels,
    { label: "Target", value: c.valuationBlended },
  ].filter((b) => b.value != null);

  const chartFor = (sectionId: string) => {
    switch (sectionId) {
      case "business":
        return (
          <figure className={styles.chartFigure}>
            <div className={styles.chartBox}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={c.priceMonthly} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} minTickGap={56} />
                  <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} width={56} domain={["auto", "auto"]} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
                  <Tooltip {...PRINT_TOOLTIP} formatter={(v) => [fmtMoney(Number(v)), "Close"]} />
                  <Line type="monotone" dataKey="close" name="Price" stroke="#1d4ed8" strokeWidth={1.8} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <figcaption className={styles.chartCaption}>
              Figure: {report.symbol} share price, monthly closes (adjusted), 5 years. Source: Tiingo.
            </figcaption>
          </figure>
        );
      case "financials":
        return c.compareSpy.length ? (
          <figure className={styles.chartFigure}>
            <div className={styles.chartBox}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={c.compareSpy} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#6b7280" }} minTickGap={56} />
                  <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} width={46} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
                  <Tooltip {...PRINT_TOOLTIP} formatter={(v, name) => [`${Number(v).toFixed(1)}%`, name]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="stock" name={report.symbol} stroke="#1d4ed8" strokeWidth={1.8} dot={false} />
                  <Line type="monotone" dataKey="spy" name="SPY" stroke="#047857" strokeWidth={1.8} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <figcaption className={styles.chartCaption}>
              Figure: {report.symbol} vs SPY, 2-year total price return, indexed. Source: Tiingo.
            </figcaption>
          </figure>
        ) : null;
      case "valuation":
        return valuationBars.length ? (
          <figure className={styles.chartFigure}>
            <div className={styles.chartBox}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={valuationBars} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#6b7280" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#6b7280" }} width={56} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
                  <Tooltip {...PRINT_TOOLTIP} formatter={(v) => [fmtMoney(Number(v)), "Fair value"]} />
                  {report.price != null ? (
                    <ReferenceLine y={report.price} stroke="#b91c1c" strokeWidth={1.5} strokeDasharray="5 4"
                      label={{ value: `price ${fmtMoney(report.price)}`, position: "insideTopRight", fontSize: 10, fill: "#b91c1c" }} />
                  ) : null}
                  <Bar dataKey="value" name="Fair value" fill="#1d4ed8" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <figcaption className={styles.chartCaption}>
              Figure: scenario fair-value estimates vs the current price (analyst-model output).
            </figcaption>
          </figure>
        ) : null;
      default:
        return null;
    }
  };

  return (
    <>
      <div className={styles.ratingBox}>
        <div className={styles.ratingItem}>
          <span className={styles.ratingLabel}>Rating</span>
          <span className={`${styles.ratingValue} ${ratingClass(report.rating.action)}`}>
            {report.rating.action}
          </span>
        </div>
        <div className={styles.ratingItem}>
          <span className={styles.ratingLabel}>12-mo price target</span>
          <span className={styles.ratingValue}>{fmtMoney(report.rating.priceTarget)}</span>
        </div>
        <div className={styles.ratingItem}>
          <span className={styles.ratingLabel}>Implied upside</span>
          <span className={styles.ratingValue}>{fmtPct(report.rating.upsidePct)}</span>
        </div>
        <div className={styles.ratingItem}>
          <span className={styles.ratingLabel}>Conviction</span>
          <span className={styles.ratingValue}>
            {report.rating.conviction != null ? `${report.rating.conviction}/5` : "—"}
          </span>
        </div>
        <div className={styles.ratingItem}>
          <span className={styles.ratingLabel}>Price (as of {report.asOf})</span>
          <span className={styles.ratingValue}>{fmtMoney(report.price)}</span>
        </div>
      </div>

      <h2 className={styles.sectionTitle}>Executive Summary</h2>
      <Markdown>{report.executiveSummary}</Markdown>

      <h2 className={styles.sectionTitle}>Investment Thesis</h2>
      <Markdown>{report.thesis}</Markdown>

      {report.sections.map((s) => (
        <div key={s.id}>
          <h2 className={styles.sectionTitle}>{s.title}</h2>
          <Markdown>{s.markdown}</Markdown>
          {chartFor(s.id)}
        </div>
      ))}

      {report.rating.rationale ? (
        <p style={{ fontFamily: "system-ui", fontSize: 12.5, color: "#4b5563" }}>
          Rating rationale: {report.rating.rationale}
        </p>
      ) : null}

      <h2 className={styles.sectionTitle}>Sources & Citations</h2>
      <ol className={styles.citationList}>
        {report.citations.map((cit, i) => (
          <li key={i}>
            {cit.url ? <a href={cit.url} target="_blank" rel="noreferrer">{cit.label}</a> : cit.label}
          </li>
        ))}
      </ol>

      <p className={styles.disclaimer}>
        This report was generated by the StocksMax Research LIMITED SANDBOX using Tiingo
        market data, with sections written by AI analyst agents under a grounding policy
        (all figures from the cited data; qualitative commentary is model judgment and
        flagged &quot;to verify&quot; where uncertain). It is a demonstration document, not
        investment advice. The full pipeline additionally grounds reports in SEC EDGAR
        XBRL fundamentals and analyst estimates — that version is not included in this
        sandbox.
      </p>
    </>
  );
}

export default function PaperPage() {
  const [symbol, setSymbol] = useState("GOOGL");
  const [focus, setFocus] = useState("");
  const [style, setStyle] = useState<ReportStyle>("house");
  const [depth, setDepth] = useState<ReportDepth>("standard");
  const [agents, setAgents] = useState<Set<string>>(() => new Set(ANALYST_AGENTS.map((a) => a.id)));
  const [building, setBuilding] = useState(false);
  const [status, setStatus] = useState<AgentStatus>({});
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<StockReport | null>(null);
  const [saved, setSaved] = useState<StockReport[]>([]);

  useEffect(() => {
    const s = getJSON<StockReport[]>("papers", []);
    setSaved(Array.isArray(s) && s.length && "rating" in s[0] ? s : []);
  }, []);

  const toggleAgent = (id: string) => {
    setAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { if (next.size > 1) next.delete(id); } else next.add(id);
      return next;
    });
  };

  const build = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (building || !symbol.trim()) return;
    setBuilding(true); setError(null); setLog([]); setStatus({});
    try {
      const r = await buildReport({
        symbol, focus, style, depth,
        agents: [...agents],
        onStatus: setStatus,
        onLog: (m) => setLog((l) => [...l, m]),
      });
      setReport(r);
      setSaved((prev) => {
        const next = [r, ...prev].slice(0, 15);
        setJSON("papers", next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }, [symbol, focus, style, depth, agents, building]);

  return (
    <section className={styles.wrapper}>
      <h1 style={{ margin: 0 }}>Research Paper Writer</h1>

      <form className={styles.controls} onSubmit={build}>
        <label className={styles.field}>
          <span>Ticker</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="GOOGL" style={{ width: 110 }} />
        </label>
        <label className={`${styles.field} ${styles.grow}`}>
          <span>Client focus (optional — shapes the thesis)</span>
          <textarea rows={1} value={focus} onChange={(e) => setFocus(e.target.value)}
            placeholder='e.g. "Can they win the AI war?" or "income durability over the next decade"' />
        </label>
        <button className={styles.buildBtn} type="submit" disabled={building}>
          {building ? "Writing report…" : "Build research report"}
        </button>
        {report ? (
          <button className={styles.pdfBtn} type="button" onClick={() => window.print()}>
            ⬇ Download PDF
          </button>
        ) : null}
        <div className={styles.agentRow}>
          <span className={styles.agentRowLabel}>Style:</span>
          <select className={styles.styleSelect} value={style}
            onChange={(e) => setStyle(e.target.value as ReportStyle)}
            title={REPORT_STYLES.find((s) => s.id === style)?.hint}>
            {REPORT_STYLES.map((s) => (
              <option key={s.id} value={s.id} title={s.hint}>{s.label}</option>
            ))}
          </select>
          <span className={styles.agentRowLabel}>Depth:</span>
          <select className={styles.styleSelect} value={depth}
            onChange={(e) => setDepth(e.target.value as ReportDepth)}
            disabled={style === "template"}
            title="Deep runs a research round first (planner → staff researcher), adds Industry and Scenarios sections, and writes longer — roughly twice the time and AI usage.">
            <option value="standard">Standard (5 sections)</option>
            <option value="deep">🔬 Deep (research round + 7 sections)</option>
          </select>
          <span className={styles.agentRowLabel}>Analyst agents:</span>
          {ANALYST_AGENTS.map((a) => (
            <label key={a.id} className={styles.agentCheck}
              title={style === "template" ? "Template mode uses fixed sections" : a.hint}
              style={style === "template" ? { opacity: 0.4 } : undefined}>
              <input type="checkbox" checked={agents.has(a.id)} onChange={() => toggleAgent(a.id)}
                disabled={style === "template"} />
              {a.label}
            </label>
          ))}
        </div>
      </form>

      {building ? (
        <>
          <p className={styles.hint}>
            Gathering Tiingo prices, metadata and news, then {agents.size} analyst agents
            write their sections in parallel and a lead analyst synthesizes the thesis,
            rating and price target. (The full version additionally grounds in EDGAR
            fundamentals and estimates.)
          </p>
          <div className={styles.savedBar}>
            {[
              ...ANALYST_AGENTS.filter((a) => agents.has(a.id)),
              ...(depth === "deep"
                ? [{ id: "industry", label: "Industry & Competition" }, { id: "scenarios", label: "Scenarios & Fit" }]
                : []),
            ].map((a) => {
              const st = status[a.id] ?? "pending";
              return (
                <span key={a.id}
                  className={`${styles.agentStatus} ${st === "done" ? styles.agentDone : st === "writing" ? styles.agentBusy : ""}`}>
                  {st === "done" ? "✓" : st === "writing" ? "✎" : st === "error" ? "✕" : "·"} {a.label}
                </span>
              );
            })}
          </div>
          {log.length > 0 && <p className={styles.hint}>{log[log.length - 1]}</p>}
        </>
      ) : null}
      {error ? <div className={styles.errorBox}>{error}</div> : null}

      {saved.length > 0 && (
        <div className={styles.savedBar}>
          <span className={styles.agentRowLabel}>Saved:</span>
          {saved.map((r) => (
            <button key={r.generatedAt} className={styles.pdfBtn} type="button"
              style={report?.generatedAt === r.generatedAt ? { borderColor: "var(--accent)" } : undefined}
              onClick={() => setReport(r)}>
              {r.symbol} · {r.generatedAt.slice(0, 10)}
            </button>
          ))}
          <button className={styles.pdfBtn} type="button"
            onClick={() => { setSaved([]); setJSON("papers", []); }}>
            Clear
          </button>
        </div>
      )}

      {report ? (
        <article className={`${styles.paper} research-paper`}>
          <p className={styles.coverEyebrow}>Equity Research · Company Deep Dive · Sandbox Demo</p>
          <h1 className={styles.coverTitle}>{report.company} ({report.symbol})</h1>
          <p className={styles.coverMeta}>
            Generated {report.generatedAt.slice(0, 10)}
            {focus.trim() ? ` · Focus: ${focus.trim()}` : ""} · StocksMax Research (limited sandbox)
          </p>
          <ReportBody report={report} />
        </article>
      ) : (
        !building && (
          <p className={styles.hint}>
            Enter a ticker for a full-prose company deep dive with charts — pick a style
            (institutional house report with rating + 12-month target, educator, income
            lens, or the no-AI template) and which analyst agents write. Use ⬇ Download
            PDF to print the finished paper. This is the sandbox edition: sections are
            grounded in Tiingo prices and news only; the full version adds EDGAR XBRL
            fundamentals, analyst estimates, peer comps, sensitivity tables and the
            named presenter styles.
          </p>
        )
      )}
    </section>
  );
}
