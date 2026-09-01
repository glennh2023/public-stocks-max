import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { mkdtemp, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileP = promisify(execFile);

// YouTube channel scanner for the YouTube Calls tab — sandbox port of the
// StocksMax YouTube Follow feature's ingestion. Two actions, both keyless
// page scrapes (same approach as the research YouTube agent):
//   ?action=videos&channel=<@handle | channel URL | search name>
//       → recent uploads for the channel
//   ?action=transcript&v=<videoId>
//       → the video's caption transcript (public caption track; videos
//         without captions return transcript: null)
// The full version's resilient transcript pipeline (yt-dlp, proxies,
// impersonation) is full-version only.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Optional residential-proxy dispatcher (Evomi). YouTube bot-gates datacenter
// IPs and strips caption tracks; routing through a residential proxy restores
// them. Creds come from the request (the caller's Settings) or from .env.
// undici is imported dynamically so the app still runs when it isn't installed
// (the transcript path then just degrades to title-only, as before).
type Dispatcher = unknown;
type UndiciFetch = (url: string, opts: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
let cachedProxy: { key: string; dispatcher: Dispatcher; fetch: UndiciFetch } | null = null;

async function proxyDispatcher(creds: {
  host: string; port: string; user: string; pass: string;
}): Promise<{ dispatcher: Dispatcher; fetch: UndiciFetch } | null> {
  const { host, port, user, pass } = creds;
  if (!host || !port) return null;
  const key = `${user}@${host}:${port}`;
  if (cachedProxy?.key === key) return cachedProxy;
  try {
    // Use undici's OWN fetch — Next.js patches global fetch and drops the
    // `dispatcher` option, so the proxy would otherwise be silently ignored.
    const undici = (await import("undici")) as {
      ProxyAgent: new (opts: unknown) => Dispatcher;
      fetch: UndiciFetch;
    };
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
    const dispatcher = new undici.ProxyAgent({ uri: `http://${auth}${host}:${port}` });
    cachedProxy = { key, dispatcher, fetch: undici.fetch };
    return cachedProxy;
  } catch {
    return null; // undici not installed — caller degrades gracefully
  }
}

function evomiFromRequest(req: import("next/server").NextRequest) {
  return {
    host: req.headers.get("x-evomi-host") || process.env.EVOMI_HOST || "",
    port: req.headers.get("x-evomi-port") || process.env.EVOMI_PORT || "",
    user: req.headers.get("x-evomi-user") || process.env.EVOMI_USERNAME || "",
    pass: req.headers.get("x-evomi-pass") || process.env.EVOMI_PASSWORD || "",
  };
}

// When a proxy is configured we call undici.fetch directly with the dispatcher
// (Next.js's global fetch strips it); otherwise the ordinary global fetch.
type ProxyCtx = { dispatcher: Dispatcher; fetch: UndiciFetch } | undefined;

async function fetchText(url: string, extra: Record<string, string> = {}, proxy?: ProxyCtx): Promise<string> {
  const headers = { "User-Agent": UA, Cookie: "CONSENT=YES+1", "Accept-Language": "en-US,en;q=0.9", ...extra };
  if (proxy) {
    const res = await proxy.fetch(url, { headers, dispatcher: proxy.dispatcher });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host} (proxied)`);
    return res.text();
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

function extractJSON(body: string, marker: string): unknown | null {
  const idx = body.indexOf(marker);
  if (idx < 0) return null;
  const start = body.indexOf("{", idx);
  if (start < 0) return null;
  // Balanced-brace scan (the regex approach breaks on }); inside strings).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** "3 days ago" / "2 weeks ago" → approximate ISO date. */
function approxDate(rel: string): string | null {
  const m = rel.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unitMs: Record<string, number> = {
    second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6,
  };
  return new Date(Date.now() - n * (unitMs[m[2].toLowerCase()] ?? 864e5)).toISOString().slice(0, 10);
}

type VideoRow = {
  videoId: string;
  title: string;
  published: string | null;
  publishedText: string;
  views: string;
  length: string;
};

async function resolveChannelUrl(input: string, proxy?: ProxyCtx): Promise<{ url: string; name: string }> {
  const t = input.trim();
  if (/^https?:\/\//.test(t)) return { url: t.replace(/\/videos\/?$/, ""), name: t };
  if (t.startsWith("@")) return { url: `https://www.youtube.com/${t}`, name: t };
  // Plain name → channel search, take the top channelRenderer.
  const body = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(t)}&sp=EgIQAg%253D%253D`,
    {}, proxy,
  );
  const data = extractJSON(body, "var ytInitialData = ") as {
    contents?: { twoColumnSearchResultsRenderer?: { primaryContents?: { sectionListRenderer?: { contents?: unknown[] } } } };
  } | null;
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  for (const sec of sections as Array<{ itemSectionRenderer?: { contents?: Array<{ channelRenderer?: { canonicalBaseUrl?: string; navigationEndpoint?: { browseEndpoint?: { canonicalBaseUrl?: string } }; title?: { simpleText?: string } } }> } }>) {
    for (const item of sec?.itemSectionRenderer?.contents ?? []) {
      const c = item.channelRenderer;
      if (!c) continue;
      const base = c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || c.canonicalBaseUrl;
      if (base) return { url: `https://www.youtube.com${base}`, name: c.title?.simpleText || t };
    }
  }
  throw new Error(`No YouTube channel found for "${t}"`);
}

/** Deep-walk a parsed ytInitialData tree collecting objects under `key`. */
function collectByKey(node: unknown, key: string, out: Record<string, unknown>[], cap = 40) {
  if (out.length >= cap || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, key, out, cap);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj[key] && typeof obj[key] === "object") out.push(obj[key] as Record<string, unknown>);
  for (const v of Object.values(obj)) collectByKey(v, key, out, cap);
}

/** All string leaves inside a subtree (for fishing "3 days ago" / "12K views"). */
function stringLeaves(node: unknown, out: string[], cap = 200) {
  if (out.length >= cap || node == null) return;
  if (typeof node === "string") { out.push(node); return; }
  if (typeof node !== "object") return;
  for (const v of Array.isArray(node) ? node : Object.values(node)) stringLeaves(v, out, cap);
}

/**
 * List a channel's uploads with yt-dlp's flat playlist — fast, and unlike the
 * watch-page HTML scrape it isn't capped at ~15, so it scales to hundreds of
 * videos. Dates aren't included in flat mode (filled per-video at scan time).
 * Returns null if yt-dlp is unavailable so the caller falls back to scraping.
 */
async function channelVideosViaYtDlp(channelUrl: string, limit: number, evomi: {
  host: string; port: string; user: string; pass: string;
}): Promise<{ channelName: string; videos: VideoRow[] } | null> {
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const url = /\/(videos|streams|shorts)\/?$/.test(channelUrl) ? channelUrl : `${channelUrl}/videos`;
  const args = [
    "--flat-playlist", "--no-warnings",
    "--playlist-end", String(Math.max(1, Math.min(2000, limit))),
    // `%(channel)s` is NA in flat mode; `%(playlist_title)s` is "<Name> - Videos".
    "--print", "%(id)s\t%(playlist_title)s\t%(title)s",
    url,
  ];
  if (evomi.host && evomi.port) {
    const auth = evomi.user ? `${encodeURIComponent(evomi.user)}:${encodeURIComponent(evomi.pass)}@` : "";
    args.unshift("--proxy", `http://${auth}${evomi.host}:${evomi.port}`);
  }
  try {
    const { stdout } = await execFileP(bin, args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    const videos: VideoRow[] = [];
    let channelName = "";
    for (const line of stdout.split("\n")) {
      const [videoId, pl, ...rest] = line.trim().split("\t");
      if (!videoId || videoId.length !== 11) continue;
      if (!channelName && pl && pl !== "NA") channelName = pl.replace(/\s*-\s*(Videos|Shorts|Streams)$/i, "").trim();
      videos.push({ videoId, title: rest.join("\t") || "(untitled)", published: null, publishedText: "", views: "", length: "" });
    }
    return videos.length ? { channelName, videos } : null;
  } catch {
    return null;
  }
}

async function channelVideos(input: string, limit: number, evomi: {
  host: string; port: string; user: string; pass: string;
}, proxy?: ProxyCtx): Promise<{ channelName: string; channelUrl: string; videos: VideoRow[] }> {
  const { url } = await resolveChannelUrl(input, proxy);
  // Prefer yt-dlp (unbounded); fall back to the HTML scrape (first ~15) below.
  const yd = await channelVideosViaYtDlp(url, limit, evomi);
  if (yd) {
    return { channelName: yd.channelName || input, channelUrl: url, videos: yd.videos };
  }
  const body = await fetchText(`${url}/videos`, {}, proxy);
  const data = extractJSON(body, "var ytInitialData = ") as {
    metadata?: { channelMetadataRenderer?: { title?: string } };
  } | null;
  if (!data) throw new Error("Could not parse the channel page.");
  const channelName = data.metadata?.channelMetadataRenderer?.title || input;
  const videos: VideoRow[] = [];
  const seen = new Set<string>();

  // Classic grid: videoRenderer items.
  const renderers: Record<string, unknown>[] = [];
  collectByKey(data, "videoRenderer", renderers);
  for (const v of renderers as Array<{ videoId?: string; title?: { runs?: Array<{ text: string }> }; publishedTimeText?: { simpleText?: string }; viewCountText?: { simpleText?: string }; lengthText?: { simpleText?: string } }>) {
    if (!v.videoId || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    const publishedText = v.publishedTimeText?.simpleText ?? "";
    videos.push({
      videoId: v.videoId,
      title: (v.title?.runs ?? []).map((r) => r.text).join(""),
      published: approxDate(publishedText),
      publishedText,
      views: v.viewCountText?.simpleText ?? "",
      length: v.lengthText?.simpleText ?? "",
    });
  }

  // Current grid: lockupViewModel items ({contentId, lockupMetadataViewModel}).
  const lockups: Record<string, unknown>[] = [];
  collectByKey(data, "lockupViewModel", lockups);
  for (const l of lockups as Array<{ contentId?: string; contentType?: string; metadata?: { lockupMetadataViewModel?: { title?: { content?: string } } } }>) {
    if (!l.contentId || seen.has(l.contentId)) continue;
    if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") continue;
    seen.add(l.contentId);
    const leaves: string[] = [];
    stringLeaves(l.metadata, leaves);
    const publishedText = leaves.find((s) => /\bago\b/.test(s)) ?? "";
    videos.push({
      videoId: l.contentId,
      title: l.metadata?.lockupMetadataViewModel?.title?.content ?? "(untitled)",
      published: approxDate(publishedText),
      publishedText,
      views: leaves.find((s) => /\bviews\b/i.test(s)) ?? "",
      length: "",
    });
  }

  if (!videos.length) throw new Error("No videos found on the channel page.");
  return { channelName, channelUrl: url, videos: videos.slice(0, 15) };
}

function fmtTs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** yt-dlp "20260831" (or "NA") → "2026-08-31" (or ""). */
function ymd(raw: string | undefined): string {
  const m = (raw || "").trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Returns the caption transcript with [m:ss] timestamp markers so the AI can
 * cite where a call was made. YouTube strips caption tracks for IPs it
 * bot-flags ("Sign in to confirm you're not a bot") — then transcript is null
 * and the scanner falls back to title-only extraction.
 */
type PlayerResponse = {
  videoDetails?: { title?: string; author?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string }> } };
};

async function fetchJSON(url: string, init: { method: string; headers: Record<string, string>; body: string }, proxy?: ProxyCtx): Promise<unknown> {
  const opts = { ...init, headers: { "User-Agent": UA, ...init.headers } };
  if (proxy) {
    const res = await (proxy.fetch as (u: string, o: unknown) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>)(url, { ...opts, dispatcher: proxy.dispatcher });
    return JSON.parse(await res.text());
  }
  const res = await fetch(url, opts as RequestInit);
  return res.json();
}

/**
 * Ask the innertube player API for caption tracks. YouTube has largely stopped
 * embedding captionTracks in the watch-page HTML, so this is the real path —
 * and from a residential proxy the ANDROID client isn't bot-gated. Returns []
 * when the IP is still flagged (LOGIN_REQUIRED).
 */
async function innertubeCaptions(videoId: string, proxy?: ProxyCtx): Promise<PlayerResponse | null> {
  const clients = [
    { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30 },
    { clientName: "IOS", clientVersion: "19.09.3", deviceModel: "iPhone14,3" },
    { clientName: "WEB", clientVersion: "2.20240101.00.00" },
  ];
  for (const client of clients) {
    try {
      const data = (await fetchJSON(
        "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, context: { client: { hl: "en", gl: "US", ...client } } }),
        },
        proxy,
      )) as PlayerResponse & { playabilityStatus?: { status?: string } };
      if (data.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) return data;
    } catch { /* try next client */ }
  }
  return null;
}

/** Pull the caption tracks straight out of the watch-page HTML — more robust
 * than parsing the giant player-response object, which varies in shape. */
function captionTracksFromHtml(html: string): Array<{ baseUrl?: string; languageCode?: string; kind?: string }> {
  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}

/**
 * yt-dlp caption download — the exact path the full version uses
 * (`_transcript_via_ytdlp`). yt-dlp computes the timedtext URL with the
 * pot-token/signature that a raw HTML scrape can't produce, so this is what
 * actually returns caption bytes; routing it through the residential proxy
 * clears YouTube's IP gate. Returns "" when yt-dlp is unavailable or the
 * video has no captions.
 */
async function transcriptViaYtDlp(videoId: string, evomi: {
  host: string; port: string; user: string; pass: string;
}): Promise<{ transcript: string; title: string; channel: string; uploadDate: string } | null> {
  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const dir = await mkdtemp(path.join(tmpdir(), "gff-yt-"));
  try {
    const args = [
      "--skip-download", "--write-auto-sub", "--write-sub",
      "--sub-lang", "en.*", "--sub-format", "json3",
      "--no-warnings", "--no-playlist",
      // upload_date is authoritative (YYYYMMDD) — far more reliable than the
      // channel page's "3 weeks ago" text, which some layouts omit.
      "--print-to-file", "%(title)s\t%(channel)s\t%(upload_date)s", path.join(dir, "meta.txt"),
      "-o", path.join(dir, "cap.%(ext)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    if (evomi.host && evomi.port) {
      const auth = evomi.user ? `${encodeURIComponent(evomi.user)}:${encodeURIComponent(evomi.pass)}@` : "";
      args.unshift("--proxy", `http://${auth}${evomi.host}:${evomi.port}`);
    }
    await execFileP(bin, args, { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });

    const files = await readdir(dir);
    const capFile = files.find((f) => f.endsWith(".en.json3"))
      || files.find((f) => f.endsWith(".json3"));
    let transcript = "";
    if (capFile) {
      const raw = await readFile(path.join(dir, capFile), "utf8");
      transcript = parseJson3(raw);
    }
    let title = "", channel = "", uploadDate = "";
    try {
      const meta = (await readFile(path.join(dir, "meta.txt"), "utf8")).split("\t");
      title = (meta[0] || "").trim();
      channel = (meta[1] || "").trim();
      uploadDate = ymd(meta[2]);
    } catch { /* meta optional */ }
    return { transcript, title, channel, uploadDate };
  } catch {
    return null; // yt-dlp missing / errored — caller falls back
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** json3 caption payload → text with [m:ss] markers every ~25s of speech. */
function parseJson3(raw: string): string {
  let data: { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> };
  try { data = JSON.parse(raw); } catch { return ""; }
  const parts: string[] = [];
  let lastMark = -30;
  for (const ev of data.events ?? []) {
    const seg = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!seg) continue;
    const startSec = (ev.tStartMs ?? 0) / 1000;
    if (startSec - lastMark >= 25) { parts.push(`[${fmtTs(startSec)}]`); lastMark = startSec; }
    parts.push(seg);
  }
  return parts.join(" ").trim();
}

async function transcript(videoId: string, proxy: ProxyCtx, evomi: {
  host: string; port: string; user: string; pass: string;
}): Promise<{ transcript: string | null; title: string; channel: string; uploadDate: string }> {
  // Primary path: yt-dlp through the Evomi proxy — identical to the full
  // version, and the only path that reliably returns caption bytes.
  const yd = await transcriptViaYtDlp(videoId, evomi);
  if (yd && yd.transcript.length >= 200) {
    return { transcript: yd.transcript, title: yd.title, channel: yd.channel, uploadDate: yd.uploadDate };
  }

  // Fallback (no yt-dlp / no captions): scrape the watch page for metadata and
  // attempt a direct caption fetch (works only on un-gated IPs).
  const body = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {}, proxy);
  const player = extractJSON(body, "ytInitialPlayerResponse = ") as PlayerResponse | null;
  const titleM = body.match(/<meta name="title" content="([^"]*)"/);
  const title = yd?.title || player?.videoDetails?.title || (titleM ? titleM[1] : "");
  const channel = yd?.channel || player?.videoDetails?.author || (body.match(/"author":"([^"]+)"/)?.[1] ?? "");
  // Authoritative date if yt-dlp got it; else the watch page's publishDate meta.
  const uploadDate = yd?.uploadDate || (body.match(/"publishDate":"(\d{4}-\d{2}-\d{2})/)?.[1] ?? "");
  let tracks = captionTracksFromHtml(body);
  if (!tracks.length) tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track =
    tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];
  if (!track?.baseUrl) return { transcript: null, title, channel, uploadDate };
  const text = await fetchTranscriptText(track.baseUrl, proxy);
  return { transcript: text || null, title, channel, uploadDate };
}

/**
 * Fetch a caption track and flatten it to text with [m:ss] markers. The bare
 * timedtext URL returns empty; YouTube needs an explicit format — json3 is the
 * most reliable, with srv3 (XML) as a fallback.
 */
async function fetchTranscriptText(baseUrl: string, proxy?: ProxyCtx): Promise<string> {
  const url = baseUrl.replace(/\\u0026/g, "&");
  // Same headers the full version's caption fetch uses (_transcript_via_ytdlp):
  // Origin/Referer are what make YouTube's timedtext endpoint return content.
  const capHeaders = {
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
    "Accept-Language": "en-US,en;q=0.8",
  };
  const parts: string[] = [];
  let lastMark = -30;
  const mark = (startSec: number) => {
    if (startSec - lastMark >= 25) { parts.push(`[${fmtTs(startSec)}]`); lastMark = startSec; }
  };

  // json3: {"events":[{"tStartMs":..,"segs":[{"utf8":".."}]}]}
  try {
    const raw = await fetchText(`${url}&fmt=json3`, capHeaders, proxy);
    const data = JSON.parse(raw) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> };
    for (const ev of data.events ?? []) {
      const seg = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
      if (!seg) continue;
      mark((ev.tStartMs ?? 0) / 1000);
      parts.push(seg);
    }
    if (parts.some((p) => !p.startsWith("["))) return parts.join(" ").trim();
  } catch { /* fall through to srv3 */ }

  // srv3 / default XML: <text start="12.3" ...>caption</text>
  const clean = (s: string) =>
    s.replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;quot;|&quot;/g, '"')
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  parts.length = 0; lastMark = -30;
  for (const fmt of ["&fmt=srv3", ""]) {
    try {
      const xml = await fetchText(`${url}${fmt}`, capHeaders, proxy);
      for (const m of xml.matchAll(/<(?:text|p)[^>]*(?:start|t)="([\d.]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/g)) {
        const startSec = parseFloat(m[1]) > 10000 ? parseFloat(m[1]) / 1000 : parseFloat(m[1]);
        const text = clean(m[2]);
        if (!text) continue;
        mark(startSec);
        parts.push(text);
      }
      if (parts.some((p) => !p.startsWith("["))) break;
    } catch { /* try next fmt */ }
  }
  return parts.join(" ").trim();
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  try {
    const evomi = evomiFromRequest(req);
    const proxy = (await proxyDispatcher(evomi)) ?? undefined;
    switch (p.get("action")) {
      case "videos": {
        const channel = p.get("channel") || "";
        if (!channel.trim()) return NextResponse.json({ error: "channel required" }, { status: 400 });
        const limit = Math.max(1, Math.min(2000, Number(p.get("limit")) || 15));
        return NextResponse.json(await channelVideos(channel, limit, evomi, proxy));
      }
      case "transcript": {
        const v = (p.get("v") || "").replace(/[^A-Za-z0-9_\-]/g, "");
        if (!v) return NextResponse.json({ error: "v required" }, { status: 400 });
        return NextResponse.json({ ...(await transcript(v, proxy, evomi)), proxied: !!proxy });
      }
      default:
        return NextResponse.json({ error: "action must be videos|transcript" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 502 });
  }
}
