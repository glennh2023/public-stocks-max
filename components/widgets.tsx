"use client";

import { useEffect, useState } from "react";
import Sparkline from "./Sparkline";
import {
  fetchMeta,
  fetchNews,
  fetchPrices,
  type NewsItem,
  type PricePoint,
} from "@/lib/tiingo-client";

// Sample widget library for the customizable dashboard. Each widget is a small
// self-contained card that pulls its own Tiingo data.

export type WidgetType = "quote" | "chart" | "news" | "watchlist" | "notes";

export type WidgetConfig = {
  id: string;
  type: WidgetType;
  ticker: string; // for watchlist: comma-separated; for notes: unused
};

export const WIDGET_TYPES: { type: WidgetType; label: string; needsTicker: boolean }[] = [
  { type: "quote", label: "Quote card", needsTicker: true },
  { type: "chart", label: "Price chart (2y)", needsTicker: true },
  { type: "news", label: "News feed", needsTicker: true },
  { type: "watchlist", label: "Watchlist", needsTicker: true },
  { type: "notes", label: "Sticky notes", needsTicker: false },
];

function ErrBox({ msg }: { msg: string }) {
  return <div style={{ color: "var(--danger)", fontSize: 13 }}>{msg}</div>;
}

function last(prices: PricePoint[]) {
  return prices[prices.length - 1];
}

function pct(a: number, b: number) {
  return (((a - b) / b) * 100).toFixed(2);
}

export function QuoteWidget({ ticker }: { ticker: string }) {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    fetchPrices(ticker, 1)
      .then((p) => live && setPrices(p))
      .catch((e) => live && setErr(String(e.message || e)));
    fetchMeta(ticker)
      .then((m) => live && setName(m.name))
      .catch(() => {});
    return () => { live = false; };
  }, [ticker]);

  if (err) return <ErrBox msg={err} />;
  if (!prices.length) return <div className="label">Loading…</div>;
  const l = last(prices);
  const prev = prices[prices.length - 2] || l;
  const chg = pct(l.close, prev.close);
  const up = Number(chg) >= 0;
  return (
    <div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>${l.close.toFixed(2)}</div>
      <div style={{ color: up ? "var(--accent)" : "var(--danger)", fontWeight: 600 }}>
        {up ? "▲" : "▼"} {chg}% <span className="label">1d</span>
      </div>
      <div className="label" style={{ marginTop: 6 }}>{name || ticker} · {l.date}</div>
    </div>
  );
}

export function ChartWidget({ ticker }: { ticker: string }) {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    fetchPrices(ticker, 2)
      .then((p) => live && setPrices(p))
      .catch((e) => live && setErr(String(e.message || e)));
    return () => { live = false; };
  }, [ticker]);
  if (err) return <ErrBox msg={err} />;
  if (!prices.length) return <div className="label">Loading…</div>;
  const l = last(prices);
  return (
    <div>
      <Sparkline data={prices} />
      <div className="label" style={{ marginTop: 4 }}>
        {prices[0].date} → {l.date} · last ${l.close.toFixed(2)} ·{" "}
        {pct(l.close, prices[0].close)}% over period
      </div>
    </div>
  );
}

export function NewsWidget({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    fetchNews(ticker)
      .then((n) => live && setItems(n.slice(0, 6)))
      .catch((e) => live && setErr(String(e.message || e)));
    return () => { live = false; };
  }, [ticker]);
  if (err) return <ErrBox msg={err} />;
  if (!items.length) return <div className="label">Loading news…</div>;
  return (
    <div>
      {items.map((n) => (
        <div key={n.id} style={{ marginBottom: 8 }}>
          <a href={n.url} target="_blank" rel="noreferrer" style={{ fontSize: 14 }}>
            {n.title}
          </a>
          <div className="label">{n.source} · {n.publishedDate?.slice(0, 10)}</div>
        </div>
      ))}
    </div>
  );
}

export function WatchlistWidget({ ticker }: { ticker: string }) {
  const tickers = ticker.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  const [rows, setRows] = useState<Record<string, { close: number; chg: string } | { err: string }>>({});

  useEffect(() => {
    let live = true;
    tickers.forEach((t) => {
      fetchPrices(t, 1)
        .then((p) => {
          if (!live || p.length < 2) return;
          const l = p[p.length - 1], prev = p[p.length - 2];
          setRows((r) => ({ ...r, [t]: { close: l.close, chg: pct(l.close, prev.close) } }));
        })
        .catch((e) => live && setRows((r) => ({ ...r, [t]: { err: String(e.message || e) } })));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  return (
    <table>
      <thead><tr><th>Ticker</th><th>Last</th><th>1d %</th></tr></thead>
      <tbody>
        {tickers.map((t) => {
          const r = rows[t];
          return (
            <tr key={t}>
              <td style={{ fontWeight: 600 }}>{t}</td>
              {!r ? (
                <td colSpan={2} className="label">…</td>
              ) : "err" in r ? (
                <td colSpan={2} style={{ color: "var(--danger)", fontSize: 12 }}>{r.err}</td>
              ) : (
                <>
                  <td>${r.close.toFixed(2)}</td>
                  <td style={{ color: Number(r.chg) >= 0 ? "var(--accent)" : "var(--danger)" }}>
                    {r.chg}%
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function NotesWidget({ id }: { id: string }) {
  const key = `gff_sandbox_widget_notes_${id}`;
  const [text, setText] = useState("");
  useEffect(() => {
    try { setText(localStorage.getItem(key) || ""); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <textarea
      className="input"
      rows={6}
      placeholder="Scratch notes… (saved in your browser)"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try { localStorage.setItem(key, e.target.value); } catch {}
      }}
    />
  );
}

export function WidgetBody({ cfg }: { cfg: WidgetConfig }) {
  switch (cfg.type) {
    case "quote": return <QuoteWidget ticker={cfg.ticker} />;
    case "chart": return <ChartWidget ticker={cfg.ticker} />;
    case "news": return <NewsWidget ticker={cfg.ticker} />;
    case "watchlist": return <WatchlistWidget ticker={cfg.ticker} />;
    case "notes": return <NotesWidget id={cfg.id} />;
  }
}
