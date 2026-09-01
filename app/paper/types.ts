/**
 * Sandbox subset of the StocksMax Research Report types
 * (`web/src/app/research/types.ts`). Same report shape — rating header,
 * parallel analyst sections, charts — minus the fundamentals-driven series
 * (EDGAR XBRL, P/E history) and the proprietary YouTuber style prompts,
 * which are full-version only.
 */

export type ReportRating = {
  action: "Buy" | "Hold" | "Sell" | string;
  conviction: number | null;
  priceTarget: number | null;
  upsidePct: number | null;
  horizonMonths: number | null;
  rationale: string;
};

export type ReportSection = { id: string; title: string; markdown: string };

export type ReportCharts = {
  priceMonthly: { date: string; close: number }[];
  compareSpy: { date: string; stock: number; spy: number }[];
  valuationModels: { label: string; value: number | null }[];
  valuationBlended: number | null;
  returns: Record<string, number | null>;
};

export type StockReport = {
  symbol: string;
  company: string;
  price: number | null;
  asOf: string;
  executiveSummary: string;
  thesis: string;
  sections: ReportSection[];
  rating: ReportRating;
  charts: ReportCharts;
  citations: { label: string; url: string | null }[];
  style: ReportStyle;
  generatedAt: string;
};

export type ReportStyle = "house" | "educator" | "income" | "template";

export const REPORT_STYLES: { id: ReportStyle; label: string; hint: string }[] = [
  {
    id: "house",
    label: "House (institutional)",
    hint: "Institutional research note: five analyst agents, rating + 12-month price target",
  },
  {
    id: "educator",
    label: "🎓 Educator",
    hint: "Plain-English teaching voice: explains the business and the debate, verdict as a watch level",
  },
  {
    id: "income",
    label: "💰 Income lens",
    hint: "Dividend/income framing: durability of cash returns over price action",
  },
  {
    id: "template",
    label: "Template (no AI)",
    hint: "Deterministic data-only brief straight from Tiingo — works without any AI key",
  },
];

export const ANALYST_AGENTS: { id: string; label: string; hint: string }[] = [
  { id: "business", label: "Business & Moat", hint: "model, history, competitive advantage" },
  { id: "financials", label: "Financial Analysis", hint: "growth, margins, price-derived momentum" },
  { id: "valuation", label: "Valuation", hint: "multiples reasoning, fair-value range" },
  { id: "bullbear", label: "Bull / Bear & Risks", hint: "steelmanned cases, falsifiers" },
  { id: "catalysts", label: "Catalysts & News", hint: "tailwinds, recent headlines in context" },
];

export function fmtMoney(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(digits)}`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(digits)}%`;
}
