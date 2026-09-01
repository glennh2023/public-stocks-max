"use client";

// Sandbox research-report engine, mirroring the shape of the StocksMax
// pipeline (`research_report.py`): gather a grounded data pack, have parallel
// analyst agents write their sections, then a lead-analyst synthesis pass
// produces the executive summary, thesis and structured rating. Grounding
// here is Tiingo-only (prices, metadata, news); the full version's EDGAR
// fundamentals, Finnhub estimates and proprietary style prompts are excluded.

import { fetchMeta, fetchNews, fetchPrices, type NewsItem, type PricePoint } from "./tiingo-client";
import { DEFAULT_MODEL, getSetting } from "./settings";
import {
  ANALYST_AGENTS,
  type ReportCharts,
  type ReportRating,
  type ReportSection,
  type ReportStyle,
  type StockReport,
} from "@/app/paper/types";

type Pack = {
  symbol: string;
  company: string;
  description: string;
  prices: PricePoint[];
  spy: PricePoint[];
  news: NewsItem[];
};

const pctf = (a: number, b: number) => (a - b) / b;

async function gatherPack(symbol: string): Promise<Pack> {
  const [meta, prices, spy, news] = await Promise.all([
    fetchMeta(symbol).catch(() => null),
    fetchPrices(symbol, 5),
    fetchPrices("SPY", 5).catch(() => [] as PricePoint[]),
    fetchNews(symbol).catch(() => [] as NewsItem[]),
  ]);
  if (!prices.length) throw new Error(`No Tiingo price data for ${symbol}.`);
  return {
    symbol,
    company: meta?.name || symbol,
    description: meta?.description || "",
    prices,
    spy,
    news,
  };
}

function monthly(prices: PricePoint[]): { date: string; close: number }[] {
  const byMonth = new Map<string, PricePoint>();
  for (const p of prices) byMonth.set(p.date.slice(0, 7), p); // last trading day wins
  return [...byMonth.values()].map((p) => ({ date: p.date.slice(0, 7), close: p.close }));
}

function buildCharts(pack: Pack, valuationModels: ReportCharts["valuationModels"], blended: number | null): ReportCharts {
  const closes = pack.prices.map((p) => p.close);
  const last = closes[closes.length - 1];
  const at = (d: number) => closes[Math.max(0, closes.length - 1 - d)];
  const returns: ReportCharts["returns"] = {
    "1m": pctf(last, at(21)),
    "3m": pctf(last, at(63)),
    "1y": pctf(last, at(252)),
    "3y": closes.length > 700 ? pctf(last, at(756)) : null,
    "5y": closes.length > 1200 ? pctf(last, closes[0]) : null,
  };

  // Indexed 2y comparison vs SPY.
  const cutoff = pack.prices[Math.max(0, pack.prices.length - 505)].date;
  const stock2y = pack.prices.filter((p) => p.date >= cutoff);
  const spy2y = pack.spy.filter((p) => p.date >= cutoff);
  const spyByDate = new Map(spy2y.map((p) => [p.date, p.close]));
  const sBase = stock2y[0]?.close ?? 1;
  const spyBase = spy2y[0]?.close ?? 1;
  const compareSpy = stock2y
    .filter((p) => spyByDate.has(p.date))
    .map((p) => ({
      date: p.date,
      stock: pctf(p.close, sBase) * 100,
      spy: pctf(spyByDate.get(p.date)!, spyBase) * 100,
    }));

  return {
    priceMonthly: monthly(pack.prices),
    compareSpy,
    valuationModels,
    valuationBlended: blended,
    returns,
  };
}

function grounding(pack: Pack): string {
  const closes = pack.prices.map((p) => p.close);
  const last = closes[closes.length - 1];
  const at = (d: number) => closes[Math.max(0, closes.length - 1 - d)];
  const yr = closes.slice(-253);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) * Math.sqrt(252);
  const p = (v: number) => `${(v * 100).toFixed(1)}%`;
  return [
    `TICKER: ${pack.symbol} — ${pack.company}`,
    pack.description ? `BUSINESS DESCRIPTION (from Tiingo metadata): ${pack.description.slice(0, 900)}` : "",
    `PRICE DATA (adjusted closes, as of ${pack.prices[pack.prices.length - 1].date}):`,
    `- Last close $${last.toFixed(2)}; 1m ${p(pctf(last, at(21)))}, 3m ${p(pctf(last, at(63)))}, 1y ${p(pctf(last, at(252)))}, 5y ${p(pctf(last, closes[0]))}`,
    `- 52-week range $${Math.min(...yr).toFixed(2)} – $${Math.max(...yr).toFixed(2)}; annualized volatility ${p(vol)}`,
    `RECENT HEADLINES (Tiingo news):`,
    ...pack.news.slice(0, 10).map((n) => `- [${n.publishedDate?.slice(0, 10)}] ${n.title} (${n.source})`),
    "",
    "GROUNDING POLICY: every specific NUMBER you state must come from the data above. You may use general public knowledge about the company's business qualitatively, but flag anything uncertain as 'to verify'. No fundamentals (revenue, EPS, margins) are provided — do not invent them; reason qualitatively instead.",
  ].filter(Boolean).join("\n");
}

const STYLE_VOICE: Record<Exclude<ReportStyle, "template">, string> = {
  house:
    "Voice: institutional equity research — third person, measured, two-sided, dense with reasoning. End sections with what would change your mind.",
  educator:
    "Voice: a patient teacher explaining to a smart beginner — plain English, define terms, use analogies, first person plural. Keep numbers light and intuition heavy.",
  income:
    "Voice: income-focused analyst — evaluate everything through durability of cash returns to shareholders, capital discipline, and downside protection. Skeptical of momentum.",
};

const SECTION_BRIEFS: Record<string, string> = {
  business:
    "BUSINESS & MOAT: what the company does, how each segment makes money, the company's history in brief, competitive position, moat sources (network effects, switching costs, scale, brand, IP) and their durability, and key competitors. Target 600-900 words of full prose with ### subheads (e.g. ### Revenue mechanism, ### Moat anatomy, ### Competitive landscape).",
  financials:
    "FINANCIAL & PRICE ANALYSIS: interpret the price/return/volatility data honestly — momentum, drawdowns, relative performance, what the market seems to be pricing in. Then discuss the company's financial profile qualitatively from general knowledge (growth trajectory, margin structure, capital intensity, balance-sheet posture), flagging every specific figure as 'to verify' since fundamentals are not in the data pack, and lay out exactly what an analyst would check in the filings. Target 500-800 words with ### subheads.",
  valuation:
    "VALUATION: reason about valuation thoroughly — where the multiple likely sits vs its own history and vs peers (general knowledge, flagged 'to verify'), what growth and margin assumptions the current price implies, and a bear/base/bull fair-value framework with explicit drivers. Include a markdown table of the three scenarios (price, key assumption, one-line driver) and a paragraph on which scenario the evidence currently favors and why. Target 500-800 words plus the table.",
  bullbear:
    "BULL / BEAR & RISKS: steelman both sides properly — 5-6 substantive bullets each under ### Bull case and ### Bear case (each bullet a bolded claim plus 2-3 sentences of argument), then ### Falsifiers: for each side, the specific evidence that would kill the thesis, and ### Key risks: 3-4 risks ranked by expected impact. Target 600-900 words.",
  catalysts:
    "CATALYSTS & NEWS: put every material recent headline in context — what it means, whether it's signal or noise, and how it connects to the thesis. Then map the forward catalyst path: next earnings, product cycles, regulatory events, macro sensitivities, each with expected timing and what to watch for. Target 500-800 words with ### subheads.",
  industry:
    "INDUSTRY & COMPETITIVE DYNAMICS: size and structure of the industry, where value accrues in the stack, secular tail/headwinds, market-share trajectory, and how the competitive game is likely to evolve over 3-5 years. Name the 3-5 competitors that matter and each one's angle of attack. Target 500-800 words with ### subheads.",
  scenarios:
    "SCENARIOS & PORTFOLIO FIT: three 3-year scenarios (bear/base/bull) written as short narratives — what the world looks like, what the business did, roughly where the stock goes and why. Then discuss what role this position plays in a portfolio (growth/compounder/value/turnaround), correlation considerations, and sizing logic. Target 400-700 words.",
};

async function callAI(system: string, prompt: string): Promise<string> {
  const key = getSetting("openrouter");
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
    body: JSON.stringify({ model: getSetting("model") || DEFAULT_MODEL, system, prompt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "AI request failed");
  return data.text as string;
}

function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/* ---------------- template (no AI) ---------------- */

function templateReport(pack: Pack): { sections: ReportSection[]; rating: ReportRating; exec: string; thesis: string; models: ReportCharts["valuationModels"] } {
  const closes = pack.prices.map((p) => p.close);
  const last = closes[closes.length - 1];
  const yr = closes.slice(-253);
  const hi = Math.max(...yr);
  const avg2y = closes.slice(-505).reduce((a, b) => a + b, 0) / Math.min(505, closes.length);
  const mom = pctf(last, closes[Math.max(0, closes.length - 253)]);
  const models = [
    { label: "52w-high anchor", value: hi },
    { label: "2y mean reversion", value: avg2y },
    { label: "Momentum extrapolation", value: last * (1 + mom / 2) },
  ];
  const blended = models.reduce((a, m) => a + (m.value ?? 0), 0) / models.length;
  const up = pctf(blended, last);
  const action = up > 0.1 ? "Buy" : up < -0.1 ? "Sell" : "Hold";
  const p = (v: number) => `${(v * 100).toFixed(1)}%`;
  return {
    exec: `${pack.company} (${pack.symbol}) last closed at $${last.toFixed(2)}, ${p(mom)} over the past year. This template brief is generated deterministically from Tiingo price data — the naive price anchors below blend to $${blended.toFixed(2)} (${p(up)} vs the last close), which drives the mechanical ${action} rating. Treat it as a demo scaffold, not analysis.`,
    thesis: `Without fundamentals, the honest template thesis is a question list: is the ${p(mom)} 1-year move supported by earnings growth, or multiple expansion? The AI-written styles (or the full StocksMax pipeline) answer these with grounded sections.`,
    sections: [
      { id: "business", title: "Business Overview", markdown: pack.description || "_No company description available from Tiingo._" },
      {
        id: "financials", title: "Price Analysis",
        markdown: `| Window | Return |\n| --- | --- |\n| 1y | ${p(mom)} |\n| vs 52w high | ${p(pctf(last, hi))} |\n\nSee the charts below for the full price and relative-performance picture.`,
      },
      {
        id: "catalysts", title: "Recent News",
        markdown: pack.news.slice(0, 6).map((n) => `- **${n.publishedDate?.slice(0, 10)}** — [${n.title}](${n.url}) *(${n.source})*`).join("\n") || "_No recent headlines._",
      },
    ],
    rating: { action, conviction: 1, priceTarget: blended, upsidePct: up, horizonMonths: 12, rationale: "Mechanical blend of naive price anchors — demo only." },
    models,
  };
}

/* ---------------- main entry ---------------- */

export type AgentStatus = Record<string, "pending" | "writing" | "done" | "error">;
export type ReportDepth = "standard" | "deep";

export async function buildReport(opts: {
  symbol: string;
  focus: string;
  style: ReportStyle;
  agents: string[];
  depth?: ReportDepth;
  onStatus: (s: AgentStatus) => void;
  onLog: (m: string) => void;
}): Promise<StockReport> {
  const symbol = opts.symbol.trim().toUpperCase();
  opts.onLog(`Gathering Tiingo pack for ${symbol} (prices, metadata, news, SPY benchmark)…`);
  const pack = await gatherPack(symbol);
  const asOf = pack.prices[pack.prices.length - 1].date;
  const last = pack.prices[pack.prices.length - 1].close;
  const citations = [
    { label: `Tiingo EOD prices & metadata for ${symbol}, as of ${asOf}`, url: `https://www.tiingo.com` },
    ...pack.news.slice(0, 8).map((n) => ({ label: `${n.source}: ${n.title}`, url: n.url })),
  ];

  if (opts.style === "template") {
    opts.onLog("Writing deterministic template brief (no AI).");
    const t = templateReport(pack);
    return {
      symbol, company: pack.company, price: last, asOf,
      executiveSummary: t.exec, thesis: t.thesis, sections: t.sections,
      rating: t.rating,
      charts: buildCharts(pack, t.models, t.rating.priceTarget),
      citations, style: opts.style, generatedAt: new Date().toISOString(),
    };
  }

  let ground = grounding(pack);
  const voice = STYLE_VOICE[opts.style];
  const focusLine = opts.focus.trim() ? `CLIENT FOCUS — organize every section around this question: ${opts.focus.trim()}` : "";
  const deep = opts.depth === "deep";
  const chosen = deep
    ? [
        ...ANALYST_AGENTS.filter((a) => opts.agents.includes(a.id)),
        { id: "industry", label: "Industry & Competition", hint: "" },
        { id: "scenarios", label: "Scenarios & Portfolio Fit", hint: "" },
      ]
    : ANALYST_AGENTS.filter((a) => opts.agents.includes(a.id));

  // Deep mode: a research round runs BEFORE the writers — a planner poses the
  // key questions, a researcher answers them against the pack + general
  // knowledge, and the resulting research memo is appended to every section's
  // grounding. This mirrors the full pipeline's story-editor gap loop in
  // miniature (the real multi-round, multi-source version is full-version only).
  if (deep) {
    opts.onLog("Deep mode: research planner posing the key questions…");
    const questions = await callAI(
      "You are the research planner on an equity research team. Output ONLY a numbered list of the 8-10 most decision-relevant research questions for this company — the questions whose answers would most change an investor's mind. Mix business, financial, valuation, competitive and thesis-specific questions. No preamble.",
      `${focusLine}\n\nDATA PACK:\n${ground}`,
    );
    opts.onLog("Deep mode: researcher answering the question list…");
    const memo = await callAI(
      "You are the staff researcher. Answer each question in 1-2 dense paragraphs using the data pack plus careful general knowledge about the company and industry — dates and figures from general knowledge must be flagged '(to verify)'. Be concrete and two-sided; say 'unknown' where the honest answer is unknown. Output markdown with each question as a ### heading.",
      `QUESTIONS:\n${questions}\n\nDATA PACK:\n${ground}`,
    );
    ground = `${ground}\n\nRESEARCH MEMO (staff answers to the planner's questions — use heavily, keep the '(to verify)' flags):\n${memo}`;
  }

  const status: AgentStatus = Object.fromEntries(chosen.map((a) => [a.id, "pending"]));
  const push = () => opts.onStatus({ ...status });
  push();
  opts.onLog(`${chosen.length} analyst agents writing sections in parallel…`);

  const sectionResults = await Promise.all(
    chosen.map(async (a): Promise<ReportSection | null> => {
      status[a.id] = "writing"; push();
      try {
        const md = await callAI(
          `You are the ${a.label} analyst on an equity research team writing one section of a research report. ${voice} Output ONLY the section body in markdown — no top-level title, it is added by the layout.\n${focusLine}`,
          `${SECTION_BRIEFS[a.id]}\n\nDATA PACK:\n${ground}`,
        );
        status[a.id] = "done"; push();
        return { id: a.id, title: a.label, markdown: md.trim() };
      } catch {
        status[a.id] = "error"; push();
        return null;
      }
    }),
  );
  const sections = sectionResults.filter(Boolean) as ReportSection[];
  if (!sections.length) throw new Error("Every analyst agent failed — check your OpenRouter key in Settings.");

  opts.onLog("Lead analyst synthesizing thesis, rating and price target…");
  type Synth = {
    executiveSummary: string;
    thesis: string;
    rating: { action: string; conviction: number; priceTarget: number; horizonMonths: number; rationale: string };
    valuationModels: { label: string; value: number }[];
  };
  const synthRaw = await callAI(
    `You are the lead analyst synthesizing your team's sections into the report header. ${voice} Respond with ONLY a JSON object: {"executiveSummary": "2-3 paragraph markdown", "thesis": "1-2 paragraph markdown investment thesis", "rating": {"action": "Buy|Hold|Sell", "conviction": 1-5, "priceTarget": number, "horizonMonths": 12, "rationale": "one sentence"}, "valuationModels": [{"label": "Bear", "value": number}, {"label": "Base", "value": number}, {"label": "Bull", "value": number}]}. The price target and scenario values are your reasoned estimates from the sections — label-consistent with the valuation section's scenario table. Current price: $${last.toFixed(2)}.\n${focusLine}`,
    `TEAM SECTIONS:\n\n${sections.map((s) => `## ${s.title}\n${s.markdown}`).join("\n\n")}\n\nDATA PACK:\n${ground}`,
  );
  let synth: Synth;
  try {
    synth = parseJSON<Synth>(synthRaw);
  } catch {
    throw new Error("Synthesis pass returned malformed JSON — try again.");
  }
  const models = (synth.valuationModels || []).map((m) => ({ label: m.label, value: m.value }));
  const target = synth.rating?.priceTarget ?? null;

  opts.onLog("Done.");
  return {
    symbol, company: pack.company, price: last, asOf,
    executiveSummary: synth.executiveSummary || "",
    thesis: synth.thesis || "",
    sections,
    rating: {
      action: synth.rating?.action || "Hold",
      conviction: synth.rating?.conviction ?? null,
      priceTarget: target,
      upsidePct: target != null ? pctf(target, last) : null,
      horizonMonths: synth.rating?.horizonMonths ?? 12,
      rationale: synth.rating?.rationale || "",
    },
    charts: buildCharts(pack, models, target),
    citations, style: opts.style, generatedAt: new Date().toISOString(),
  };
}
