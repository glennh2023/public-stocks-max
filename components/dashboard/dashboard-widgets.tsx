"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { fetchMeta, fetchNews, fetchPrices, type PricePoint } from "@/lib/tiingo-client";
import { DEFAULT_MODEL, getSetting } from "@/lib/settings";
import { discoverKpiSeries, type KpiSeries } from "@/lib/kpi-source";
import { NewsWidget, NotesWidget, WatchlistWidget } from "../widgets";
import type { Widget, WidgetSpec } from "./dashboard-types";
import { substituteSymbol } from "./dashboard-types";
import styles from "./DashboardGrid.module.css";

// Sandbox ports of the StocksMax dashboard widgets, driven by Tiingo EOD data
// (plus an optional AI summary via the user's OpenRouter key).

const TOOLTIP = {
  contentStyle: {
    background: "var(--panel2)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    fontSize: 12,
  },
  labelStyle: { color: "var(--text)" },
} as const;

const SERIES_COLORS = ["#34d399", "#60a5fa", "#fbbf24", "#f472b6", "#a78bfa"];

// Module-level price cache so several widgets showing the same symbol share
// one Tiingo call (the real app does this with a server-side resolve cache).
const priceCache = new Map<string, Promise<PricePoint[]>>();
function cachedPrices(symbol: string, years: number): Promise<PricePoint[]> {
  const key = `${symbol}:${years}`;
  let p = priceCache.get(key);
  if (!p) {
    p = fetchPrices(symbol, years);
    priceCache.set(key, p);
    p.catch(() => priceCache.delete(key));
    setTimeout(() => priceCache.delete(key), 60_000);
  }
  return p;
}

function usePrices(symbol: string, years: number) {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setPrices([]); setErr("");
    cachedPrices(symbol, years)
      .then((p) => live && setPrices(p))
      .catch((e) => live && setErr(String(e.message || e)));
    return () => { live = false; };
  }, [symbol, years]);
  return { prices, err };
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.widgetCard}>
      <div className={styles.widgetTitle}>{title}</div>
      <div className={styles.widgetBody}>{children}</div>
    </div>
  );
}

function Err({ msg }: { msg: string }) {
  return <div style={{ color: "var(--danger)", fontSize: 13 }}>{msg}</div>;
}
function Loading() {
  return <div style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</div>;
}

const pct = (a: number, b: number) => ((a - b) / b) * 100;
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/* ---------- headline ---------- */

function HeadlineWidget({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: "100%", padding: "0 4px" }}>
      <span style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>
        {text.replace(/^#+\s*/, "")}
      </span>
    </div>
  );
}

/* ---------- price header ---------- */

function PriceHeaderWidget({ symbol }: { symbol: string }) {
  const { prices, err } = usePrices(symbol, 1);
  const [name, setName] = useState("");
  useEffect(() => {
    let live = true;
    setName("");
    fetchMeta(symbol).then((m) => live && setName(m.name)).catch(() => {});
    return () => { live = false; };
  }, [symbol]);

  if (err) return <Card title={`${symbol}`}><Err msg={err} /></Card>;
  if (!prices.length) return <Card title={symbol}><Loading /></Card>;
  const closes = prices.map((p) => p.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  const posPct = ((last - lo) / (hi - lo || 1)) * 100;
  const chg = pct(last, prev);
  return (
    <Card title={`${symbol} · Price header`}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{name || symbol}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 2 }}>
        <span style={{ fontSize: 30, fontWeight: 700 }}>${last.toFixed(2)}</span>
        <span style={{ color: chg >= 0 ? "var(--accent)" : "var(--danger)", fontWeight: 600 }}>
          {chg >= 0 ? "▲" : "▼"} {fmtPct(chg)} 1d
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ height: 6, borderRadius: 3, background: "var(--panel2)", position: "relative" }}>
          <div style={{
            position: "absolute", left: `${posPct}%`, top: -3, width: 3, height: 12,
            background: "var(--accent)", borderRadius: 2,
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          <span>52w low ${lo.toFixed(2)}</span>
          <span>52w high ${hi.toFixed(2)}</span>
        </div>
      </div>
    </Card>
  );
}

/* ---------- price chart ---------- */

function PriceWidget({ symbol, years = 5 }: { symbol: string; years?: number }) {
  const { prices, err } = usePrices(symbol, years);
  if (err) return <Card title={`${symbol} · Price`}><Err msg={err} /></Card>;
  if (!prices.length) return <Card title={`${symbol} · Price`}><Loading /></Card>;
  return (
    <Card title={`${symbol} · Price (${years}y, adjusted)`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={prices} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} minTickGap={56} />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={52}
            domain={["auto", "auto"]} tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
          <Tooltip {...TOOLTIP} formatter={(v) => [`$${Number(v).toFixed(2)}`, "Close"]} />
          <Line type="monotone" dataKey="close" stroke="#34d399" strokeWidth={1.8} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

/* ---------- compare (indexed) ---------- */

function CompareWidget({ symbol, benchmarks, years = 2 }: { symbol: string; benchmarks: string[]; years?: number }) {
  const all = [symbol, ...benchmarks.filter((b) => b !== symbol)];
  const [series, setSeries] = useState<Record<string, PricePoint[]>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    setSeries({}); setErr("");
    all.forEach((s) => {
      cachedPrices(s, years)
        .then((p) => live && setSeries((prev) => ({ ...prev, [s]: p })))
        .catch((e) => live && setErr(String(e.message || e)));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, benchmarks.join(","), years]);

  const title = `${symbol} vs ${benchmarks.join(", ")} · indexed`;
  if (err) return <Card title={title}><Err msg={err} /></Card>;
  const loaded = all.filter((s) => series[s]?.length);
  if (loaded.length < all.length) return <Card title={title}><Loading /></Card>;

  // Index every series to 0% at the common start date.
  const byDate = new Map<string, Record<string, number>>();
  for (const s of all) {
    const base = series[s][0].close;
    for (const p of series[s]) {
      const row = byDate.get(p.date) ?? { };
      row[s] = pct(p.close, base);
      byDate.set(p.date, row);
    }
  }
  const data = [...byDate.entries()]
    .map(([date, row]) => ({ date, ...row }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} minTickGap={56} />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={46} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
          <Tooltip {...TOOLTIP} formatter={(v, n) => [fmtPct(Number(v)), n]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {all.map((s, i) => (
            <Line key={s} type="monotone" dataKey={s} stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={1.8} dot={false} connectNulls />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

/* ---------- stats grid ---------- */

function StatsGridWidget({ symbol }: { symbol: string }) {
  const { prices, err } = usePrices(symbol, 2);
  if (err) return <Card title={`${symbol} · Stats`}><Err msg={err} /></Card>;
  if (!prices.length) return <Card title={`${symbol} · Stats`}><Loading /></Card>;

  const closes = prices.map((p) => p.close);
  const last = closes[closes.length - 1];
  const at = (daysBack: number) => closes[Math.max(0, closes.length - 1 - daysBack)];
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100;
  let peak = closes[0], maxDd = 0;
  for (const c of closes) { peak = Math.max(peak, c); maxDd = Math.min(maxDd, pct(c, peak)); }
  const yr = closes.slice(-253);
  const stats: [string, string, number?][] = [
    ["Last close", `$${last.toFixed(2)}`],
    ["1m return", fmtPct(pct(last, at(21))), pct(last, at(21))],
    ["3m return", fmtPct(pct(last, at(63))), pct(last, at(63))],
    ["1y return", fmtPct(pct(last, at(252))), pct(last, at(252))],
    ["2y return", fmtPct(pct(last, closes[0])), pct(last, closes[0])],
    ["52w high", `$${Math.max(...yr).toFixed(2)}`],
    ["52w low", `$${Math.min(...yr).toFixed(2)}`],
    ["Off 52w high", fmtPct(pct(last, Math.max(...yr))), pct(last, Math.max(...yr))],
    ["Ann. volatility", `${vol.toFixed(1)}%`],
    ["Max drawdown (2y)", fmtPct(maxDd), maxDd],
  ];
  return (
    <Card title={`${symbol} · Stats grid`}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {stats.map(([label, value, tone]) => (
          <div key={label} style={{ background: "var(--panel2)", borderRadius: 6, padding: "6px 10px" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)" }}>{label}</div>
            <div style={{
              fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums",
              color: tone == null ? "var(--text)" : tone >= 0 ? "var(--accent)" : "var(--danger)",
            }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8 }}>
        P/E, margins and growth stats require the fundamentals feed — full version only.
      </div>
    </Card>
  );
}

/* ---------- AI summary ---------- */

function AiSummaryWidget({ symbol }: { symbol: string }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setErr(""); setText("");
    try {
      const [prices, news] = await Promise.all([
        cachedPrices(symbol, 1),
        fetchNews(symbol).catch(() => []),
      ]);
      const last = prices[prices.length - 1];
      const wk = prices[Math.max(0, prices.length - 6)];
      const key = getSetting("openrouter");
      const headlines = news.slice(0, 12).map((n) =>
        `- [${n.publishedDate?.slice(0, 10)}] ${n.title} (${n.source})${n.description ? ` — ${n.description.slice(0, 200)}` : ""}`,
      ).join("\n");
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
        body: JSON.stringify({
          model: getSetting("model") || DEFAULT_MODEL,
          system:
            "You write the AI summary card on a market dashboard. Summarize what actually HAPPENED " +
            "for this stock recently from the headlines provided — themes, not a headline list, and " +
            "not a to-do list. 4-6 markdown bullets, each a concrete takeaway ending with its source " +
            "in parens. Then one final bullet '**Watch:**' with the single most important upcoming " +
            "item. Ground every claim in the provided headlines or price data. No advice.",
          prompt:
            `${symbol}: last close $${last.close.toFixed(2)} on ${last.date} ` +
            `(${fmtPct(pct(last.close, wk.close))} over 5 sessions, ${fmtPct(pct(last.close, prices[0].close))} over 1y).\n\n` +
            `RECENT HEADLINES:\n${headlines || "(none available)"}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setText(data.text);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  return (
    <Card title={`${symbol} · AI summary`}>
      {!text && (
        <button className={styles.btn} onClick={run} disabled={busy}>
          {busy ? "Thinking…" : "✨ Generate summary"}
        </button>
      )}
      {err && <Err msg={err} />}
      {text && <div style={{ fontSize: 13 }} className="markdown"><ReactMarkdown>{text}</ReactMarkdown></div>}
    </Card>
  );
}

/* ---------- KPI Finder (source any metric via Evomi) ---------- */

function fmtKpiVal(v: number, unit: string): string {
  if (unit === "USD") {
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    return `$${v.toFixed(0)}`;
  }
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v}`;
}

const kpiCacheKey = (symbol: string, kpi: string) =>
  `gff_sandbox_kpi_${symbol}_${kpi.toLowerCase().replace(/\s+/g, "-")}`;

function KpiSourceWidget({
  id, symbol, kpi, chartType = "bar", onUpdate,
}: {
  id: string; symbol: string; kpi: string; chartType?: "bar" | "line";
  onUpdate?: (id: string, patch: Partial<WidgetSpec>) => void;
}) {
  const [draft, setDraft] = useState(kpi);
  const [series, setSeries] = useState<KpiSeries | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [log, setLog] = useState("");

  // Restore a cached sourced series (24h) so a reload doesn't re-scrape.
  useEffect(() => {
    setSeries(null); setErr("");
    if (!kpi.trim()) return;
    try {
      const raw = localStorage.getItem(kpiCacheKey(symbol, kpi));
      if (raw) {
        const { at, data } = JSON.parse(raw) as { at: number; data: KpiSeries };
        if (Date.now() - at < 24 * 60 * 60 * 1000) setSeries(data);
      }
    } catch {}
  }, [symbol, kpi]);

  async function source(which: string) {
    const k = which.trim();
    if (!k || busy) return;
    setBusy(true); setErr(""); setLog(""); setSeries(null);
    // Persist the KPI into the widget spec so it reloads with the dashboard.
    if (k !== kpi) onUpdate?.(id, { kpi: k } as Partial<WidgetSpec>);
    try {
      const s = await discoverKpiSeries(symbol, k, setLog);
      setSeries(s);
      try { localStorage.setItem(kpiCacheKey(symbol, k), JSON.stringify({ at: Date.now(), data: s })); } catch {}
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  }

  const title = kpi.trim() ? `${symbol} · ${kpi}` : `${symbol} · KPI Finder`;

  // Config state: no KPI set yet, or user is (re)entering one.
  if (!series && !busy) {
    return (
      <Card title={title}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
          Source <b>any</b> metric over time from the web (via Evomi) — e.g.
          &quot;iPhone revenue&quot;, &quot;AWS net sales&quot;, &quot;data center revenue&quot;.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input" style={{ fontSize: 13 }} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") source(draft); }}
            placeholder="e.g. iPhone revenue" />
          <button className={styles.btn} onClick={() => source(draft)} disabled={!draft.trim()}>🔎 Source it</button>
        </div>
        {err && <div style={{ marginTop: 8 }}><Err msg={err} /></div>}
      </Card>
    );
  }

  if (busy) {
    return (
      <Card title={title}>
        <div className="label">Sourcing… {log}</div>
      </Card>
    );
  }

  const s = series!;
  const data = s.rows.map((r) => ({ label: r.period || r.end.slice(0, 7), val: r.val, end: r.end }));
  const last = s.rows[s.rows.length - 1];

  return (
    <Card title={title}>
     <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {s.unit} · {s.cadence} · {Math.round(s.confidence * 100)}% conf
          {last ? ` · latest ${fmtKpiVal(last.val, s.unit)} (${last.period || last.end})` : ""}
        </div>
        <button className={styles.btn} style={{ padding: "2px 8px", fontSize: 11 }}
          onClick={() => { setSeries(null); setDraft(kpi); }}>edit</button>
      </div>
      <div style={{ flex: 1, minHeight: 110, marginTop: 6 }}>
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "line" ? (
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--muted)" }} minTickGap={24} />
              <YAxis tick={{ fontSize: 9, fill: "var(--muted)" }} width={46} tickFormatter={(v) => fmtKpiVal(Number(v), s.unit)} />
              <Tooltip {...TOOLTIP} formatter={(v) => [fmtKpiVal(Number(v), s.unit), s.kpi]} />
              <Line type="monotone" dataKey="val" stroke="#34d399" strokeWidth={1.8} dot={false} />
            </LineChart>
          ) : (
            <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--muted)" }} minTickGap={16} />
              <YAxis tick={{ fontSize: 9, fill: "var(--muted)" }} width={46} tickFormatter={(v) => fmtKpiVal(Number(v), s.unit)} />
              <Tooltip {...TOOLTIP} formatter={(v) => [fmtKpiVal(Number(v), s.unit), s.kpi]} />
              <Bar dataKey="val" fill="#34d399" radius={[3, 3, 0, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {s.notes ? <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, flexShrink: 0 }}>{s.notes}</div> : null}
      {s.sources.length ? (
        <details style={{ fontSize: 11, marginTop: 4, flexShrink: 0 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)" }}>{s.sources.length} source(s)</summary>
          {s.sources.map((src, i) => (
            <div key={i} style={{ marginTop: 2 }}>
              <a href={src.url} target="_blank" rel="noreferrer">{src.title || src.url}</a>
            </div>
          ))}
        </details>
      ) : null}
     </div>
    </Card>
  );
}

/* ---------- placeholder (locked card) ---------- */

function PlaceholderWidget({ feature, note }: { feature: string; note: string }) {
  return (
    <Card title={`🔒 ${feature}`}>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>
        {note}
        <div style={{ marginTop: 8 }}>
          <span className="badge warn">Full version only</span>
        </div>
      </div>
    </Card>
  );
}

/* ---------- dispatcher ---------- */

export function RenderedWidget({
  widget, symbolOverride, onUpdate,
}: {
  widget: Widget;
  symbolOverride?: string;
  onUpdate?: (id: string, patch: Partial<WidgetSpec>) => void;
}) {
  const sym = (s: string) => substituteSymbol(s, symbolOverride);
  switch (widget.kind) {
    case "headline": return <HeadlineWidget text={widget.text} />;
    case "priceHeader": return <PriceHeaderWidget symbol={sym(widget.symbol)} />;
    case "price": return <PriceWidget symbol={sym(widget.symbol)} years={widget.years} />;
    case "compare": return <CompareWidget symbol={sym(widget.symbol)} benchmarks={widget.benchmarks} years={widget.years} />;
    case "statsGrid": return <StatsGridWidget symbol={sym(widget.symbol)} />;
    case "news": return <Card title={`${sym(widget.symbol)} · News`}><NewsWidget ticker={sym(widget.symbol)} /></Card>;
    case "watchlist": return <Card title="Watchlist"><WatchlistWidget ticker={sym(widget.symbols)} /></Card>;
    case "aiSummary": return <AiSummaryWidget symbol={sym(widget.symbol)} />;
    case "kpiSource": return <KpiSourceWidget id={widget.id} symbol={sym(widget.symbol)} kpi={widget.kpi} chartType={widget.chartType} onUpdate={onUpdate} />;
    case "notes": return <Card title="Sticky notes"><NotesWidget id={widget.id} /></Card>;
    case "placeholder": return <PlaceholderWidget feature={widget.feature} note={widget.note} />;
  }
}
