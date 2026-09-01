import { NextRequest, NextResponse } from "next/server";

// Thin Tiingo proxy. The caller supplies their own API key via the
// `x-tiingo-key` header (entered in Settings, stored only in their browser).
// This route exists so the browser can reach api.tiingo.com without CORS
// issues — it stores nothing and only exposes a whitelisted set of endpoints.

const BASE = "https://api.tiingo.com";

export async function GET(req: NextRequest) {
  // Per-user key from Settings takes precedence; a local .env (gitignored,
  // never committed) can provide a fallback for development convenience.
  const key = req.headers.get("x-tiingo-key") || process.env.TIINGO_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Missing Tiingo API key. Add yours in Settings." },
      { status: 401 },
    );
  }

  const params = req.nextUrl.searchParams;
  const endpoint = params.get("endpoint");
  const ticker = (params.get("ticker") || "").replace(/[^A-Za-z0-9.\-]/g, "");

  let url: string;
  switch (endpoint) {
    case "meta":
      if (!ticker) return badRequest("ticker required");
      url = `${BASE}/tiingo/daily/${ticker}`;
      break;
    case "prices": {
      if (!ticker) return badRequest("ticker required");
      const startDate = (params.get("startDate") || "").replace(/[^0-9\-]/g, "");
      url = `${BASE}/tiingo/daily/${ticker}/prices?resampleFreq=daily${
        startDate ? `&startDate=${startDate}` : ""
      }`;
      break;
    }
    case "news": {
      const tickers = (params.get("tickers") || "").replace(/[^A-Za-z0-9.,\-]/g, "");
      url = `${BASE}/tiingo/news?limit=15${tickers ? `&tickers=${tickers}` : ""}`;
      break;
    }
    default:
      return badRequest("Unknown endpoint. Allowed: meta, prices, news.");
  }

  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}token=${encodeURIComponent(key)}`, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Tiingo error ${res.status}: ${text.slice(0, 300)}` },
      { status: res.status === 401 || res.status === 403 ? res.status : 502 },
    );
  }
  return NextResponse.json(await res.json());
}

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}
