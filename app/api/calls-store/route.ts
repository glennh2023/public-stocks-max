import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

// Persistent JSON store for YouTube call scans, written to data/yt-calls.json
// (gitignored). The store is deliberately DOUBLE-INDEXED — every call is
// stored under both its channel and its ticker — trading storage for instant
// lookups in either direction, per the export design.
//
// NOTE: on serverless hosts (Vercel) the filesystem is ephemeral — the store
// works locally / on a persistent server; deployed demos fall back to the
// browser copy the page also keeps.

type YoutubeCall = {
  youtuber: string;
  ticker: string;
  company?: string;
  date: string;
  stance: "buy" | "sell" | "hold";
  rating: string;
  confidence: number;
  summary: string;
  quote: string;
  transcriptExcerpt?: string;
  timestamp?: string;
  titleOnly?: boolean;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
};

type Store = {
  updatedAt: string;
  callCount: number;
  byChannel: Record<string, YoutubeCall[]>;
  byStock: Record<string, YoutubeCall[]>;
  scannedVideoIds: string[];
};

const FILE = path.join(process.cwd(), "data", "yt-calls.json");

const EMPTY: Store = { updatedAt: "", callCount: 0, byChannel: {}, byStock: {}, scannedVideoIds: [] };

async function load(): Promise<Store> {
  try {
    const s = JSON.parse(await readFile(FILE, "utf8")) as Store;
    if (!Array.isArray(s.scannedVideoIds)) s.scannedVideoIds = []; // migrate old stores
    return s;
  } catch {
    return structuredClone(EMPTY);
  }
}

async function save(store: Store) {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 1), "utf8");
}

const callKey = (c: YoutubeCall) => `${c.videoId}:${c.ticker}`;

export async function GET() {
  return NextResponse.json(await load());
}

export async function POST(req: NextRequest) {
  let body: { calls?: YoutubeCall[]; scannedVideoIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const incoming = (body.calls ?? []).filter((c) => c?.videoId && c?.ticker && c?.stance);
  const store = await load();

  // Merge with dedupe (a rescan of the same video replaces its old calls).
  const rescanned = new Set(incoming.map((c) => c.videoId));
  const all = new Map<string, YoutubeCall>();
  for (const list of Object.values(store.byChannel)) {
    for (const c of list) if (!rescanned.has(c.videoId)) all.set(callKey(c), c);
  }
  for (const c of incoming) all.set(callKey(c), c);

  const merged = [...all.values()].sort(
    (a, b) => (b.date || "").localeCompare(a.date || "") || b.confidence - a.confidence,
  );
  // Scanned-video ledger: prior ids + every id from this scan (from the
  // reported list and from any calls), so zero-call videos are remembered too.
  const scanned = new Set(store.scannedVideoIds);
  for (const id of body.scannedVideoIds ?? []) if (id) scanned.add(id);
  for (const c of incoming) scanned.add(c.videoId);

  const next: Store = {
    updatedAt: new Date().toISOString(),
    callCount: merged.length,
    byChannel: {},
    byStock: {},
    scannedVideoIds: [...scanned],
  };
  for (const c of merged) {
    (next.byChannel[c.youtuber] ??= []).push(c);
    (next.byStock[c.ticker] ??= []).push(c);
  }
  await save(next);
  return NextResponse.json(next);
}

export async function DELETE() {
  await save(structuredClone(EMPTY));
  return NextResponse.json(structuredClone(EMPTY));
}
