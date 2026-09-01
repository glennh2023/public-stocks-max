"use client";

import { Fragment, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import styles from "../paper/research.module.css";
import {
  loadStore,
  scanChannels,
  syncStore,
  type CallsRun,
  type CallsStore,
  type ScanStatus,
  type YoutubeCall,
} from "@/lib/yt-calls";
import { fetchPrices, type PricePoint } from "@/lib/tiingo-client";

// Sandbox port of the StocksMax YouTube Follow tab: scan finance YouTubers'
// recent uploads, extract every explicit buy/sell/hold call from the caption
// transcripts, browse the call feed, and see calls as colored markers on the
// ticker's price chart (green buy / red sell / amber hold).

const STANCE_COLOR: Record<YoutubeCall["stance"], string> = {
  buy: "#16a34a",
  sell: "#dc2626",
  hold: "#d97706",
};

const DEFAULT_CHANNELS = "@JosephCarlsonShow\n@MeetKevin\nFinancial Education\nDrew Cohen investing";
const RUN_KEY = "gff_sandbox_ytcalls_run";

/** Snap each call to the nearest trading day on the chart (next, else last). */
function buildCallMarkers(calls: YoutubeCall[], priceDates: string[]): Map<string, YoutubeCall[]> {
  const map = new Map<string, YoutubeCall[]>();
  if (!priceDates.length) return map;
  for (const call of calls) {
    if (!call.date) continue;
    const snapped = priceDates.find((d) => d >= call.date) ?? priceDates[priceDates.length - 1];
    map.set(snapped, [...(map.get(snapped) ?? []), call]);
  }
  return map;
}

function StancePill({ stance, rating }: { stance: YoutubeCall["stance"]; rating: string }) {
  return (
    <span className="badge" style={{ color: STANCE_COLOR[stance], borderColor: STANCE_COLOR[stance], fontWeight: 700 }}
      title={rating}>
      {stance.toUpperCase()}
    </span>
  );
}

type ChartRow = PricePoint & { calls: YoutubeCall[] };

function CallTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartRow }> }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "var(--panel2)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12, maxWidth: 320 }}>
      <div style={{ color: "var(--muted)" }}>{row.date} · <b style={{ color: "var(--text)" }}>${row.close.toFixed(2)}</b></div>
      {row.calls.map((c, i) => (
        <div key={i} style={{ marginTop: 6, borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 6 : 0 }}>
          <div>
            <span style={{ color: STANCE_COLOR[c.stance], fontWeight: 700 }}>{c.stance.toUpperCase()}</span>{" "}
            <span style={{ color: "var(--muted)" }}>{c.rating}</span>{" · "}
            <b style={{ color: "var(--text)" }}>{c.youtuber}</b>{" · "}
            {Math.round(c.confidence * 100)}%
            {c.titleOnly ? <span style={{ color: "var(--warn)" }}> · title only</span> : null}
          </div>
          {c.summary ? <div style={{ color: "var(--muted)", marginTop: 2 }}>{c.summary}</div> : null}
          {c.timestamp ? <div style={{ color: "var(--muted)", marginTop: 2 }}>@ {c.timestamp}</div> : null}
        </div>
      ))}
    </div>
  );
}

function CallChart({ ticker, calls }: { ticker: string; calls: YoutubeCall[] }) {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setPrices([]); setErr("");
    fetchPrices(ticker, 1)
      .then((p) => live && setPrices(p))
      .catch((e) => live && setErr(String((e as Error).message || e)));
    return () => { live = false; };
  }, [ticker]);

  const markers = useMemo(
    () => buildCallMarkers(calls.filter((c) => c.ticker === ticker), prices.map((p) => p.date)),
    [calls, ticker, prices],
  );
  // Embed each date's calls into the chart data so the shared Recharts tooltip
  // (which activates on hover anywhere along the line) can render them richly.
  const data = useMemo<ChartRow[]>(
    () => prices.map((p) => ({ ...p, calls: markers.get(p.date) ?? [] })),
    [prices, markers],
  );

  if (err) return <div style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div>;
  if (!prices.length) return <div className="label">Loading {ticker} chart…</div>;

  // Dot renderer: visible only on dates carrying calls — colored by stance
  // (amber when a date carries mixed opinions), like the original.
  const dot = (props: { cx?: number; cy?: number; payload?: ChartRow; index?: number }) => {
    const { cx, cy, payload, index } = props;
    const dayCalls = payload?.calls ?? [];
    if (!dayCalls.length || cx == null || cy == null) return <g key={`d${index}`} />;
    const stances = new Set(dayCalls.map((c) => c.stance));
    const color = stances.size > 1 ? STANCE_COLOR.hold : STANCE_COLOR[dayCalls[0].stance];
    // Larger dot when several calls stack on one date.
    const r = 4 + Math.min(4, dayCalls.length);
    return <circle key={`d${index}`} cx={cx} cy={cy} r={r} fill={color} stroke="#fff" strokeWidth={1.5} />;
  };

  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} minTickGap={56} />
          <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} width={52} domain={["auto", "auto"]}
            tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
          <Tooltip content={<CallTooltip />} />
          <Line type="monotone" dataKey="close" stroke="var(--accent)" strokeWidth={1.6} dot={dot} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function CallsPage() {
  const [channelsText, setChannelsText] = useState(DEFAULT_CHANNELS);
  const [perChannel, setPerChannel] = useState(3);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<ScanStatus[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<CallsRun | null>(null);
  const [store, setStore] = useState<CallsStore | null>(null);
  const [tickerFilter, setTickerFilter] = useState<string>("");
  const [channelSet, setChannelSet] = useState<Set<string>>(new Set()); // empty = all channels
  const [minConfidence, setMinConfidence] = useState<number>(0); // 0-100
  const [openCall, setOpenCall] = useState<string | null>(null);

  const toggleChannel = (c: string) =>
    setChannelSet((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });

  useEffect(() => {
    // Server JSON store first (data/yt-calls.json); browser copy as fallback
    // for serverless deployments where the file store is ephemeral.
    loadStore().then((s) => {
      if (s?.callCount) setStore(s);
      else {
        try {
          const raw = localStorage.getItem(RUN_KEY);
          if (raw) setRun(JSON.parse(raw));
        } catch {}
      }
    });
  }, []);

  const launch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    if (running) return;
    const channels = channelsText.split(/\n+/).map((c) => c.trim()).filter(Boolean).slice(0, 6);
    if (!channels.length) return;
    setRunning(true); setError(null); setLog([]); setStatus([]);
    try {
      // Continue where we left off: skip every video already in the store —
      // both the scanned-video ledger and any video that produced a stored call
      // (so stores created before the ledger existed still skip correctly).
      const skipVideoIds = new Set<string>(store?.scannedVideoIds ?? []);
      if (store) for (const c of Object.values(store.byStock).flat()) skipVideoIds.add(c.videoId);
      const r = await scanChannels({
        channels,
        videosPerChannel: perChannel,
        skipVideoIds,
        onStatus: setStatus,
        onLog: (m) => setLog((l) => [...l, m]),
      });
      setRun(r);
      try { localStorage.setItem(RUN_KEY, JSON.stringify(r)); } catch {}
      const s = await syncStore(r.calls, r.scannedVideoIds);
      if (s) {
        setStore(s);
        setLog((l) => [...l, `Saved to data/yt-calls.json — ${s.callCount} calls indexed by ${Object.keys(s.byChannel).length} channel(s) and ${Object.keys(s.byStock).length} stock(s); ${s.scannedVideoIds.length} videos scanned in total.`]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [channelsText, perChannel, running, store]);

  // The store's byStock index is the source of truth; a fresh un-synced run
  // (serverless fallback) contributes its calls directly.
  const allCalls = useMemo<YoutubeCall[]>(
    () => (store ? Object.values(store.byStock).flat() : run?.calls ?? []),
    [store, run],
  );
  const tickers = useMemo(
    () => (store ? Object.keys(store.byStock).sort() : [...new Set(allCalls.map((c) => c.ticker))].sort()),
    [store, allCalls],
  );
  const channels = useMemo(
    () => (store ? Object.keys(store.byChannel).sort() : [...new Set(allCalls.map((c) => c.youtuber))].sort()),
    [store, allCalls],
  );
  // Shared filter pipeline (channels + confidence) applied to BOTH the chart
  // and the table, so what you see on the chart matches the list.
  const passesFilters = useCallback(
    (c: YoutubeCall) =>
      (channelSet.size === 0 || channelSet.has(c.youtuber)) &&
      c.confidence * 100 >= minConfidence,
    [channelSet, minConfidence],
  );
  const filteredCalls = useMemo(() => allCalls.filter(passesFilters), [allCalls, passesFilters]);
  const visible = filteredCalls.filter((c) => !tickerFilter || c.ticker === tickerFilter);

  // Per-channel counts scoped to the selected stock (and confidence), so the
  // channel chips reflect "how many calls this channel has for THIS view", not
  // the global totals. NOT scoped by the channel filter itself, so each chip
  // still shows its own contribution regardless of what's toggled.
  const channelCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of allCalls) {
      if (tickerFilter && c.ticker !== tickerFilter) continue;
      if (c.confidence * 100 < minConfidence) continue;
      m[c.youtuber] = (m[c.youtuber] ?? 0) + 1;
    }
    return m;
  }, [allCalls, tickerFilter, minConfidence]);
  // When a stock is selected, only surface channels that actually called it.
  const visibleChannels = tickerFilter ? channels.filter((c) => channelCounts[c]) : channels;

  return (
    <section className={styles.wrapper}>
      <h1 style={{ margin: 0 }}>YouTube Calls</h1>
      <p className={styles.hint}>
        Sandbox port of the YouTube Follow tab: scan finance YouTubers&apos; recent
        uploads, extract every explicit <b>buy / sell / hold</b> call from the
        caption transcripts with the AI model, and see the calls as colored
        markers on the ticker&apos;s price chart. Videos without public captions are
        skipped. (The full version adds resilient transcript fetching, background
        scan jobs, the consensus sentiment series and the video judge — full
        version only.)
      </p>

      <form className={styles.controls} onSubmit={launch}>
        <label className={`${styles.field} ${styles.grow}`}>
          <span>Channels — one per line (@handle, channel URL, or name; max 6)</span>
          <textarea rows={4} value={channelsText} onChange={(e) => setChannelsText(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span>Videos per channel (newest unscanned)</span>
          <input className="input" type="number" min={1} max={1000} step={1} style={{ width: 110 }}
            value={perChannel}
            onChange={(e) => setPerChannel(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
        </label>
        <button className={styles.buildBtn} type="submit" disabled={running}>
          {running ? "Scanning…" : "Scan channels"}
        </button>
      </form>

      {(running || status.length > 0) && (
        <div className={styles.savedBar}>
          {status.map((s) => (
            <span key={s.channel}
              className={`${styles.agentStatus} ${s.phase === "done" ? styles.agentDone : s.phase === "scanning" ? styles.agentBusy : ""}`}
              title={s.lastVideo}>
              {s.phase === "done" ? "✓" : s.phase === "error" ? "✕" : s.phase === "scanning" ? "▶" : "…"}{" "}
              {s.channel} {s.phase === "scanning" || s.phase === "done" ? `${s.done}/${s.total}` : ""}
            </span>
          ))}
        </div>
      )}
      {log.length > 0 && (
        <div className="card" style={{ maxHeight: 160, overflowY: "auto", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
          {log.map((m, i) => <div key={i}>{m}</div>)}
        </div>
      )}
      {error ? <div className={styles.errorBox}>{error}</div> : null}

      {allCalls.length || run ? (
        <>
          <div className={styles.savedBar}>
            <span className={styles.agentRowLabel}>
              {filteredCalls.length}{filteredCalls.length !== allCalls.length ? `/${allCalls.length}` : ""} calls
              ({tickerFilter ? `${tickerFilter} · ` : `${tickers.length} stocks · `}
              {tickerFilter ? visibleChannels.length : channels.length} channels
              {store?.updatedAt ? ` · updated ${store.updatedAt.slice(0, 10)}` : ""})
            </span>
            <span className={styles.agentRowLabel}>Stock:</span>
            <select className={styles.styleSelect} value={tickerFilter} onChange={(e) => setTickerFilter(e.target.value)}>
              <option value="">All</option>
              {tickers.map((t) => <option key={t} value={t}>{t} ({store?.byStock[t]?.length ?? ""})</option>)}
            </select>
            {store ? (
              <button className={styles.pdfBtn} type="button"
                onClick={async () => {
                  await fetch("/api/calls-store", { method: "DELETE" });
                  setStore(null); setRun(null); setTickerFilter(""); setChannelSet(new Set()); setMinConfidence(0);
                  try { localStorage.removeItem(RUN_KEY); } catch {}
                }}>
                Clear store
              </button>
            ) : null}
          </div>

          {/* Multi-select channels (a combination) + confidence threshold —
              both apply to the chart and the table below. */}
          <div className={styles.savedBar} style={{ alignItems: "center" }}>
            <span className={styles.agentRowLabel}>Channels:</span>
            <button type="button"
              className={`${styles.agentStatus} ${channelSet.size === 0 ? styles.agentDone : ""}`}
              style={{ cursor: "pointer" }}
              onClick={() => setChannelSet(new Set())}>
              All
            </button>
            {visibleChannels.map((c) => (
              <button key={c} type="button"
                className={`${styles.agentStatus} ${channelSet.has(c) ? styles.agentDone : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => toggleChannel(c)}>
                {channelSet.has(c) ? "✓ " : ""}{c} ({channelCounts[c] ?? 0})
              </button>
            ))}
          </div>
          <div className={styles.savedBar} style={{ alignItems: "center" }}>
            <span className={styles.agentRowLabel}>Min confidence: {minConfidence}%</span>
            <input type="range" min={0} max={100} step={5} value={minConfidence}
              onChange={(e) => setMinConfidence(Number(e.target.value))}
              style={{ width: 220 }} />
            <span className={styles.agentRowLabel}>
              (chart markers &amp; list show calls at ≥ {minConfidence}% confidence)
            </span>
          </div>

          {tickerFilter ? (
            <div className="card">
              <div className="label" style={{ marginBottom: 6 }}>
                {tickerFilter} · 1y price with call markers (green buy · red sell · amber hold/mixed) ·
                hover a dot for details{minConfidence > 0 ? ` · ≥${minConfidence}% confidence` : ""}
                {channelSet.size ? ` · ${channelSet.size} channel(s)` : ""}
              </div>
              <CallChart ticker={tickerFilter} calls={filteredCalls} />
            </div>
          ) : null}

          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Ticker</th><th>Call</th><th>Conf.</th><th>Creator</th><th>Video</th><th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const id = `${c.videoId}:${c.ticker}`;
                  return (
                    <Fragment key={id}>
                      <tr>
                        <td style={{ whiteSpace: "nowrap" }}>{c.date || "—"}</td>
                        <td style={{ fontWeight: 700 }}>
                          <a href="#" onClick={(e) => { e.preventDefault(); setTickerFilter(c.ticker); }}>{c.ticker}</a>
                        </td>
                        <td>
                          <StancePill stance={c.stance} rating={c.rating} /> <span className="label">{c.rating}</span>
                          {c.titleOnly ? <span className="badge warn" style={{ marginLeft: 6 }}>title only</span> : null}
                        </td>
                        <td>{Math.round(c.confidence * 100)}%</td>
                        <td>{c.youtuber}</td>
                        <td style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <a href={c.videoUrl} target="_blank" rel="noreferrer">{c.videoTitle}</a>
                        </td>
                        <td>
                          <a href="#" style={{ fontSize: 12 }}
                            onClick={(e) => { e.preventDefault(); setOpenCall(openCall === id ? null : id); }}>
                            {openCall === id ? "hide" : "details"}
                          </a>
                        </td>
                      </tr>
                      {openCall === id ? (
                        <tr>
                          <td colSpan={7} style={{ fontSize: 13, color: "var(--muted)" }}>
                            <b style={{ color: "var(--text)" }}>AI summary:</b> {c.summary || "—"}
                            {c.quote ? <><br /><b style={{ color: "var(--text)" }}>Quote:</b> “{c.quote}”</> : null}
                            {c.transcriptExcerpt ? (
                              <><br /><b style={{ color: "var(--text)" }}>Transcript:</b> <i>“{c.transcriptExcerpt}”</i></>
                            ) : null}
                            {c.timestamp ? (
                              <><br /><b style={{ color: "var(--text)" }}>Timestamp:</b>{" "}
                                <a href={c.videoUrl} target="_blank" rel="noreferrer">{c.timestamp} ▶</a></>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!visible.length && (
                  <tr><td colSpan={7} style={{ color: "var(--muted)" }}>No calls extracted{tickerFilter ? ` for ${tickerFilter}` : ""}.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <p className={styles.hint}>
            Calls are AI-extracted from public captions and may miss or misread context —
            verify against the linked video. Demo output, not investment advice.
          </p>
        </>
      ) : (
        !running && (
          <p className={styles.hint}>
            Add channels (one per line) and hit Scan. Each channel&apos;s recent uploads are
            listed, transcripts pulled from public captions, and the AI extracts every
            explicit call with the creator&apos;s own rating words, a confidence score, the
            argument summary and a verbatim quote.
          </p>
        )
      )}
    </section>
  );
}
