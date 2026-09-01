"use client";

// Sandbox port of the StocksMax Research cited research pipeline — the same
// design as the full app's `lib/research.ts` and the standalone
// `legacy-python/pipeline.py`:
//
//   planner → parallel source sweeps → STORY-EDITOR GAP LOOP (each round the
//   editor reviews what the findings establish, names the gaps, dispatches new
//   targeted queries) → cited writer → MONEY TREE agent.
//
// When a ticker is given, the run is grounded first: SEC XBRL company facts
// are normalized server-side (/api/xbrl) into a dated fact sheet whose lines
// become verified findings and travel with every later prompt.
//
// The money tree is the heart of it: consolidated revenue → segments →
// products/streams, each node carrying its latest size, PERIOD HISTORY
// (so you can time-travel across quarters/years), a "since" year (streams
// honestly show "n/a — didn't exist yet" before launch), analyst-style
// estimates with the math shown, and a 3-state honesty model per period:
// found / searched-but-not-found / never-searched. Per-cell 🔍 hunts and
// validated manual input round it out.

import { DEFAULT_MODEL, getSetting } from "./settings";

export type SourceId = "youtube" | "web" | "news" | "hn" | "edgar";

export type Finding = {
  id: number;
  source: SourceId;
  url: string;
  title: string;
  content: string;
  published: string | null;
};

/** Money tree node (ported from `pipeline.py` `_tree` / the full app's MoneyMap). */
export type MoneyNode = {
  name: string;
  value?: string;
  share?: string;
  growth?: string;
  margin?: string;
  note?: string;
  estimated?: boolean;
  basis?: string;
  citations?: number[];
  /** This node's size at OTHER dates — label ("FY2024", "Q2 FY2026") → value. */
  periods?: Record<string, string>;
  /** Year/period the stream started existing (launch, acquisition close). */
  since?: string;
  /** Honesty ledger: period label → "found" | "not_found" after a hunt ran. */
  searched_periods?: Record<string, "found" | "not_found">;
  /** Period labels whose value was entered manually by the user. */
  manual_labels?: string[];
  /** Consistency warnings from validateTree (children out-summing the parent). */
  warnings?: string[];
  children?: MoneyNode[];
};

export type ResearchRun = {
  topic: string;
  ticker?: string | null;
  cik?: string | null;
  factSheet?: string | null;
  generatedAt: string;
  report: string;
  findings: Finding[];
  moneyMap?: MoneyNode | null;
};

export const SOURCE_AGENTS: { id: SourceId; label: string }[] = [
  { id: "youtube", label: "YouTube agent" },
  { id: "web", label: "Web agent (DuckDuckGo)" },
  { id: "news", label: "News agent (Google News)" },
  { id: "hn", label: "Hacker News agent" },
  { id: "edgar", label: "EDGAR agent (SEC full-text)" },
];

export type SourceStatus = Record<string, "pending" | "searching" | "done" | "empty" | "error">;

// ---------------------------------------------------------------- helpers ----

async function sweep(source: string, q: string, cik?: string | null): Promise<Omit<Finding, "id">[]> {
  const res = await fetch(
    `/api/research-sources?q=${encodeURIComponent(q)}&source=${source}${cik ? `&cik=${cik}` : ""}`,
  );
  const data = await res.json();
  if (data.error && !data.findings?.length) throw new Error(data.error);
  return data.findings ?? [];
}

async function callAI(system: string, prompt: string): Promise<string> {
  const key = getSetting("openrouter");
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-openrouter-key": key } : {}) },
    body: JSON.stringify({ model: getSetting("model") || DEFAULT_MODEL, system, prompt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "AI request failed — check your OpenRouter key in Settings.");
  return data.text as string;
}

function parseJSON<T>(text: string): T | null {
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as T;
  } catch {
    return null;
  }
}

/** Strip search operators the basic engines can't handle ("quoted", OR, AND). */
function plainQuery(q: string): string {
  return q.replace(/"/g, " ").replace(/ OR /g, " ").replace(/ AND /g, " ").replace(/\s+/g, " ").trim();
}

/**
 * '$23.77B' / '~$450M' / '>$500M ARR' / '~$500-600M' → dollars as a number.
 * Ranges resolve to their LOWER bound (conservative for validation sums).
 * Returns null when no money-like token is present.
 * (Port of `pipeline.py` `parse_money`, including the range-aware regex.)
 */
export function parseMoney(value: string | undefined | null): number | null {
  const m = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:[-–—]\s*[\d,]+(?:\.\d+)?)?\s*([BbMmKk])?/.exec(String(value ?? ""));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = { B: 1e9, M: 1e6, K: 1e3 }[(m[2] || "").toUpperCase() as "B" | "M" | "K"] ?? 1;
  return n * mult;
}

/**
 * Consistency checks; annotates nodes with `warnings` and returns them all.
 * Rule: a node's sized children shouldn't sum past ~118% of the node (segment
 * overlap and rounding earn slack) — checked for the latest values and for
 * every shared period label. (Port of `pipeline.py` `validate_tree`.)
 */
export function validateTree(tree: MoneyNode | null | undefined): string[] {
  const all: string[] = [];
  function check(node: MoneyNode) {
    delete node.warnings;
    const kids = node.children ?? [];
    const warns: string[] = [];
    const parentV = parseMoney(node.value);
    const kidVs = kids.map((k) => parseMoney(k.value));
    if (parentV && kids.length && kidVs.every((v) => v !== null)) {
      const total = (kidVs as number[]).reduce((s, v) => s + v, 0);
      if (total > parentV * 1.18) {
        warns.push(`children sum to $${(total / 1e9).toFixed(2)}B — exceeds this node's $${(parentV / 1e9).toFixed(2)}B`);
      }
    }
    for (const label of Object.keys(node.periods ?? {})) {
      const pv = parseMoney(node.periods?.[label]);
      const kvs = kids.map((k) => parseMoney(k.periods?.[label]));
      const sized = kvs.filter((v): v is number => v !== null);
      if (pv && sized.length && sized.length === kids.length && sized.reduce((s, v) => s + v, 0) > pv * 1.18) {
        warns.push(`${label}: children sum exceeds this node's ${label} value`);
      }
    }
    if (warns.length) {
      node.warnings = warns;
      all.push(...warns.map((w) => `${node.name}: ${w}`));
    }
    kids.forEach(check);
  }
  if (tree) check(tree);
  return all;
}

function listing(findings: Finding[], perItem = 300): string {
  return findings
    .map((f) => `[${f.id}] (${f.source}${f.published ? `, ${f.published}` : ""}) ${f.title} — ${f.content.slice(0, perItem)}`)
    .join("\n");
}

/** One parallel sweep of all source agents for a set of queries (round-robin). */
async function sweepRound(
  queries: string[],
  cik: string | null | undefined,
  status: SourceStatus,
  push: () => void,
  onLog: (m: string) => void,
): Promise<Omit<Finding, "id">[]> {
  const results = await Promise.all(
    SOURCE_AGENTS.map(async (a, i) => {
      const q = queries[i % queries.length];
      status[a.id] = "searching"; push();
      try {
        const f = await sweep(a.id, q, cik);
        status[a.id] = f.length ? "done" : "empty"; push();
        onLog(`${a.label} · "${q}": ${f.length} findings.`);
        return f;
      } catch (e) {
        status[a.id] = "error"; push();
        onLog(`${a.label} failed: ${(e as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
}

// ---------------------------------------------------------------- pipeline ----

export async function runResearch(opts: {
  topic: string;
  ticker?: string;
  maxRounds?: number;
  onStatus: (s: SourceStatus) => void;
  onLog: (m: string) => void;
}): Promise<ResearchRun> {
  const topic = opts.topic.trim();
  const maxRounds = Math.max(1, Math.min(5, opts.maxRounds ?? 3));
  const status: SourceStatus = Object.fromEntries(SOURCE_AGENTS.map((a) => [a.id, "pending"]));
  const push = () => opts.onStatus({ ...status });
  push();

  // Grounding: with a ticker, pull the verified SEC XBRL fact sheet first.
  // Its lines become findings (so the writer can cite them as [n]) and the
  // whole sheet rides along in every later prompt as time-disciplined context.
  let ticker: string | null = null, cik: string | null = null, factSheet: string | null = null;
  const grounding: Omit<Finding, "id">[] = [];
  if (opts.ticker?.trim()) {
    ticker = opts.ticker.trim().toUpperCase();
    opts.onLog(`Grounding: pulling verified SEC XBRL financials for ${ticker}…`);
    try {
      const res = await fetch(`/api/xbrl?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "XBRL fetch failed");
      cik = data.cik; factSheet = data.sheet;
      const lines = (data.sheet as string).split("\n").filter((l) => l.includes(":"));
      for (const line of lines) {
        grounding.push({
          source: "edgar", url: data.url,
          title: `Verified: ${line.slice(0, 90)}`,
          content: `${line}\n(SEC XBRL as filed — beats all social/news sources on these figures.)`,
          published: null,
        });
      }
      opts.onLog(`Grounding: ${lines.length} verified fact-sheet lines from ${data.name} (CIK ${cik}).`);
    } catch (e) {
      opts.onLog(`Grounding unavailable (${(e as Error).message}) — continuing unverified.`);
    }
  }
  const context = factSheet
    ? `VERIFIED FACT SHEET (SEC XBRL — these figures win all conflicts; never blend periods):\n${factSheet}\n\n`
    : "";

  // Planner: turn the topic into distinct search angles.
  opts.onLog(`Planner: framing search angles for "${topic}"…`);
  let queries = [topic];
  const planned = parseJSON<{ queries: string[] }>(
    await callAI(
      'You are the research planner. Given a topic, output ONLY JSON: {"queries": ["...", "...", "..."]} — 3 distinct, concrete search queries (3-6 words each) that together cover the topic from different angles (the event itself, the financial/company angle, the skeptical/critical angle). PLAIN KEYWORDS ONLY — no quotes, no OR (the engines are basic). Prefer numbers-not-narratives phrasing. No preamble.',
      `TOPIC: ${topic}${ticker ? ` (ticker ${ticker})` : ""}`,
    ).catch(() => ""),
  );
  if (planned?.queries?.length) {
    queries = planned.queries.slice(0, 3).map(plainQuery);
    opts.onLog(`Planner angles: ${queries.map((q) => `"${q}"`).join(" · ")}`);
  }

  const seen = new Set<string>();
  const collected: Omit<Finding, "id">[] = [...grounding];
  grounding.forEach((f) => seen.add(f.url));
  const addNew = (batch: Omit<Finding, "id">[]) => {
    let added = 0;
    for (const f of batch) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      collected.push(f);
      added++;
    }
    return added;
  };

  // The story-editor gap loop: sweep → editor reviews coverage → new targeted
  // queries → sweep again, until sufficient or out of rounds.
  for (let round = 1; round <= maxRounds; round++) {
    opts.onLog(`— Round ${round}/${maxRounds}: sweeping sources…`);
    const added = addNew(await sweepRound(queries, cik, status, push, opts.onLog));
    opts.onLog(`Round ${round}: ${added} new findings (${collected.length} total).`);
    if (round === maxRounds) break;
    if (collected.length === grounding.length) continue; // nothing swept yet — retry

    opts.onLog(`Story editor reviewing coverage after round ${round}…`);
    const digest = collected
      .map((f, i) => `[${i + 1}] (${f.source}${f.published ? `, ${f.published}` : ""}) ${f.title} — ${f.content.slice(0, 200)}`)
      .join("\n");
    const review = parseJSON<{ sufficient: boolean; gaps: string[]; queries: string[] }>(
      await callAI(
        'You are the story editor on a research desk. Review what the findings actually establish about the topic and decide whether the story is fully sourced. Output ONLY JSON: {"sufficient": true|false, "gaps": ["what is still unsourced or one-sided"], "queries": ["2-3 new concrete search queries, 3-6 words each, targeting exactly those gaps"]}. Be demanding: numbers without primary sources, missing counterarguments, and stale coverage all count as gaps. PLAIN KEYWORDS in queries — no quotes/OR. Never repeat a query already run.',
        `${context}TOPIC: ${topic}\nQUERIES ALREADY RUN: ${[...new Set(queries)].join(" · ")}\n\nFINDINGS SO FAR:\n${digest}`,
      ).catch(() => ""),
    );
    if (!review) { opts.onLog("Editor returned malformed review — stopping the loop."); break; }
    if (review.sufficient || !review.queries?.length) {
      opts.onLog("Editor: coverage sufficient — moving to the writer.");
      break;
    }
    opts.onLog(`Editor gaps: ${(review.gaps ?? []).slice(0, 3).join(" · ") || "(unspecified)"}`);
    queries = review.queries.slice(0, 3).map(plainQuery);
  }

  const findings: Finding[] = collected.map((f, i) => ({ ...f, id: i + 1 }));
  if (!findings.length) throw new Error("No findings from any source — try a broader topic.");

  opts.onLog(`Writer drafting the cited brief from ${findings.length} findings…`);
  const evidence = findings
    .map((f) => `[${f.id}] (${f.source}${f.published ? `, ${f.published}` : ""}) ${f.title}\n${f.content.slice(0, 1500)}`)
    .join("\n\n");
  const report = await callAI(
    "You are the writer on a research team producing a cited research brief in markdown. " +
      "STRUCTURE: # title, a 2-paragraph ## Summary, then 3-5 thematic ## sections of full prose, " +
      "then ## What we don't know yet (honest gaps), no citation list (the app renders it). " +
      "CITATION POLICY: every factual claim must end with its evidence marker like [3] or [1][7], " +
      "using ONLY the bracketed ids provided. Never invent an id, never state a fact you cannot cite. " +
      "Verified fact-sheet findings are as-filed SEC data and beat news, which beats forum chatter; note disagreements. " +
      "Never blend numbers from different periods — state each number's period. " +
      "PLAIN TEXT arithmetic only — never LaTeX. Target 700-1100 words.",
    `${context}TOPIC: ${topic}\n\nEVIDENCE:\n${evidence}`,
  );
  opts.onLog("Done.");

  return { topic, ticker, cik, factSheet, generatedAt: new Date().toISOString(), report, findings };
}

// -------------------------------------------------------------- money tree ----

const TREE_SYSTEM = `Build a TREE of the key information from research findings. For a company: root = consolidated revenue (state the period in the note), children = business SEGMENTS, grandchildren = products/streams. Children must be parts of the BUSINESS — never time periods (no quarter/year breakdowns; the tree shows how the money is made, not when).
Respond ONLY JSON — a single root node: {"name": "...", "value": "$23.8B", "share": "100%", "growth": "+10% YoY", "note": "<1-2 sentences>", "estimated": false, "basis": "", "citations": [<finding numbers>], "periods": {"FY2023": "$19.4B", "FY2024": "$21.5B", "FY2025": "$23.8B"}, "since": "<the year this stream STARTED existing (product launch, acquisition close) when the findings state it — omit if unknown>", "children": [...same shape...]}.
"value" is the LATEST size; "periods" holds that same node's size at OTHER dates the findings support (fiscal years and/or quarters, oldest→newest, ~2-8 entries) so the money's flow over time is visible. PERIOD HISTORY MATTERS AT EVERY DEPTH: scour the findings for EVERY period each node — including products and streams below the segment level — is sized in; filings and articles often list several years at once, and a stated share for a past period times that period's total is a valid ~estimate. Fill "periods" as fully as the findings honestly allow. DEDUPE means one entry per DISTINCT datapoint — when several labels restate ONE disclosure (FY2025 / H1 FY2026 / Q2 2026 all carrying the same Q2 FY2026 number), keep only the most precise label; distinct fiscal years are distinct datapoints and must ALL be kept. Use CONSISTENT labels across nodes ("FY2024", "Q2 FY2026"); if a figure is ARR rather than revenue, put "ARR" in the VALUE ("$19.2B ARR"), never in the label.
Max depth 4, max 6 children per node. ESTIMATE like an analyst: when a share of a stated total is known, compute the value (prefix "~", set estimated true, arithmetic in basis). RANGES over floors: never leave a bare ">$500M" when the disclosure language supports a band — "exceeded $500M" means just over it, so write "~$500-600M" with the reasoning in basis. Include every named stream the findings mention, even unsized. Never invent. No markdown, no commentary.`;

async function buildTreeOnce(run: ResearchRun, onLog: (m: string) => void): Promise<MoneyNode | null> {
  onLog(`🌳 Building the money tree from ${run.findings.length} findings…`);
  const context = run.factSheet ? `VERIFIED FACT SHEET:\n${run.factSheet}\n\n` : "";
  const raw = await callAI(
    TREE_SYSTEM,
    `${context}Research topic: ${run.topic}\n\nFINDINGS:\n${listing(run.findings)}`,
  );
  const parsed = parseJSON<MoneyNode>(raw);
  if (parsed?.name) {
    // Models sometimes write "since": "unknown" instead of omitting the field
    // — a since without a real year would break the n/a-vs-not-searched logic.
    (function scrub(n: MoneyNode) {
      if (n.since && !/\d{4}/.test(n.since)) delete n.since;
      (n.children ?? []).forEach(scrub);
    })(parsed);
    return parsed;
  }
  return null;
}

/** Sweep a targeted plan's queries and append whatever is new to the run. */
async function targetedSweep(
  run: ResearchRun,
  plan: { web?: string[]; news?: string[]; edgar?: string[] },
  onLog: (m: string) => void,
): Promise<number> {
  const seen = new Set(run.findings.map((f) => f.url));
  const jobs: Promise<Omit<Finding, "id">[]>[] = [];
  for (const [source, qs] of [["web", plan.web], ["news", plan.news], ["edgar", plan.edgar]] as const) {
    for (const q of (qs ?? []).slice(0, 2)) {
      jobs.push(sweep(source, plainQuery(q), run.cik).catch(() => []));
    }
  }
  const batches = await Promise.all(jobs);
  let added = 0;
  for (const f of batches.flat()) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    run.findings.push({ ...f, id: run.findings.length + 1 });
    added++;
  }
  onLog(`🌳 Targeted sweep: ${added} new findings.`);
  return added;
}

/**
 * Tree agent (port of `pipeline.py` `_tree_agent`): draft the tree, then
 * pass 1 — hunt sizes for unsized branches; pass 2 — hunt PERIOD HISTORY for
 * branches with thin coverage (segments AND the products below them, so
 * time-travel works at every depth); rebuild after each hunt.
 * Mutates run.findings (hunted findings become citable) and returns the tree.
 */
export async function buildMoneyTree(run: ResearchRun, onLog: (m: string) => void): Promise<MoneyNode> {
  const draft = await buildTreeOnce(run, onLog);
  if (!draft) throw new Error("Money tree: the model returned no tree — try again.");
  let tree = draft;

  // Pass 1: size the unsized branches.
  const missing: string[] = [];
  (function walk(n: MoneyNode) {
    if (!n.value || String(n.value).toLowerCase().includes("unsized")) missing.push(n.name);
    (n.children ?? []).forEach(walk);
  })(draft);
  if (missing.length) {
    try {
      onLog(`🌳 Tree agent: ${missing.length} unsized branches (${missing.slice(0, 6).join(", ").slice(0, 120)}) — hunting their numbers…`);
      const plan = parseJSON<{ web?: string[]; news?: string[]; edgar?: string[] }>(
        await callAI(
          'You write searches to SIZE the unsized branches of a company\'s revenue tree. Respond ONLY JSON: {"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. Up to 2 per source, jargon-precise, aimed at revenue/ARR figures for the named branches. PLAIN KEYWORDS — no quotes/OR.',
          `Research topic: ${run.topic}\nUnsized branches: ${missing.slice(0, 6).join("; ")}\nTree so far: ${JSON.stringify(draft).slice(0, 3000)}`,
        ),
      );
      if (plan && (await targetedSweep(run, plan, onLog))) {
        onLog("🌳 Tree agent: rebuilding the tree with the new findings…");
        tree = (await buildTreeOnce(run, onLog)) ?? draft;
      }
    } catch (e) {
      onLog(`⚠ Tree agent size-hunt failed (keeping draft): ${String((e as Error).message).slice(0, 100)}`);
    }
  }

  // Pass 2: history hunt — segments AND depth-2 products with thin period
  // coverage get dedicated searches so the flow of money is visible over time.
  const sparse: string[] = [];
  for (const seg of tree.children ?? []) {
    if (Object.keys(seg.periods ?? {}).length < 3) sparse.push(seg.name);
    for (const prod of seg.children ?? []) {
      if (Object.keys(prod.periods ?? {}).length < 2) sparse.push(prod.name);
    }
  }
  if (sparse.length) {
    try {
      onLog(`🌳 Tree agent: thin history on ${sparse.slice(0, 6).join(", ").slice(0, 120)} — hunting past-period sizes…`);
      const plan = parseJSON<{ web?: string[]; news?: string[]; edgar?: string[] }>(
        await callAI(
          'You write searches to find a company\'s SEGMENT and PRODUCT revenue in PAST fiscal years and recent quarters (multi-year segment tables live in annual reports, investor pages, and coverage articles). Respond ONLY JSON: {"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. Up to 2 per source; time-anchor queries with explicit years (e.g. "segment revenue 2022 2023 2024"). PLAIN KEYWORDS — no quotes/OR.',
          `Research topic: ${run.topic}\nBranches needing history: ${sparse.slice(0, 8).join("; ")}`,
        ),
      );
      if (plan && (await targetedSweep(run, plan, onLog))) {
        onLog("🌳 Tree agent: rebuilding with period history…");
        tree = (await buildTreeOnce(run, onLog)) ?? tree;
      }
    } catch (e) {
      onLog(`⚠ Tree agent history-hunt failed (keeping tree): ${String((e as Error).message).slice(0, 100)}`);
    }
  }

  const warnings = validateTree(tree);
  if (warnings.length) onLog(`⚠ Tree validation: ${warnings.length} warning(s) — flagged on the nodes.`);
  else onLog("🌳 Money tree ready — click a node to time-travel its periods.");
  return tree;
}

/** Walk a tree along a name path (root first). Throws when a step is missing. */
export function nodeAtPath(tree: MoneyNode, path: string[]): MoneyNode {
  let node = tree;
  for (const name of path.slice(1)) {
    const next = (node.children ?? []).find((c) => c.name === name);
    if (!next) throw new Error(`node not found: ${name}`);
    node = next;
  }
  return node;
}

const VERDICT_SYSTEM =
  'Did the findings contain the requested number? Respond ONLY JSON: {"found": true/false, "value": "<e.g. \'$3.4B\' or \'~$500-600M ARR\' — null if not found>", "estimated": true/false, "basis": "<math/source + the as-of date>", "citations": [<finding numbers>]}. ' +
  "ARR or run-rate disclosed at a date within the period COUNTS as the stream's size — include 'ARR' in the value and the as-of date in basis. A stated share of a known total counts too (compute it, estimated=true). A growth multiple off a known later value counts (e.g. 'tripled YoY to $500M' implies ~$167M a year earlier — estimated=true with the math). " +
  "PRECEDENCE: the company's own disclosures beat third-party estimates — if only a third-party estimate exists AND it contradicts the trajectory implied by the company's own disclosed numbers, return found=false rather than the conflicting estimate. " +
  "Prefer a tight RANGE over a bare floor: 'exceeded $500M' means just over it — '~$500-600M', reasoning in basis. Never invent.";

/**
 * Targeted hunt for ONE tree cell: `<node>` in `<period>` (period "latest"
 * updates node.value). Findings-first cheap pass, then targeted searches.
 * Marks the cell searched either way — the UI can honestly distinguish
 * "never looked" from "looked and it appears undisclosed".
 * Mutates run (tree + findings); persist the run after calling.
 * (Port of `pipeline.py` `hunt_tree_value`.)
 */
export async function huntTreeValue(
  run: ResearchRun,
  path: string[],
  period: string,
  onLog: (m: string) => void,
): Promise<{ found: boolean; value: string | null }> {
  if (!run.moneyMap) throw new Error("no tree on this run");
  const node = nodeAtPath(run.moneyMap, path);
  const company = run.ticker || run.topic;
  const target =
    `${node.name} (${path.join(" > ")}) size in ${period} — annual/quarterly revenue OR, for ` +
    `subscription/AI streams, ARR / run-rate disclosed at a date inside that period`;

  const verdictOn = async () =>
    parseJSON<{ found?: boolean; value?: string; estimated?: boolean; basis?: string; citations?: number[] }>(
      await callAI(VERDICT_SYSTEM, `Requested: ${target}\n\nFINDINGS:\n${listing(run.findings).slice(-24000)}`),
    ) ?? {};

  // Cheap first pass: the number may already be in the run's findings.
  onLog(`🔍 Hunting: ${node.name} in ${period} — checking existing findings…`);
  let verdict = await verdictOn();
  if (!(verdict.found && verdict.value && parseMoney(verdict.value) !== null)) {
    onLog(`🔍 Not in the findings — running targeted searches…`);
    const plan = parseJSON<{ web?: string[]; news?: string[]; edgar?: string[] }>(
      await callAI(
        'Write searches to find ONE specific number: a company stream\'s size in one period. Respond ONLY JSON: {"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. Up to 2 per source. PLAIN KEYWORDS ONLY — no quotes, no OR (the engines are basic). Cover BOTH revenue and ARR phrasings.',
        `Company/context: ${company}\nFind: ${target}`,
      ).catch(() => ""),
    ) ?? {};
    // Guaranteed simple fallback queries alongside whatever the model wrote.
    plan.web = [...(plan.web ?? []), `${company} ${node.name} revenue ${period}`, `${company} ${node.name} ARR ${period}`].slice(0, 4);
    await targetedSweep(run, plan, onLog);
    verdict = await verdictOn();
  }

  node.searched_periods = node.searched_periods ?? {};
  const found = Boolean(verdict.found && verdict.value && parseMoney(verdict.value) !== null);
  if (found) {
    if (period === "latest") node.value = verdict.value!;
    else (node.periods = node.periods ?? {})[period] = verdict.value!;
    if (verdict.estimated) {
      node.estimated = true;
      node.basis = String(verdict.basis ?? "").slice(0, 300);
    }
    node.searched_periods[period] = "found";
    onLog(`🔍 Found: ${node.name} in ${period} = ${verdict.value}`);
  } else {
    node.searched_periods[period] = "not_found";
    onLog(`🔍 Searched but not found — ${node.name} in ${period} appears undisclosed.`);
  }
  validateTree(run.moneyMap);
  return { found, value: found ? verdict.value! : null };
}

/**
 * Manual value entry for one tree cell, validated with parseMoney and marked
 * as user-entered. Mutates run.moneyMap; persist after calling.
 */
export function setTreeValue(run: ResearchRun, path: string[], period: string, value: string): void {
  if (!run.moneyMap) throw new Error("no tree on this run");
  if (parseMoney(value) === null) {
    throw new Error(`"${value}" doesn't parse as a money amount — use forms like $3.4B, ~$450M, ~$500-600M, $19.2B ARR.`);
  }
  const node = nodeAtPath(run.moneyMap, path);
  if (period === "latest") node.value = value;
  else (node.periods = node.periods ?? {})[period] = value;
  node.manual_labels = [...new Set([...(node.manual_labels ?? []), period])];
  (node.searched_periods = node.searched_periods ?? {})[period] = "found";
  validateTree(run.moneyMap);
}
