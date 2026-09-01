import { NextRequest, NextResponse } from "next/server";

// KPI Finder source-sweep — sandbox port of StocksMax's `discover_kpi_series`.
// For a product/segment metric that isn't in EDGAR company facts ("iPhone
// revenue", "AWS net sales", "Model Y deliveries"), this resolves the company
// name, web-searches under it, and SCRAPES the top pages THROUGH EVOMI (many
// finance pages bot-gate datacenter IPs). It returns the scraped source docs;
// the client then has the AI model extract the reconciled time series (so the
// OpenRouter key stays client-side, per the sandbox's design).

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Pages that rank well but are paywalled / JS-gated / thin — skip them.
const SKIP_DOMAINS = ["statista.com", "seekingalpha.com", "wsj.com", "bloomberg.com", "ft.com", "spglobal.com"];

type Dispatcher = unknown;
type UndiciFetch = (url: string, opts: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
let cachedProxy: { key: string; dispatcher: Dispatcher; fetch: UndiciFetch } | null = null;

async function proxyCtx(evomi: { host: string; port: string; user: string; pass: string }) {
  if (!evomi.host || !evomi.port) return null;
  const key = `${evomi.user}@${evomi.host}:${evomi.port}`;
  if (cachedProxy?.key === key) return cachedProxy;
  try {
    const undici = (await import("undici")) as { ProxyAgent: new (o: unknown) => Dispatcher; fetch: UndiciFetch };
    const auth = evomi.user ? `${encodeURIComponent(evomi.user)}:${encodeURIComponent(evomi.pass)}@` : "";
    const dispatcher = new undici.ProxyAgent({ uri: `http://${auth}${evomi.host}:${evomi.port}` });
    cachedProxy = { key, dispatcher, fetch: undici.fetch };
    return cachedProxy;
  } catch {
    return null;
  }
}

function evomiFromRequest(req: NextRequest) {
  return {
    host: req.headers.get("x-evomi-host") || process.env.EVOMI_HOST || "",
    port: req.headers.get("x-evomi-port") || process.env.EVOMI_PORT || "",
    user: req.headers.get("x-evomi-user") || process.env.EVOMI_USERNAME || "",
    pass: req.headers.get("x-evomi-pass") || process.env.EVOMI_PASSWORD || "",
  };
}

type Proxy = { dispatcher: Dispatcher; fetch: UndiciFetch } | null;

async function fetchText(url: string, proxy: Proxy, extra: Record<string, string> = {}): Promise<string> {
  const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...extra };
  if (proxy) {
    const res = await proxy.fetch(url, { headers, dispatcher: proxy.dispatcher });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.text();
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveCompanyName(ticker: string, proxy: Proxy): Promise<string> {
  try {
    const raw = JSON.parse(await fetchText("https://www.sec.gov/files/company_tickers.json", proxy, {
      "User-Agent": "StocksMax-Research-Sandbox research-demo@stocksmax.example",
    })) as Record<string, { ticker: string; title: string }>;
    for (const v of Object.values(raw)) {
      if (v.ticker?.toUpperCase() === ticker.toUpperCase()) {
        return v.title.replace(/[,.]?\s+(inc|corp|corporation|co|ltd|plc|holdings|company)\.?$/i, "").trim();
      }
    }
  } catch { /* fall back to ticker */ }
  return ticker;
}

async function ddgSearch(query: string, proxy: Proxy): Promise<{ url: string; title: string; snippet: string }[]> {
  const body = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, proxy);
  const out: { url: string; title: string; snippet: string }[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && out.length < 12) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    out.push({ url: url.split("#")[0], title: htmlToText(m[2]).slice(0, 160), snippet: "" });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const symbol = (p.get("symbol") || "").replace(/[^A-Za-z0-9.\-]/g, "").toUpperCase();
  const kpi = (p.get("kpi") || "").slice(0, 120).trim();
  if (!kpi) return NextResponse.json({ error: "kpi required" }, { status: 400 });

  const evomi = evomiFromRequest(req);
  const proxy = await proxyCtx(evomi);
  try {
    const name = symbol ? await resolveCompanyName(symbol, proxy) : "";
    const year = 2026; // sandbox: fixed to avoid Date() nondeterminism elsewhere
    const queries = [
      `${name || symbol} ${kpi} by quarter`,
      `${name || symbol} ${kpi} history`,
      `${symbol} ${kpi} quarterly`,
      `${name || symbol} ${kpi} fiscal ${year - 1} ${year}`,
    ].filter((q) => q.trim());

    // Search → rank by KPI-token overlap → scrape numerically-dense pages,
    // one per host, through Evomi.
    const seen = new Set<string>();
    const hits: { url: string; title: string; host: string; score: number }[] = [];
    const tokens = kpi.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    for (const q of queries) {
      let results: { url: string; title: string; snippet: string }[] = [];
      try { results = await ddgSearch(q, proxy); } catch { continue; }
      for (const r of results) {
        const host = (() => { try { return new URL(r.url).hostname.toLowerCase(); } catch { return ""; } })();
        if (!host || seen.has(r.url) || SKIP_DOMAINS.some((d) => host.endsWith(d))) continue;
        seen.add(r.url);
        const hay = `${r.title} ${r.url}`.toLowerCase();
        hits.push({ url: r.url, title: r.title, host, score: tokens.filter((t) => hay.includes(t)).length });
      }
      if (hits.length >= 18) break;
    }
    hits.sort((a, b) => b.score - a.score);

    const docs: { url: string; title: string; text: string }[] = [];
    const usedHosts = new Set<string>();
    for (const h of hits) {
      if (docs.length >= 4) break;
      if (usedHosts.has(h.host)) continue;
      let text = "";
      try { text = htmlToText(await fetchText(h.url, proxy)); } catch { continue; }
      const digits = (text.slice(0, 12000).match(/\d/g) || []).length;
      if (text.length < 400 || digits < 40) continue; // needs numeric density
      usedHosts.add(h.host);
      docs.push({ url: h.url, title: h.title, text: text.slice(0, 9000) });
    }

    return NextResponse.json({
      company: name,
      docs,
      searched: hits.slice(0, 8).map((h) => h.url),
      proxied: !!proxy,
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e), docs: [] }, { status: 200 });
  }
}
