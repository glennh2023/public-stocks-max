import { NextRequest, NextResponse } from "next/server";

// Verified-financials grounding for the Research Brief — a port of
// `legacy-python/sources.py` (`edgar_lookup` + `edgar_fact_sheet`): resolve a
// ticker to its SEC CIK, pull the XBRL company facts, and normalize them into
// a dated, as-filed fact sheet (annual rows with margins/FCF/buybacks, recent
// quarters with YoY). Keyless and public — SEC only requires a descriptive
// User-Agent.

const EDGAR_UA = "StocksMax-Research-Sandbox research-demo@stocksmax.example";

// metric key → XBRL tags to merge (tags change across accounting standards) →
// whether the metric is additive (flow) so a missing fiscal Q4 can be derived
// as FY − (Q1+Q2+Q3). Averages like diluted shares must never be derived.
const METRICS: [string, string[], boolean][] = [
  ["revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], true],
  ["grossProfit", ["GrossProfit"], true],
  ["opIncome", ["OperatingIncomeLoss"], true],
  ["netIncome", ["NetIncomeLoss"], true],
  ["ocf", ["NetCashProvidedByUsedInOperatingActivities"], true],
  ["capex", ["PaymentsToAcquirePropertyPlantAndEquipment"], true],
  ["buybacks", ["PaymentsForRepurchaseOfCommonStock"], true],
  ["sbc", ["ShareBasedCompensation"], true],
  ["sharesDiluted", ["WeightedAverageNumberOfDilutedSharesOutstanding"], false],
];

type Entry = { val?: unknown; start?: string; end?: string };
type Series = { annual: [string, number][]; quarterly: [string, number][] };

async function fetchJSON(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": EDGAR_UA } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function days(a: string, b: string): number {
  return (new Date(a).getTime() - new Date(b).getTime()) / 86400000;
}

/** Dedupe raw XBRL entries into annual + quarterly [(periodEnd, value)] series. */
function toSeries(entries: Entry[], additive: boolean): Series {
  const annual = new Map<string, number>();
  const quarterly = new Map<string, number>();
  for (const e of entries) {
    if (typeof e.val !== "number" || !e.end || !e.start) continue;
    const d = days(e.end, e.start);
    if (d > 300 && d < 400) annual.set(e.end, e.val);
    else if (d > 75 && d < 100) quarterly.set(e.end, e.val);
  }
  const a = [...annual.entries()].sort();
  const q = [...quarterly.entries()].sort();
  if (additive) {
    // Derive the missing fiscal Q4 = FY − (Q1+Q2+Q3), flow metrics only.
    for (const [end, fyVal] of a) {
      if (q.some(([d]) => d === end)) continue;
      const inYear = q.filter(([d]) => { const dd = days(end, d); return dd > 0 && dd < 340; }).map(([, v]) => v);
      if (inYear.length === 3) q.push([end, fyVal - inYear.reduce((s, v) => s + v, 0)]);
    }
    q.sort();
  }
  return { annual: a, quarterly: q };
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z.\-]{1,8}$/.test(ticker)) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }
  try {
    // Ticker → CIK.
    const tickers = (await fetchJSON("https://www.sec.gov/files/company_tickers.json")) as Record<
      string, { ticker: string; cik_str: number; title: string }
    >;
    const hit = Object.values(tickers).find((v) => v.ticker.toUpperCase() === ticker);
    if (!hit) return NextResponse.json({ error: `ticker ${ticker} not found on SEC EDGAR` }, { status: 404 });
    const cik = String(hit.cik_str).padStart(10, "0");

    // Company facts → normalized series per metric.
    const facts = (await fetchJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)) as {
      facts?: { "us-gaap"?: Record<string, { units?: Record<string, Entry[]> }> };
    };
    const gaap = facts.facts?.["us-gaap"] ?? {};
    const series = new Map<string, Series>();
    for (const [key, tags, additive] of METRICS) {
      const mergedA = new Map<string, number>();
      const mergedQ = new Map<string, number>();
      for (const tag of tags) {
        const units = gaap[tag]?.units ?? {};
        const s = toSeries(units.USD ?? units.shares ?? [], additive);
        for (const [d, v] of s.annual) if (!mergedA.has(d)) mergedA.set(d, v);
        for (const [d, v] of s.quarterly) if (!mergedQ.has(d)) mergedQ.set(d, v);
      }
      if (mergedA.size || mergedQ.size) {
        series.set(key, { annual: [...mergedA.entries()].sort(), quarterly: [...mergedQ.entries()].sort() });
      }
    }

    // Fact sheet: last 10 fiscal years + last 8 quarters, every figure dated.
    const lines = [
      `VERIFIED FINANCIALS — ${hit.title} (SEC XBRL, as filed; every figure dated by exact fiscal period end)`,
    ];
    const revA = series.get("revenue")?.annual ?? [];
    const at = (key: string, end: string) => series.get(key)?.annual.find(([d]) => d === end)?.[1];
    for (const [end, val] of revA.slice(-10)) {
      const idx = revA.findIndex(([d]) => d === end);
      const prev = idx > 0 ? revA[idx - 1][1] : undefined;
      const parts = [
        `FY ending ${end}: revenue ${fmt(val)}` +
          (prev ? ` (${((val / prev - 1) * 100).toFixed(1)}% YoY)` : ""),
      ];
      const gp = at("grossProfit", end);
      if (gp !== undefined) parts.push(`gross margin ${((gp / val) * 100).toFixed(1)}%`);
      const op = at("opIncome", end);
      if (op !== undefined) parts.push(`op margin ${((op / val) * 100).toFixed(1)}%`);
      for (const [key, label] of [["netIncome", "net income"], ["buybacks", "buybacks"], ["sbc", "SBC"]] as const) {
        const x = at(key, end);
        if (x !== undefined) parts.push(`${label} ${fmt(x)}`);
      }
      const ocf = at("ocf", end);
      if (ocf !== undefined) parts.push(`FCF ${fmt(ocf - (at("capex", end) ?? 0))}`);
      const sh = at("sharesDiluted", end);
      if (sh !== undefined) parts.push(`diluted shares ${Math.round(sh / 1e6)}M`);
      lines.push(parts.join(", "));
    }
    const revQ = series.get("revenue")?.quarterly ?? [];
    if (revQ.length) {
      const niQ = new Map(series.get("netIncome")?.quarterly ?? []);
      const recent = revQ.slice(-8).map(([end, val]) => {
        const yoy = revQ.find(([d]) => Math.abs(days(end, d) - 365) < 45)?.[1];
        const ni = niQ.get(end);
        return `${end}: revenue ${fmt(val)}` +
          (yoy ? ` (${((val / yoy - 1) * 100).toFixed(1)}% YoY)` : "") +
          (ni !== undefined ? `, net income ${fmt(ni)}` : "");
      });
      lines.push("Recent quarters: " + recent.join(" | "));
    }
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    lines.push(`Primary source: ${url}`);
    return NextResponse.json({ ticker, cik, name: hit.title, url, sheet: lines.join("\n") });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 502 });
  }
}
