# StocksMax Research — Limited Sandbox

> ⚠ **This is a LIMITED SANDBOX build from StocksMax Research.** It was prepared
> specifically for application/club review and contains **sample components and
> tools only**. It is **not** the full StocksMax Research project — the
> production multi-agent research pipeline, EDGAR tooling, charting engine, and
> data layer are private and intentionally excluded. Please do not treat this
> code as representative of the full system's scope.

A small Next.js app demonstrating three sample tools over live
[Tiingo](https://www.tiingo.com) market data:

| Tool | What it shows |
| --- | --- |
| **Customizable Dashboard** | Add / reorder / retarget sample widgets (quote card, 2-year price chart, news feed, watchlist, sticky notes). Layout persists in your browser. |
| **Research Paper Writer** | Institutional-style equity research: parallel analyst agents write grounded sections over live Tiingo data, a lead analyst synthesizes rating + 12-month target, printed-note layout with charts and PDF export. Standard (5 sections) or Deep mode (research round + 7 sections). |
| **Research Brief** | The StocksMax Research sourcing tool: with a ticker, the run is grounded in verified SEC XBRL financials first; five parallel source agents (YouTube, DuckDuckGo, Google News, Hacker News, CIK-scoped SEC EDGAR full-text) sweep under a story-editor gap loop, then a writer drafts a brief with [n] citations into the browsable findings. Afterwards a 💸 **money tree** agent traces the revenue structure *over time*: per-node period history, honest 3-state cells (found / n/a-didn't-exist-yet / red cannot-find only after actually searching), per-cell 🔍 hunts, and validated manual entry. |
| **Deep Desk** | The combined prototype: the Research Brief's sourcing engine feeds the Paper Writer's structure — parallel analyst agents (including a dedicated *The Story* narrative agent) each write an institutional-paper section where every claim carries a [n] citation into actually-swept findings, and a lead analyst synthesizes thesis + rating. The money tree runs over the same evidence. |
| **YouTube Calls** | Scan finance YouTubers' recent uploads, AI-extract every explicit buy/sell/hold call from public caption transcripts (creator's rating words, confidence, quote), and view calls as colored markers on the ticker's price chart. |

## Design constraints (on purpose)

- **No environment variables and no secrets in the repo.** Each user enters
  their own Tiingo (and optionally OpenRouter) API key in **Settings**; keys
  live only in that browser's localStorage and are sent per-request to thin
  serverless proxy routes (`/api/tiingo`, `/api/ai`) that store nothing.
- **No database.** Dashboard layouts, saved briefs, and workspace notes are
  persisted in localStorage — the app is fully stateless server-side, which is
  what makes it deploy to Vercel with zero configuration.
- **Limited access.** A simple access code gates the UI (see
  `lib/sandbox-config.ts`, default `Quant-Illinois-2026`). It's a client-side
  convenience filter for a shared demo link, **not** a security boundary —
  change the code before deploying.

## Run locally

```bash
npm install
npm run dev
```

**ACCESS CODE**: Quant-Illinois-2026

Open http://localhost:3000, enter the access code, then paste a free Tiingo
API key in **Settings**.


## Requirements & notes

- Market data requires a free Tiingo account (their EOD + news endpoints).
- AI features (AI-written briefs, research, KPI sourcing, call extraction) are
  optional and require the user's own [OpenRouter](https://openrouter.ai) key.
  The default model is `google/gemini-3.7-flash`.
- `legacy-python/` is an earlier standalone Python export of the research
  pipeline; it is unrelated to this web app and can be ignored or removed.

## Disclaimer

All output is automatically generated sample content for demonstration
purposes and is **not investment advice**.
