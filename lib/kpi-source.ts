"use client";

// KPI Finder client — sandbox port of StocksMax's `discover_kpi_series`. Calls
// the Evomi-proxied /api/kpi-source route for scraped source docs, then has the
// AI model extract a reconciled time series with source attribution (the
// OpenRouter key stays in the browser). "Source anything": any product/segment
// metric that isn't in EDGAR company facts.

import { DEFAULT_MODEL, getSetting } from "./settings";

export type KpiPoint = { end: string; val: number; period: string };
export type KpiSource = { url: string; title: string };
export type KpiSeries = {
  symbol: string;
  kpi: string;
  unit: string;
  cadence: "quarter" | "year";
  rows: KpiPoint[];
  sources: KpiSource[];
  confidence: number;
  notes: string;
  coverage?: { start: string; end: string };
};

const KPI_SYSTEM =
  "You are a financial data-extraction engine for a stock-research dashboard. " +
  "You receive raw text scraped from several web pages plus a target KPI (a product/segment metric like " +
  '"iPhone revenue", "AWS net sales", "Model 3 deliveries") for one company. Extract the KPI\'s historical ' +
  "time series FROM THE PROVIDED TEXT ONLY — never invent or extrapolate values.\n\n" +
  'Output STRICT JSON only: {"found": true|false, "unit": "USD"|"units"|"subscribers"|"<other>", ' +
  '"cadence": "quarter"|"year", "points": [{"period": "e.g. Q1 FY2024 or 2023", "endDate": "YYYY-MM-DD", ' +
  '"value": 123400000000}], "sourcesUsed": ["url", ...], "notes": "1-2 sentence caveats", "confidence": 0.0-1.0}\n\n' +
  "Rules: value must be the ABSOLUTE number ('$39.3B' → 39300000000; '1.2 million units' → 1200000) — never scaled shorthand. " +
  "Pick the cadence with the MOST COMPLETE history; only 'quarter' when 4+ consecutive quarters exist; never mix cadences. " +
  "RECENCY IS MANDATORY: extend to the most recent period stated in ANY source, merging complementary sources. " +
  "Prefer continuous coverage (no missing years). Sort points ascending by endDate and de-duplicate periods " +
  "(disagreements lower confidence). Only include points actually stated in the text. " +
  'If the pages don\'t contain this KPI, return {"found": false, "notes": "why", "confidence": 0} with empty points.';

async function callAI(system: string, prompt: string): Promise<string> {
  const key = getSetting("openrouter");
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
    body: JSON.stringify({ model: getSetting("model") || DEFAULT_MODEL, system, prompt, max_tokens: 3000, temperature: 0.1 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "AI extraction failed — check your OpenRouter key in Settings.");
  return data.text as string;
}

function evomiHeaders(): Record<string, string> {
  const host = getSetting("evomiHost");
  if (!host) return {};
  return {
    "x-evomi-host": host,
    "x-evomi-port": getSetting("evomiPort"),
    "x-evomi-user": getSetting("evomiUser"),
    "x-evomi-pass": getSetting("evomiPass"),
  };
}

export async function discoverKpiSeries(
  symbol: string,
  kpi: string,
  onLog: (m: string) => void = () => {},
): Promise<KpiSeries> {
  const sym = symbol.trim().toUpperCase();
  const clean = kpi.trim();
  if (!clean) throw new Error("Enter a KPI to source (e.g. “iPhone revenue”).");

  onLog(`Searching the web for “${sym} ${clean}” and scraping sources…`);
  const qs = new URLSearchParams({ symbol: sym, kpi: clean });
  const res = await fetch(`/api/kpi-source?${qs}`, { headers: evomiHeaders() });
  const data = await res.json();
  if (data.error && !data.docs?.length) throw new Error(data.error);
  const docs: { url: string; title: string; text: string }[] = data.docs ?? [];
  if (!docs.length) {
    throw new Error("Found search results but no page could be scraped (paywalls/blocks). Try a different phrasing.");
  }
  onLog(`Scraped ${docs.length} source(s)${data.company ? ` for ${data.company}` : ""}. Extracting the series…`);

  const blocks = docs.map((d, i) => `=== SOURCE ${i + 1}: ${d.title}\nURL: ${d.url}\n${d.text}`).join("\n\n");
  const raw = await callAI(KPI_SYSTEM, `Company: ${sym}\nTarget KPI: ${clean}\n\n${blocks}\n\nExtract the KPI time series as strict JSON now.`);

  let parsed: {
    found?: boolean; unit?: string; cadence?: string;
    points?: Array<{ endDate?: string; value?: number; period?: string }>;
    sourcesUsed?: string[]; notes?: string; confidence?: number;
  };
  try {
    const c = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1));
  } catch {
    throw new Error("The extractor returned malformed JSON — try again.");
  }

  const rows: KpiPoint[] = [];
  const seenEnds = new Set<string>();
  for (const pt of parsed.points ?? []) {
    const end = String(pt.endDate ?? "").slice(0, 10);
    const val = Number(pt.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || seenEnds.has(end) || !Number.isFinite(val)) continue;
    seenEnds.add(end);
    rows.push({ end, val, period: String(pt.period ?? "") });
  }
  rows.sort((a, b) => (a.end < b.end ? -1 : 1));

  if (parsed.found === false || !rows.length) {
    throw new Error(parsed.notes || "The scraped sources didn't contain this KPI's history.");
  }

  const used = new Set((parsed.sourcesUsed ?? []).filter((s) => typeof s === "string"));
  const sources: KpiSource[] = docs
    .filter((d) => !used.size || used.has(d.url))
    .map((d) => ({ url: d.url, title: d.title }));

  onLog(`Done — ${rows.length} points extracted.`);
  return {
    symbol: sym,
    kpi: clean,
    unit: parsed.unit || "USD",
    cadence: parsed.cadence === "year" ? "year" : "quarter",
    rows,
    sources: sources.length ? sources : docs.map((d) => ({ url: d.url, title: d.title })),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    notes: parsed.notes || "",
    coverage: rows.length ? { start: rows[0].end, end: rows[rows.length - 1].end } : undefined,
  };
}
