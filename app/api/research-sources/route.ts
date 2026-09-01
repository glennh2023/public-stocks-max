import { NextRequest, NextResponse } from "next/server";

// Source-sweep agents for the Research Brief — a sandbox port of the
// StocksMax Research multi-agent pipeline's fetchers
// (`legacy-python/sources.py` / the full app's `lib/research.ts`).
// All three sources are public and keyless: Google News RSS, the Hacker News
// Algolia API, and SEC EDGAR full-text search. The full pipeline's YouTube
// transcript mining, Reddit OAuth agent, DuckDuckGo web agent and the
// story-editor gap loop are full-version only.

export type Finding = {
  source: "youtube" | "web" | "news" | "hn" | "edgar";
  url: string;
  title: string;
  content: string;
  published: string | null;
};

const EDGAR_UA = "StocksMax-Research-Sandbox research-demo@stocksmax.example";

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": EDGAR_UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
}

// YouTube agent — ported from the full app's `youtubeAgent` (lib/research.ts):
// parse ytInitialData from the results page for titles/channels/views/snippets.
// Transcript mining (yt-dlp) is full-version only.
async function youtubeSearch(q: string): Promise<Finding[]> {
  const body = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    { Cookie: "CONSENT=YES+1" },
  );
  const m = body.match(/var ytInitialData = (\{.+?\});<\/script>/s);
  if (!m) throw new Error("could not locate ytInitialData");
  const data = JSON.parse(m[1]);
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const out: Finding[] = [];
  for (const sec of sections) {
    for (const item of sec?.itemSectionRenderer?.contents ?? []) {
      const v = item.videoRenderer;
      if (!v?.videoId) continue;
      const title = (v.title?.runs ?? []).map((r: { text: string }) => r.text).join("");
      const channel = v.ownerText?.runs?.[0]?.text ?? "";
      const views = v.viewCountText?.simpleText ?? "";
      const published = v.publishedTimeText?.simpleText ?? "";
      const desc = (v.detailedMetadataSnippets?.[0]?.snippetText?.runs ?? v.descriptionSnippet?.runs ?? [])
        .map((r: { text: string }) => r.text)
        .join("");
      out.push({
        source: "youtube",
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        title,
        content: `Channel: ${channel} · ${views} · published ${published}\nDescription: ${desc}`.slice(0, 1500),
        published: null,
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

// Web agent — ported from the full app's `webAgent`/`ddgSearch`: DuckDuckGo
// HTML results, then pull the text of the top pages.
async function webSearch(q: string): Promise<Finding[]> {
  const body = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
  const results: { url: string; title: string }[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) && results.length < 5) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    results.push({ url, title: htmlToText(m[2]).slice(0, 200) });
  }
  const out: Finding[] = [];
  for (const r of results.slice(0, 4)) {
    try {
      const page = await fetchText(r.url);
      out.push({ source: "web", url: r.url, title: r.title, content: htmlToText(page).slice(0, 6000), published: null });
    } catch { /* skip unreachable pages */ }
  }
  // Even when page fetches fail, surface the bare search results.
  if (!out.length) {
    for (const r of results) {
      out.push({ source: "web", url: r.url, title: r.title, content: r.title, published: null });
    }
  }
  return out;
}

async function newsSearch(q: string): Promise<Finding[]> {
  const xml = await fetchText(
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
  );
  const items = xml.split("<item>").slice(1, 10);
  const out: Finding[] = [];
  for (const raw of items) {
    const pick = (tag: string) => {
      const m = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1] : "";
    };
    const title = decode(pick("title"));
    const link = decode(pick("link"));
    const pub = pick("pubDate");
    let published: string | null = null;
    const d = new Date(pub);
    if (!Number.isNaN(d.getTime())) published = d.toISOString().slice(0, 10);
    if (title && link) {
      out.push({
        source: "news",
        url: link,
        title,
        content: `${title}\n${decode(pick("description")).slice(0, 1200)}`,
        published,
      });
    }
    if (out.length >= 8) break;
  }
  return out;
}

async function hnSearch(q: string): Promise<Finding[]> {
  const data = JSON.parse(
    await fetchText(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=8`),
  ) as { hits: Array<{ objectID?: string; title?: string; points?: number; num_comments?: number; created_at?: string }> };
  const out: Finding[] = [];
  for (const h of data.hits ?? []) {
    if (!h.objectID) continue;
    let content = `${h.title ?? ""} · ${h.points ?? 0} points · ${h.num_comments ?? 0} comments`;
    // Pull top comments for the first well-discussed hit (mirrors the original).
    if (out.length < 2 && (h.num_comments ?? 0) > 5) {
      try {
        const item = JSON.parse(await fetchText(`https://hn.algolia.com/api/v1/items/${h.objectID}`)) as {
          children?: Array<{ points?: number; text?: string }>;
        };
        const comments = (item.children ?? [])
          .filter((c) => c.text)
          .slice(0, 8)
          .map((c) => `[${c.points ?? 0} pts] ${decode(c.text!).slice(0, 400)}`);
        if (comments.length) content += `\n\nTop comments:\n${comments.join("\n---\n")}`;
      } catch { /* comments are optional */ }
    }
    out.push({
      source: "hn",
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title || "(HN story)",
      content: content.slice(0, 6000),
      published: (h.created_at ?? "").slice(0, 10) || null,
    });
    if (out.length >= 6) break;
  }
  return out;
}

async function edgarSearch(q: string, cik?: string | null): Promise<Finding[]> {
  const words = q.split(/\s+/);
  let data: { hits?: { hits?: Array<{ _id?: string; _source?: Record<string, unknown> }> } } | null = null;
  // The FTS backend 500s on long phrases — clamp to 5 words, retry at 3.
  // Scoping to the company's CIK keeps out same-phrase hits from other filers.
  for (const attempt of [words.slice(0, 5), words.slice(0, 3)]) {
    try {
      data = JSON.parse(await fetchText(
        `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${attempt.join(" ")}"`)}` +
          (cik ? `&ciks=${cik}` : ""),
      ));
      break;
    } catch { data = null; }
  }
  const out: Finding[] = [];
  for (const h of data?.hits?.hits?.slice(0, 8) ?? []) {
    const s = h._source ?? {};
    const id = h._id ?? "";
    if (!id.includes(":")) continue;
    const [accession, filename] = id.split(":", 2);
    const rawCik = (s.ciks as string[] | undefined)?.[0];
    if (!rawCik) continue;
    const form = (s.file_type as string) || (s.form_type as string) || "filing";
    const name = (s.display_names as string[] | undefined)?.[0] ?? "";
    out.push({
      source: "edgar",
      url: `https://www.sec.gov/Archives/edgar/data/${parseInt(rawCik, 10)}/${accession.replace(/-/g, "")}/${filename}`,
      title: `${name} — ${form} (${(s.file_date as string) || "n.d."})`,
      content: `SEC ${form} filed ${s.file_date} matching '${q}' (primary source).`,
      published: (s.file_date as string) || null,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").slice(0, 200);
  const source = req.nextUrl.searchParams.get("source");
  const cik = (req.nextUrl.searchParams.get("cik") || "").replace(/\D/g, "").slice(0, 10) || null;
  if (!q.trim()) return NextResponse.json({ error: "q required" }, { status: 400 });
  try {
    let findings: Finding[];
    switch (source) {
      case "youtube": findings = await youtubeSearch(q); break;
      case "web": findings = await webSearch(q); break;
      case "news": findings = await newsSearch(q); break;
      case "hn": findings = await hnSearch(q); break;
      case "edgar": findings = await edgarSearch(q, cik); break;
      default:
        return NextResponse.json({ error: "source must be youtube|web|news|hn|edgar" }, { status: 400 });
    }
    return NextResponse.json({ findings });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e), findings: [] }, { status: 200 });
  }
}
