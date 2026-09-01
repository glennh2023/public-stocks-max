"use client";

import { getSetting } from "./settings";

// Client helper for the /api/tiingo proxy. The user's Tiingo key is read from
// localStorage and sent as a header; the server never stores it.

export type PricePoint = { date: string; close: number };

export type TickerMeta = {
  ticker: string;
  name: string;
  description: string;
  exchangeCode: string;
  startDate: string;
  endDate: string;
};

export type NewsItem = {
  id: number;
  title: string;
  url: string;
  source: string;
  publishedDate: string;
  description: string;
};

async function call<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  // If the user set a key in Settings it is sent along; otherwise the server
  // may still have a local .env fallback (development only).
  const key = getSetting("tiingo");
  const qs = new URLSearchParams({ endpoint, ...params });
  const res = await fetch(`/api/tiingo?${qs}`, {
    headers: key ? { "x-tiingo-key": key } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Tiingo request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchMeta(ticker: string): Promise<TickerMeta> {
  return call<TickerMeta>("meta", { ticker });
}

export async function fetchPrices(ticker: string, years = 2): Promise<PricePoint[]> {
  const start = new Date();
  start.setFullYear(start.getFullYear() - years);
  const raw = await call<Array<{ date: string; adjClose: number; close: number }>>(
    "prices",
    { ticker, startDate: start.toISOString().slice(0, 10) },
  );
  return raw.map((r) => ({ date: r.date.slice(0, 10), close: r.adjClose ?? r.close }));
}

export async function fetchNews(tickers: string): Promise<NewsItem[]> {
  return call<NewsItem[]>("news", { tickers });
}
