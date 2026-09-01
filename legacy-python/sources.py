"""Source agents: scrape public data with zero third-party dependencies.

Each agent returns a list of dicts:
    {"source": str, "url": str, "title": str, "content": str, "published": str|None}
Everything uses urllib from the standard library so the project runs anywhere
Python 3.10+ is installed.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
EDGAR_UA = "GoodFaithFinance research-demo contact@example.com"


def fetch(url: str, headers: dict | None = None, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def html_to_text(html: str) -> str:
    """Crude but effective HTML → text used across the scrapers."""
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.I)
    html = re.sub(r"<(br|p|div|tr|li|h[1-6]|table)[^>]*>", "\n", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = html.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    html = re.sub(r"&#\d+;", " ", html)
    html = re.sub(r"[ \t]+", " ", html)
    html = re.sub(r"\n{3,}", "\n\n", html)
    return html.strip()


def approx_date(relative: str) -> str | None:
    """Convert YouTube's '3 months ago' to '~YYYY-MM-DD' (never fake precision)."""
    m = re.search(r"(\d+)\s+(day|week|month|year)s?\s+ago", relative or "", re.I)
    if not m:
        return None
    mult = {"day": 1, "week": 7, "month": 30, "year": 365}[m.group(2).lower()]
    d = datetime.now(timezone.utc) - timedelta(days=int(m.group(1)) * mult)
    return "~" + d.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- YouTube ----
def youtube_search(query: str, limit: int = 8) -> list[dict]:
    body = fetch(
        "https://www.youtube.com/results?search_query=" + urllib.parse.quote(query),
        headers={"Cookie": "CONSENT=YES+1", "Accept-Language": "en-US,en"},
    )
    m = re.search(r"var ytInitialData = (\{.+?\});</script>", body, re.S)
    if not m:
        return []
    data = json.loads(m.group(1))
    out: list[dict] = []
    sections = (
        data.get("contents", {})
        .get("twoColumnSearchResultsRenderer", {})
        .get("primaryContents", {})
        .get("sectionListRenderer", {})
        .get("contents", [])
    )
    for sec in sections:
        for item in sec.get("itemSectionRenderer", {}).get("contents", []):
            v = item.get("videoRenderer")
            if not v or "videoId" not in v:
                continue
            title = "".join(r.get("text", "") for r in v.get("title", {}).get("runs", []))
            channel = (v.get("ownerText", {}).get("runs") or [{}])[0].get("text", "")
            views = v.get("viewCountText", {}).get("simpleText", "")
            published = v.get("publishedTimeText", {}).get("simpleText", "")
            snippet_runs = (
                v.get("detailedMetadataSnippets", [{}])[0].get("snippetText", {}).get("runs", [])
                or v.get("descriptionSnippet", {}).get("runs", [])
            )
            desc = "".join(r.get("text", "") for r in snippet_runs)
            out.append(
                {
                    "source": "youtube",
                    "url": f"https://www.youtube.com/watch?v={v['videoId']}",
                    "title": title,
                    "content": f"Channel: {channel} · {views} · published {published}\n{desc}"[:1500],
                    "published": approx_date(published),
                }
            )
            if len(out) >= limit:
                return out
    return out


# ------------------------------------------------------------------- Web ----
def web_search(query: str, pages: int = 4) -> list[dict]:
    body = fetch("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query))
    results = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', body):
        url = m.group(1)
        uddg = re.search(r"[?&]uddg=([^&]+)", url)
        if uddg:
            url = urllib.parse.unquote(uddg.group(1))
        # Skip non-HTML documents — a PDF eats a slot and yields garbage text.
        if not url.startswith("http") or re.search(r"\.(pdf|xlsx?|docx?|pptx?)($|\?)", url, re.I):
            continue
        results.append({"url": url, "title": html_to_text(m.group(2))[:200]})
        if len(results) >= 10:
            break
    # Keep trying candidates until we have `pages` SUCCESSFUL fetches — the top
    # links are often paywalled/blocked and must not consume the whole budget.
    out: list[dict] = []
    for r in results:
        if len(out) >= pages:
            break
        try:
            text = html_to_text(fetch(r["url"]))
            if len(text) > 500:
                out.append({"source": "web", "url": r["url"], "title": r["title"],
                            "content": text[:8000], "published": None})
        except Exception:
            continue
    return out


# ------------------------------------------------------------------ News ----
def news_search(query: str, limit: int = 8) -> list[dict]:
    xml = fetch(
        "https://news.google.com/rss/search?q=" + urllib.parse.quote(query) + "&hl=en-US&gl=US&ceid=US:en"
    )
    out: list[dict] = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return out
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = item.findtext("pubDate") or ""
        desc = html_to_text(item.findtext("description") or "")
        published = None
        try:
            published = datetime.strptime(pub[:16], "%a, %d %b %Y").strftime("%Y-%m-%d")
        except ValueError:
            pass
        if title and link:
            out.append({"source": "news", "url": link, "title": title,
                        "content": f"{title}\n{desc}"[:1200], "published": published})
        if len(out) >= limit:
            break
    # Pull full text of the top hits (redirects resolve automatically).
    for it in out[:3]:
        try:
            text = html_to_text(fetch(it["url"]))
            if len(text) > 1500:
                it["content"] = text[:8000]
        except Exception:
            pass
    return out


# ------------------------------------------------------------ Hacker News ----
def hn_search(query: str, limit: int = 6) -> list[dict]:
    data = json.loads(
        fetch("https://hn.algolia.com/api/v1/search?query=" + urllib.parse.quote(query) + "&tags=story&hitsPerPage=8")
    )
    out: list[dict] = []
    for h in data.get("hits", []):
        if not h.get("objectID"):
            continue
        content = f"{h.get('title', '')} · {h.get('points', 0)} points · {h.get('num_comments', 0)} comments"
        if len(out) < 2 and (h.get("num_comments") or 0) > 5:
            try:
                item = json.loads(fetch(f"https://hn.algolia.com/api/v1/items/{h['objectID']}"))
                comments = [
                    f"[{c.get('points') or 0} pts] {html_to_text(c.get('text') or '')[:400]}"
                    for c in item.get("children", []) if c.get("text")
                ][:8]
                if comments:
                    content += "\n\nTop comments:\n" + "\n---\n".join(comments)
            except Exception:
                pass
        out.append({"source": "hn", "url": f"https://news.ycombinator.com/item?id={h['objectID']}",
                    "title": h.get("title", "(HN story)"), "content": content[:6000],
                    "published": str(h.get("created_at", ""))[:10] or None})
        if len(out) >= limit:
            break
    return out


# ----------------------------------------------------------------- EDGAR ----
def edgar_lookup(ticker: str) -> dict | None:
    """Resolve a ticker to its SEC CIK + official name."""
    raw = json.loads(fetch("https://www.sec.gov/files/company_tickers.json", headers={"User-Agent": EDGAR_UA}))
    for v in raw.values():
        if v["ticker"].upper() == ticker.upper():
            return {"cik": str(v["cik_str"]).zfill(10), "name": v["title"]}
    return None


def edgar_fts(query: str, cik: str | None, limit: int = 8) -> list[dict]:
    """SEC full-text search, scoped to the company's CIK when known."""
    words = query.split()
    for attempt in (words[:5], words[:3]):
        url = ("https://efts.sec.gov/LATEST/search-index?q=" + urllib.parse.quote('"' + " ".join(attempt) + '"')
               + (f"&ciks={cik}" if cik else ""))
        try:
            data = json.loads(fetch(url, headers={"User-Agent": EDGAR_UA}))
            break
        except Exception:
            data = None
    if not data:
        return []
    out: list[dict] = []
    for h in data.get("hits", {}).get("hits", [])[:limit]:
        s = h.get("_source", {})
        _id = h.get("_id", "")
        if ":" not in _id:
            continue
        accession, filename = _id.split(":", 1)
        raw_cik = (s.get("ciks") or [None])[0]
        if not raw_cik:
            continue
        form = s.get("file_type") or s.get("form_type") or "filing"
        name = (s.get("display_names") or [""])[0]
        out.append({
            "source": "edgar",
            "url": f"https://www.sec.gov/Archives/edgar/data/{int(raw_cik)}/{accession.replace('-', '')}/{filename}",
            "title": f"{name} — {form} ({s.get('file_date', 'n.d.')})",
            "content": f"SEC {form} filed {s.get('file_date')} matching '{query}' (primary source).",
            "published": s.get("file_date"),
        })
    return out


# ------------------------------------------------- verified XBRL fact sheet ----
_METRICS = [
    ("revenue", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"], True),
    ("grossProfit", ["GrossProfit"], True),
    ("opIncome", ["OperatingIncomeLoss"], True),
    ("netIncome", ["NetIncomeLoss"], True),
    ("ocf", ["NetCashProvidedByUsedInOperatingActivities"], True),
    ("capex", ["PaymentsToAcquirePropertyPlantAndEquipment"], True),
    ("buybacks", ["PaymentsForRepurchaseOfCommonStock"], True),
    ("sbc", ["ShareBasedCompensation"], True),
    ("sharesDiluted", ["WeightedAverageNumberOfDilutedSharesOutstanding"], False),  # avg — never derive Q4
]


def _series(entries: list[dict], additive: bool) -> tuple[list, list]:
    """Dedupe XBRL entries into (annual, quarterly) [(end, value)] series."""
    annual, quarterly = {}, {}
    for e in entries:
        if not isinstance(e.get("val"), (int, float)) or not e.get("end") or not e.get("start"):
            continue
        try:
            days = (datetime.fromisoformat(e["end"]) - datetime.fromisoformat(e["start"])).days
        except ValueError:
            continue
        if 300 < days < 400:
            annual[e["end"]] = e["val"]
        elif 75 < days < 100:
            quarterly[e["end"]] = e["val"]
    a = sorted(annual.items())
    q = sorted(quarterly.items())
    if additive:  # derive missing fiscal Q4 = FY − (Q1+Q2+Q3), flow metrics only
        for end, fy_val in a:
            if any(d == end for d, _ in q):
                continue
            in_year = [v for d, v in q if 0 < (datetime.fromisoformat(end) - datetime.fromisoformat(d)).days < 340]
            if len(in_year) == 3:
                q.append((end, fy_val - sum(in_year)))
        q.sort()
    return a, q


def _fmt(v: float) -> str:
    if abs(v) >= 1e9:
        return f"${v / 1e9:.2f}B"
    if abs(v) >= 1e6:
        return f"${v / 1e6:.1f}M"
    return f"${v:,.0f}"


def edgar_fact_sheet(cik: str, name: str) -> str:
    """Build a dated, as-filed fact sheet from SEC XBRL company facts."""
    facts = json.loads(fetch(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                             headers={"User-Agent": EDGAR_UA}))
    gaap = facts.get("facts", {}).get("us-gaap", {})
    series: dict[str, tuple[list, list]] = {}
    for key, tags, additive in _METRICS:
        merged_a: dict = {}
        merged_q: dict = {}
        for tag in tags:  # merge across accounting-standard tag changes
            units = gaap.get(tag, {}).get("units", {})
            entries = units.get("USD") or units.get("shares") or []
            a, q = _series(entries, additive)
            for d, v in a:
                merged_a.setdefault(d, v)
            for d, v in q:
                merged_q.setdefault(d, v)
        if merged_a or merged_q:
            series[key] = (sorted(merged_a.items()), sorted(merged_q.items()))

    lines = [f"VERIFIED FINANCIALS — {name} (SEC XBRL, as filed; every figure dated by exact fiscal period end)"]
    rev_a = series.get("revenue", ([], []))[0]
    for i, (end, val) in enumerate(rev_a[-10:]):
        idx = rev_a.index((end, val))
        prev = rev_a[idx - 1][1] if idx > 0 else None
        parts = [f"FY ending {end}: revenue {_fmt(val)}" + (f" ({(val / prev - 1) * 100:+.1f}% YoY)" if prev else "")]
        for key, label in [("grossProfit", "gross margin"), ("opIncome", "op margin")]:
            x = dict(series.get(key, ([], []))[0]).get(end)
            if x is not None:
                parts.append(f"{label} {x / val * 100:.1f}%")
        for key, label in [("netIncome", "net income"), ("buybacks", "buybacks"), ("sbc", "SBC")]:
            x = dict(series.get(key, ([], []))[0]).get(end)
            if x is not None:
                parts.append(f"{label} {_fmt(x)}")
        ocf = dict(series.get("ocf", ([], []))[0]).get(end)
        capex = dict(series.get("capex", ([], []))[0]).get(end)
        if ocf is not None:
            parts.append(f"FCF {_fmt(ocf - (capex or 0))}")
        sh = dict(series.get("sharesDiluted", ([], []))[0]).get(end)
        if sh is not None:
            parts.append(f"diluted shares {sh / 1e6:.0f}M")
        lines.append(", ".join(parts))
    rev_q = series.get("revenue", ([], []))[1]
    if rev_q:
        recent = []
        for end, val in rev_q[-8:]:
            yoy = next((v for d, v in rev_q if abs((datetime.fromisoformat(end) - datetime.fromisoformat(d)).days - 365) < 45), None)
            ni = dict(series.get("netIncome", ([], []))[1]).get(end)
            recent.append(f"{end}: revenue {_fmt(val)}" + (f" ({(val / yoy - 1) * 100:+.1f}% YoY)" if yoy else "")
                          + (f", net income {_fmt(ni)}" if ni is not None else ""))
        lines.append("Recent quarters: " + " | ".join(recent))
    lines.append(f"Primary source: https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")
    return "\n".join(lines)
