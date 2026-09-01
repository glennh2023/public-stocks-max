"use client";

// Deep Desk — the combined prototype: the Research Brief's sourcing engine
// (grounded multi-source sweeps + the story-editor gap loop, every claim
// [n]-cited into real findings) feeding the Paper Writer's institutional
// structure (parallel analyst sections + a lead-analyst synthesis with rating
// and price target). Where the Paper Writer reasons from general knowledge
// flagged "(to verify)", Deep Desk's analysts may ONLY state what the swept
// findings and the SEC XBRL fact sheet support — the sourcing pipeline is the
// research desk, the analyst agents are the writing desk.

import { DEFAULT_MODEL, getSetting } from "./settings";
import { runResearch, type ResearchRun, type SourceStatus } from "./gff-research";
import type { ReportRating, ReportSection } from "@/app/paper/types";

export type DeepDeskReport = {
  run: ResearchRun; // findings, fact sheet, ticker — and later the money tree
  executiveSummary: string;
  thesis: string;
  sections: ReportSection[];
  rating: ReportRating;
  generatedAt: string;
};

export type DeskAgentStatus = Record<string, "pending" | "writing" | "done" | "error">;

/** The writing desk: each agent writes one section from the cited evidence. */
export const DESK_AGENTS: { id: string; label: string; brief: string }[] = [
  {
    id: "story",
    label: "The Story",
    brief:
      "THE STORY: tell the company's current arc as a narrative with real stakes — origin (how it got here), " +
      "the turning point now in progress, the antagonist (competitor, technology shift, or its own economics), " +
      "the counterweight (the strongest fact cutting against the narrative), and the payoff (what resolves the " +
      "story and when we'll know). Full prose, ### subheads per beat. This is the section that makes the reader " +
      "care — but every factual beat still carries its [n]. Target 500-800 words.",
  },
  {
    id: "business",
    label: "Business & Moat",
    brief:
      "BUSINESS & MOAT: what the company does, how each segment and stream makes money, competitive position and " +
      "moat sources, key competitors. Organize around the flow of money — biggest stream first. " +
      "Target 500-800 words with ### subheads.",
  },
  {
    id: "numbers",
    label: "The Numbers",
    brief:
      "THE NUMBERS: a markdown table of EVERY concrete figure in the evidence (columns: Metric | Value | Period | " +
      "[n]), then prose interpreting trajectory — growth, margins, FCF, buybacks, share count — strictly from the " +
      "verified fact-sheet findings where available. Never blend numbers from different periods; state each " +
      "number's period. Target 400-700 words plus the table.",
  },
  {
    id: "valuation",
    label: "Valuation",
    brief:
      "VALUATION: what growth and margin assumptions the current price implies given the evidence, a bear/base/bull " +
      "framework with explicit drivers (markdown table: scenario | value | key assumption | [n]), and which " +
      "scenario the evidence currently favors. Where the evidence has no valuation data, say so honestly rather " +
      "than inventing multiples. Target 400-700 words.",
  },
  {
    id: "bullbear",
    label: "Bull / Bear & Risks",
    brief:
      "BULL / BEAR & RISKS: steelman both sides — 4-5 substantive bullets each under ### Bull case and " +
      "### Bear case (a bolded claim plus 2-3 sentences of cited argument), then ### Falsifiers: the specific " +
      "evidence that would kill each side. Target 500-800 words.",
  },
];

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

function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)) as T;
}

const CITE_POLICY =
  "CITATION POLICY: every factual claim ends with its evidence marker like [3] or [1][7], using ONLY the " +
  "bracketed ids provided. Never invent an id, never state a fact you cannot cite; where the evidence is silent, " +
  "say so — an honest gap beats a confident guess. Verified fact-sheet findings are as-filed SEC data and beat " +
  "news, which beats forum chatter. Never blend numbers from different periods. PLAIN TEXT arithmetic — no LaTeX.";

export async function buildDeepDesk(opts: {
  topic: string;
  ticker?: string;
  maxRounds?: number;
  onStatus: (s: SourceStatus) => void;
  onAgents: (s: DeskAgentStatus) => void;
  onLog: (m: string) => void;
}): Promise<DeepDeskReport> {
  // Phase 1 — the research desk: grounded sweeps + story-editor gap loop.
  // (runResearch also writes its own brief; Deep Desk keeps only the evidence
  //  and lets the analyst desk write the paper from it.)
  opts.onLog("— Phase 1: research desk (sweeps + story-editor gap loop)…");
  const run = await runResearch({
    topic: opts.topic,
    ticker: opts.ticker,
    maxRounds: opts.maxRounds,
    onStatus: opts.onStatus,
    onLog: opts.onLog,
  });

  const evidence = run.findings
    .map((f) => `[${f.id}] (${f.source}${f.published ? `, ${f.published}` : ""}) ${f.title}\n${f.content.slice(0, 1200)}`)
    .join("\n\n");
  const ground =
    (run.factSheet ? `VERIFIED FACT SHEET (SEC XBRL, as filed):\n${run.factSheet}\n\n` : "") +
    `TOPIC: ${run.topic}\n\nEVIDENCE (cite by [n]):\n${evidence}`;

  // Phase 2 — the writing desk: parallel analyst sections over the evidence.
  opts.onLog(`— Phase 2: writing desk — ${DESK_AGENTS.length} analyst agents writing in parallel…`);
  const agentStatus: DeskAgentStatus = Object.fromEntries(DESK_AGENTS.map((a) => [a.id, "pending"]));
  const pushAgents = () => opts.onAgents({ ...agentStatus });
  pushAgents();
  const sectionResults = await Promise.all(
    DESK_AGENTS.map(async (a): Promise<ReportSection | null> => {
      agentStatus[a.id] = "writing"; pushAgents();
      try {
        const md = await callAI(
          `You are the ${a.label} analyst on an equity research desk writing one section of an institutional ` +
            `research paper. Voice: measured, two-sided, dense with reasoning. Output ONLY the section body in ` +
            `markdown — no top-level title (the layout adds it). ${CITE_POLICY}`,
          `${a.brief}\n\n${ground}`,
        );
        agentStatus[a.id] = "done"; pushAgents();
        return { id: a.id, title: a.label, markdown: md.trim() };
      } catch {
        agentStatus[a.id] = "error"; pushAgents();
        return null;
      }
    }),
  );
  const sections = sectionResults.filter(Boolean) as ReportSection[];
  if (!sections.length) throw new Error("Every analyst agent failed — check your OpenRouter key in Settings.");

  // Phase 3 — the lead analyst synthesizes header, thesis and rating.
  opts.onLog("— Phase 3: lead analyst synthesizing thesis and rating…");
  type Synth = {
    executiveSummary: string;
    thesis: string;
    rating: { action: string; conviction: number; priceTarget: number | null; horizonMonths: number; rationale: string };
  };
  const synth = parseJSON<Synth>(
    await callAI(
      `You are the lead analyst synthesizing your team's sections into the paper's header. Respond ONLY JSON: ` +
        `{"executiveSummary": "2-3 paragraph markdown, [n]-cited", "thesis": "1-2 paragraph markdown investment thesis, [n]-cited", ` +
        `"rating": {"action": "Buy|Hold|Sell", "conviction": 1-5, "priceTarget": <number or null when the evidence ` +
        `gives no price basis — never invent one>, "horizonMonths": 12, "rationale": "one sentence"}}. ${CITE_POLICY}`,
      `TEAM SECTIONS:\n\n${sections.map((s) => `## ${s.title}\n${s.markdown}`).join("\n\n")}\n\n${ground}`,
    ),
  );
  opts.onLog("Deep Desk paper ready.");

  return {
    run,
    executiveSummary: synth.executiveSummary || "",
    thesis: synth.thesis || "",
    sections,
    rating: {
      action: synth.rating?.action || "Hold",
      conviction: synth.rating?.conviction ?? null,
      priceTarget: synth.rating?.priceTarget ?? null,
      upsidePct: null,
      horizonMonths: synth.rating?.horizonMonths ?? 12,
      rationale: synth.rating?.rationale || "",
    },
    generatedAt: new Date().toISOString(),
  };
}
