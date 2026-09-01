# Good Faith Finance — Research Agents

A multi-agent stock-research pipeline with a web UI, in ~900 lines of dependency-free Python.
Ask a question in natural language ("Is Adobe a value trap or a bargain?"), and a team of
agents researches it and returns a report where **every claim is cited [n]** and traces to a
dated source.

Built as the standalone core of a larger YouTube-production studio I use to research
public companies in good faith — from primary sources, with every number dated.

## Run it

```bash
./run.sh          # or: python3 app.py
```

Open **http://localhost:8777**, paste an [OpenRouter](https://openrouter.ai) API key in the
top bar (any model works; the default is a fast/cheap one), type a question, optionally add
a ticker, and launch. A run takes ~2–5 minutes depending on rounds.

Requirements: **Python 3.10+**. No pip installs — the standard library only
(`urllib`, `http.server`, `sqlite`-free JSON persistence, `xml.etree`, threads).

> **No secrets in this repo.** The API key is entered in the UI and stored in
> `~/.gff_research_config.json` (your home directory), never inside this folder —
> so the project can be zipped and shared as-is.

## How it works

```
question ──► planner ──────────────► jargon-precise searches per source
   │                                   (numbers-not-narratives, time-anchored,
   ▼                                    competitor-side + bear-case queries)
SEC XBRL grounding                     │
   │  as-filed fact sheet:             ▼
   │  10y revenue/margins/FCF/     parallel scrapers ──► claim extractor
   │  buybacks, exact fiscal dates   YouTube · web (DDG)   each claim: quote,
   ▼                                 news (RSS) · EDGAR    figures, relevance,
metric hunter                        Hacker News           source date
   │  invents non-obvious metrics      │
   │  and COMPUTES them (math shown)   ▼
   │                              🎬 STORY EDITOR ◄──────────── loop (N rounds)
   │                                 "what's the strongest narrative?
   │                                  what is the STORY missing?"
   ▼                                 → converts gaps into new searches
insight agent ──► non-obvious, second-order implications
   ▼
report writer ──► Verdict · How they make money · The numbers (dated table)
                  Insights · Sentiment · For/Against · Gaps — all cited [n]
```

Design decisions worth noting:

- **Verified data beats scraped data.** SEC XBRL company facts are parsed into a dated
  fact sheet (with fiscal-Q4 derivation for flow metrics — never for averages like share
  counts, which would produce garbage). The writer is instructed that as-filed numbers win
  any conflict with social sources.
- **Time discipline.** Every finding carries a date — exact for filings/news, `~YYYY-MM-DD`
  approximations for YouTube's "3 months ago" (marked, never disguised as exact). Old
  sources describe old financials; the report must state each number's period.
- **The story-editor loop.** Instead of "search once, summarize," the loop reasons like an
  editor: *do I have enough to tell this story? I'm missing the turning point / the
  antagonist's receipts / the counterweight — go source it.* It never repeats a query.
- **Failed batches stay retryable.** Source URLs are only marked consumed after claim
  extraction succeeds, so one LLM hiccup can't silently discard scraped material.
- **Derived metrics.** The metric hunter computes stats nobody publishes (buyback cost per
  net share retired, Rule of 40, incremental margins) directly from the verified data,
  with the arithmetic shown in the finding.
- **The information tree is honest about absence.** Each node knows when its stream began
  existing (`since`), so a pre-launch period shows *"n/a — didn't exist yet"* while a
  period the stream existed in but no data was found shows **"cannot find information"**
  in red. Any value can be filled or corrected manually per period (marked ✎, format-
  validated), and a consistency checker flags nodes whose children sum past their parent.

## Files

| File | What it is |
|---|---|
| `app.py` | Threaded HTTP server + the single-page UI (config, live agent log, cited report, findings browser with a source side-panel) |
| `pipeline.py` | The `Pipeline` class — all agent stages and the research loop |
| `sources.py` | Zero-dependency scrapers: YouTube, DuckDuckGo, Google News, Hacker News, SEC EDGAR full-text search, and the XBRL fact-sheet builder |
| `run.sh` | Launcher |
| `runs/` | Saved runs as JSON (created at runtime; gitignored) |

## Honest limitations

This is the portable core, trimmed from the full studio: the full version adds full-video
transcript mining (yt-dlp), earnings-call transcripts, quarterly operational-metric series
from 8-K press releases, an interactive revenue "money map", auto-generated charts, and a
slideshow builder. Scrapers depend on public endpoints that can change; every stage fails
soft (logged, run continues). Nothing here is investment advice — it's a research tool
that insists on citations.
