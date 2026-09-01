"use client";

// YouTube Calls scanner — sandbox port of the StocksMax YouTube Follow tab
// (`web/src/app/youtube/YouTubeFollowTab.tsx` + its Python scan pipeline):
// scrape channels' recent uploads, pull each video's caption transcript, and
// have the LLM (user's OpenRouter key, or the dev .env fallback) extract every
// explicit buy/sell/hold call. Same call shape as the original. The full
// version adds resilient transcript fetching (yt-dlp/proxies), background
// scan jobs, the sentiment consensus series and the video judge — all
// full-version only.

import { DEFAULT_MODEL, getSetting } from "./settings";

export type YoutubeCall = {
  youtuber: string; // channel name
  ticker: string;
  company?: string;
  date: string; // approx video publish date (YYYY-MM-DD)
  stance: "buy" | "sell" | "hold";
  rating: string; // the creator's own words ("strong buy", "trim", …)
  confidence: number; // 0-1: how explicit/committed the call is
  summary: string; // AI summary of the reasoning
  quote: string; // short verbatim quote stating the call
  transcriptExcerpt?: string; // the relevant transcript passage around the call
  timestamp?: string; // "m:ss" position in the video, when derivable
  titleOnly?: boolean; // extracted from the title alone (no captions available)
  videoId: string;
  videoTitle: string;
  videoUrl: string; // deep-links to the timestamp when known
};

export type CallsStore = {
  updatedAt: string;
  callCount: number;
  byChannel: Record<string, YoutubeCall[]>;
  byStock: Record<string, YoutubeCall[]>;
  // Every video that has been scanned — INCLUDING ones that yielded no calls —
  // so future scans skip them instead of re-downloading + re-extracting.
  scannedVideoIds: string[];
};

export type ChannelScan = {
  channel: string;
  channelName: string;
  videosScanned: number;
  videosFailed: number; // no transcript / fetch error
  callCount: number;
};

export type CallsRun = {
  generatedAt: string;
  channels: ChannelScan[];
  calls: YoutubeCall[];
  scannedVideoIds: string[]; // videos actually processed this run (calls or not)
};

export type ScanStatus = {
  channel: string;
  phase: "listing" | "scanning" | "done" | "error";
  done: number;
  total: number;
  lastVideo?: string;
};

type VideoRow = {
  videoId: string;
  title: string;
  published: string | null;
  publishedText: string;
  views: string;
  length: string;
};

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

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: evomiHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

async function extractCalls(
  channelName: string,
  video: VideoRow,
  transcriptText: string,
): Promise<YoutubeCall[]> {
  const key = getSetting("openrouter");
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
    body: JSON.stringify({
      model: getSetting("model") || DEFAULT_MODEL,
      // High cap so an exhaustive list (a listicle video can have 10+ calls,
      // each with an excerpt) is never truncated mid-JSON, and low temperature
      // for consistent extraction — mirrors the full version's extractor.
      max_tokens: 6000,
      temperature: 0.1,
      system:
        'You extract EVERY explicit stock call from a finance YouTuber\'s video transcript. The transcript carries [m:ss] time markers. Output ONLY JSON: {"calls": [{"ticker": "NVDA", "company": "Nvidia", "stance": "buy|sell|hold", "rating": "their own words, e.g. strong buy / trimming / waiting for a pullback", "confidence": 0.0-1.0, "summary": "1-2 sentences of their reasoning", "quote": "a short verbatim quote stating the call", "transcript_excerpt": "the verbatim transcript passage around the call, 2-4 sentences, no [m:ss] markers", "timestamp": "m:ss of the nearest marker before the call, or null"}]}. ' +
        "BE EXHAUSTIVE: many videos (especially listicles like \"9 stocks…\", \"my top picks\", \"stocks I'm buying\") walk through MANY companies and give an opinion on each — you MUST return an entry for EVERY one, not just the first or the most emphatic. Re-scan the whole transcript before finishing. " +
        "RULES: include a stock whenever the creator expresses a real opinion or action — buying/adding/bullish/undervalued (buy), selling/trimming/avoiding/overvalued (sell), holding/waiting/neutral (hold). A pure passing mention with no stance, a news recap, or a stock they explicitly say they do NOT cover is NOT a call. " +
        "CONFIDENCE DISCIPLINE (important for accuracy): confidence reflects how committed and unambiguous the call is. When the speaker HEDGES or DISCLAIMS — 'not telling you to invest', 'not advice', 'tiny/teeny/nominal position', 'I don't really follow it', vague excitement without a stance — set confidence ≤ 0.4, and if there is no genuine actionable stance at all, DROP it rather than inventing one. Reserve 0.8+ for explicit, emphatic calls ('I'm buying', 'strong buy', 'I sold'). " +
        "Map company names to their correct current US ticker (Costco→COST, Alphabet/Google→GOOGL, Mercado Libre→MELI, Reddit→RDDT, Nebius/Nebius Group→NBIS — never NMBL, Rollins→ROL, Copart→CPRT, Moderna→MRNA, BioNTech→BNTX, Eli Lilly→LLY). If you cannot confidently map a name to a real current US ticker, lower confidence rather than guessing a delisted symbol. ETFs are allowed (VOO, SCHD). Skip pure crypto. One entry per ticker — merge repeated discussion of the same stock into its single strongest call. If there are genuinely no calls, return {\"calls\": []}.",
      prompt:
        `Channel: ${channelName}\nVideo: "${video.title}" (published ${video.published ?? video.publishedText})\n\nTRANSCRIPT:\n${transcriptText.slice(0, 120000)}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "AI extraction failed");
  try {
    const cleaned = (data.text as string).replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as {
      calls?: Array<Partial<YoutubeCall> & { transcript_excerpt?: string; timestamp?: string | null }>;
    };
    return (parsed.calls ?? [])
      .filter((c) => c.ticker && ["buy", "sell", "hold"].includes(c.stance ?? ""))
      .map((c) => {
        const ts = typeof c.timestamp === "string" && /^\d+:\d{2}$/.test(c.timestamp) ? c.timestamp : undefined;
        const tsSecs = ts ? parseInt(ts.split(":")[0], 10) * 60 + parseInt(ts.split(":")[1], 10) : null;
        return {
          youtuber: channelName,
          ticker: String(c.ticker).toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 6),
          company: c.company,
          date: video.published ?? "",
          stance: c.stance as YoutubeCall["stance"],
          rating: c.rating ?? c.stance ?? "",
          confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
          summary: c.summary ?? "",
          quote: c.quote ?? "",
          transcriptExcerpt: c.transcript_excerpt || undefined,
          timestamp: ts,
          videoId: video.videoId,
          videoTitle: video.title,
          videoUrl: `https://www.youtube.com/watch?v=${video.videoId}${tsSecs ? `&t=${tsSecs}s` : ""}`,
        };
      })
      .filter((c) => c.ticker.length >= 1);
  } catch {
    return []; // malformed extraction for one video shouldn't sink the scan
  }
}

/**
 * Fallback when a video has no reachable captions (YouTube bot-gates caption
 * tracks for some IPs): extract from the title alone, capped at low
 * confidence and flagged `titleOnly` so the UI can show what it's based on.
 */
async function extractFromTitle(channelName: string, video: VideoRow): Promise<YoutubeCall[]> {
  const key = getSetting("openrouter");
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
    body: JSON.stringify({
      model: getSetting("model") || DEFAULT_MODEL,
      system:
        'A finance video\'s TITLE ONLY is available (no transcript). Output ONLY JSON: {"calls": [{"ticker": "...", "company": "...", "stance": "buy|sell|hold", "confidence": 0.0-0.35, "summary": "what the title implies"}]}. Extract a call ONLY when the title itself unambiguously states the creator\'s own stance on a specific public stock (e.g. "Why I\'m Selling NVDA"). Clickbait, questions and news recaps are NOT calls — for those return {"calls": []}.',
      prompt: `Channel: ${channelName}\nTitle: "${video.title}" (published ${video.published ?? video.publishedText})`,
    }),
  });
  const data = await res.json();
  if (!res.ok) return [];
  try {
    const cleaned = (data.text as string).replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as {
      calls?: Array<Partial<YoutubeCall>>;
    };
    return (parsed.calls ?? [])
      .filter((c) => c.ticker && ["buy", "sell", "hold"].includes(c.stance ?? ""))
      .map((c) => ({
        youtuber: channelName,
        ticker: String(c.ticker).toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 6),
        company: c.company,
        date: video.published ?? "",
        stance: c.stance as YoutubeCall["stance"],
        rating: `${c.stance} (title only)`,
        confidence: Math.min(0.35, Math.max(0, Number(c.confidence) || 0.25)),
        summary: c.summary ?? "",
        quote: video.title,
        transcriptExcerpt: "(no captions available — extracted from the video title only)",
        titleOnly: true,
        videoId: video.videoId,
        videoTitle: video.title,
        videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      }))
      .filter((c) => c.ticker.length >= 1);
  } catch {
    return [];
  }
}

/** Merge a scan's calls into the server-side JSON store (data/yt-calls.json). */
export async function syncStore(calls: YoutubeCall[], scannedVideoIds: string[] = []): Promise<CallsStore | null> {
  try {
    const res = await fetch("/api/calls-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, scannedVideoIds }),
    });
    if (!res.ok) return null;
    return (await res.json()) as CallsStore;
  } catch {
    return null;
  }
}

export async function loadStore(): Promise<CallsStore | null> {
  try {
    const res = await fetch("/api/calls-store");
    if (!res.ok) return null;
    return (await res.json()) as CallsStore;
  } catch {
    return null;
  }
}

export async function scanChannels(opts: {
  channels: string[];
  videosPerChannel: number;
  // Videos already in the store — skipped so a rescan continues where it left
  // off instead of re-downloading and re-extracting the same uploads.
  skipVideoIds?: Set<string>;
  onStatus: (s: ScanStatus[]) => void;
  onLog: (m: string) => void;
}): Promise<CallsRun> {
  const perChannel = Math.max(1, Math.min(1000, opts.videosPerChannel));
  const skip = opts.skipVideoIds ?? new Set<string>();
  // List enough to still yield `perChannel` NEW videos after skipping the ones
  // already scanned (skip is global, so this is a safe upper bound).
  const listLimit = Math.min(2000, perChannel + skip.size);
  const statuses: ScanStatus[] = opts.channels.map((c) => ({
    channel: c, phase: "listing", done: 0, total: perChannel,
  }));
  const push = () => opts.onStatus(statuses.map((s) => ({ ...s })));
  push();

  const results = await Promise.all(
    opts.channels.map(async (channel, i): Promise<{ scan: ChannelScan; calls: YoutubeCall[]; scannedIds: string[] }> => {
      const st = statuses[i];
      const scan: ChannelScan = { channel, channelName: channel, videosScanned: 0, videosFailed: 0, callCount: 0 };
      const calls: YoutubeCall[] = [];
      const scannedIds: string[] = [];
      try {
        const listing = await getJSON<{ channelName: string; videos: VideoRow[] }>(
          `/api/youtube-channel?action=videos&channel=${encodeURIComponent(channel)}&limit=${listLimit}`,
        );
        scan.channelName = listing.channelName;
        // Take the newest N videos NOT already scanned — so "2 per channel"
        // means two new ones each run, walking further back over time.
        const fresh = listing.videos.filter((v) => !skip.has(v.videoId));
        const skipped = listing.videos.length - fresh.length;
        const videos = fresh.slice(0, perChannel);
        st.total = videos.length;
        st.phase = "scanning"; push();
        opts.onLog(
          `${listing.channelName}: ${videos.length} new video(s) to scan` +
          (skipped ? ` (${skipped} already scanned, skipped)` : "") +
          (videos.length === 0 ? " — nothing new." : "."),
        );

        // Videos scan sequentially per channel (channels run in parallel) so
        // one channel can't monopolize the AI proxy with a burst of calls.
        for (const v of videos) {
          st.lastVideo = v.title; push();
          scannedIds.push(v.videoId);
          try {
            const t = await getJSON<{ transcript: string | null; uploadDate?: string; title?: string; channel?: string }>(
              `/api/youtube-channel?action=transcript&v=${v.videoId}`,
            );
            // Prefer yt-dlp's authoritative upload date, title and channel name
            // over the listing's — the channel-page text is unreliable, and the
            // authoritative channel name keeps the byChannel index consistent.
            const vd: VideoRow = { ...v, published: t.uploadDate || v.published, title: t.title || v.title };
            const channelLabel = t.channel || listing.channelName;
            if (!t.transcript) {
              // Bot-gated or caption-less video → honest title-only fallback.
              const found = await extractFromTitle(channelLabel, vd);
              scan.videosFailed++;
              scan.callCount += found.length;
              calls.push(...found);
              opts.onLog(`  ⏭ no captions: "${vd.title.slice(0, 60)}"${found.length ? ` → ${found.length} title-only call(s)` : ""}`);
            } else {
              const found = await extractCalls(channelLabel, vd, t.transcript);
              scan.videosScanned++;
              scan.callCount += found.length;
              calls.push(...found);
              opts.onLog(`  ✓ "${vd.title.slice(0, 60)}" → ${found.length} call(s)`);
            }
          } catch (e) {
            scan.videosFailed++;
            opts.onLog(`  ✕ "${v.title.slice(0, 60)}": ${(e as Error).message}`);
          }
          st.done++; push();
        }
        st.phase = "done"; push();
      } catch (e) {
        st.phase = "error"; push();
        opts.onLog(`${channel} failed: ${(e as Error).message}`);
      }
      return { scan, calls, scannedIds };
    }),
  );

  const calls = results
    .flatMap((r) => r.calls)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.confidence - a.confidence);
  const scannedVideoIds = results.flatMap((r) => r.scannedIds);
  opts.onLog(
    scannedVideoIds.length
      ? `Scan complete: ${calls.length} new call(s) from ${scannedVideoIds.length} new video(s).`
      : "Nothing new to scan — all recent videos already in the store.",
  );
  return {
    generatedAt: new Date().toISOString(),
    channels: results.map((r) => r.scan),
    calls,
    scannedVideoIds,
  };
}
