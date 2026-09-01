"""The multi-agent research pipeline.

Flow (mirrors the full Good Faith Finance studio, trimmed for portability):
  planner → XBRL grounding + metric hunter → parallel source agents
  → claim extractor → story-editor gap loop (iterative rounds)
  → insight agent → cited report writer

Every finding keeps its source URL and date; the report cites findings as [n]
where n is the finding's 1-based position. All LLM calls go through OpenRouter
with a key the user supplies at runtime (never stored in this repo).
"""
from __future__ import annotations

import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import sources


# ---------------------------------------------------------------- tree utils ----

def hunt_tree_value(api_key: str, model: str, run: dict, path: list[str], period: str) -> dict:
    """Targeted hunt for ONE tree cell: '<node>' in '<period>'.

    Generates queries for exactly that stream+period, searches web/news/EDGAR,
    extracts claims into the run's findings, then asks whether the value was
    actually found. Marks the cell 'searched' either way — so the UI can honestly
    distinguish "never looked" from "looked and it appears undisclosed".
    Returns {"found": bool, "value": str|None, "log": [...]}.
    """
    import sources

    lines: list[str] = []
    pipe = Pipeline(api_key, model, lines.append, 1)
    pipe.findings = run["findings"]
    node = run["tree"]
    for name in path[1:]:
        node = next((c for c in node.get("children") or [] if c.get("name") == name), None)
        if node is None:
            raise ValueError(f"node not found: {name}")
    company = run.get("ticker") or run["question"]
    target = (f"{node['name']} ({' > '.join(path)}) size in {period} — annual/quarterly revenue OR, for "
              f"subscription/AI streams, ARR / run-rate disclosed at a date inside that period")

    VERDICT_PROMPT = (
        "Did the findings contain the requested number? Respond ONLY JSON: "
        '{"found": true/false, "value": "<e.g. \'$3.4B\' or \'>$500M ARR\' — null if not found>", '
        '"estimated": true/false, "basis": "<math/source + the as-of date>", "citations": [<finding numbers>]}. '
        "ARR or run-rate disclosed at a date within the period COUNTS as the stream's size — include 'ARR' in the "
        "value and the as-of date in basis. A stated share of a known total counts too (compute it, estimated=true). "
        "A growth multiple off a known later value counts (e.g. 'tripled YoY to $500M' implies ~$167M a year "
        "earlier — estimated=true with the math). PRECEDENCE: the company's own disclosures beat third-party "
        "estimates — if only a third-party estimate exists AND it contradicts the trajectory implied by the "
        "company's own disclosed numbers, return found=false rather than the conflicting estimate. "
        "Prefer a tight RANGE over a bare floor: 'exceeded $500M' means just over it — '~$500-600M', reasoning "
        "in basis. Never invent."
    )

    # Cheap first pass: the number may already be in the run's findings.
    verdict = pipe.chat_json(VERDICT_PROMPT, f"Requested: {target}\n\nFINDINGS:\n{pipe.listing()[-24000:]}")
    if not (verdict.get("found") and verdict.get("value") and parse_money(str(verdict["value"])) is not None):
        # Not already known — run targeted searches for exactly this cell.
        plan = pipe.chat_json(
            "Write searches to find ONE specific number: a company stream's size in one period. Respond ONLY JSON: "
            '{"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. Up to 2 per source. '
            "PLAIN KEYWORDS ONLY — no quotes, no OR, no operators (the search engine is basic). Cover BOTH revenue "
            "and ARR phrasings: e.g. 'Adobe Firefly ARR 2026' and 'Adobe AI first revenue fiscal 2026'.",
            f"Company/context: {company}\nFind: {target}",
        )

        def plain(q: str) -> str:
            """Strip search operators the basic engines can't handle."""
            return re.sub(r"\s+", " ", q.replace('"', " ").replace(" OR ", " ").replace(" AND ", " ")).strip()

        # Guaranteed simple fallback queries alongside whatever the model wrote.
        web_qs = [plain(q) for q in plan.get("web", [])[:2]]
        web_qs += [plain(f"{company} {node['name']} revenue {period}"),
                   plain(f"{company} {node['name']} ARR {period}")]
        items: list[dict] = []
        for fn, qs in ((sources.web_search, web_qs), (sources.news_search, [plain(q) for q in plan.get("news", [])[:2]])):
            for q in qs:
                try:
                    items += [i for i in fn(q) if i["url"] not in pipe.seen]
                    if len(items) >= 8:
                        break
                except Exception:
                    pass
        cik = None
        if run.get("ticker"):
            try:
                hit = sources.edgar_lookup(run["ticker"])
                cik = hit["cik"] if hit else None
            except Exception:
                pass
        for q in plan.get("edgar", [])[:1]:
            try:
                items += sources.edgar_fts(plain(q), cik, limit=4)
            except Exception:
                pass
        if items:
            pipe._extract(f"What was {target}?", "", items[:10])
        verdict = pipe.chat_json(VERDICT_PROMPT, f"Requested: {target}\n\nFINDINGS:\n{pipe.listing()[-24000:]}")

    node.setdefault("searched_periods", {})
    found = bool(verdict.get("found")) and verdict.get("value") and parse_money(verdict["value"]) is not None
    if found:
        if period == "latest":
            node["value"] = verdict["value"]
        else:
            node.setdefault("periods", {})[period] = verdict["value"]
        if verdict.get("estimated"):
            node["estimated"] = True
            node["basis"] = str(verdict.get("basis", ""))[:300]
        node["searched_periods"][period] = "found"
    else:
        node["searched_periods"][period] = "not_found"
    validate_tree(run["tree"])
    return {"found": found, "value": verdict.get("value") if found else None, "log": lines}


def parse_money(value: str) -> float | None:
    """'$23.77B' / '~$450M' / '>$500M ARR' / '~$500-600M' → dollars as float.

    Ranges resolve to their LOWER bound (conservative for validation sums).
    Returns None when no money-like token is present.
    """
    m = re.search(r"\$\s*([\d,]+(?:\.\d+)?)\s*(?:[-–—]\s*[\d,]+(?:\.\d+)?)?\s*([BbMmKk])?", str(value or ""))
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    return n * {"B": 1e9, "M": 1e6, "K": 1e3}.get((m.group(2) or "").upper(), 1)


def validate_tree(tree: dict) -> list[str]:
    """Consistency checks; annotates nodes with `warnings` and returns them all.

    Rule: a node's sized children shouldn't sum to more than ~118% of the node
    (segment overlap and rounding earn some slack) — checked for the latest
    values and for every shared period label.
    """
    all_warnings: list[str] = []

    def check(node: dict):
        node.pop("warnings", None)
        kids = node.get("children") or []
        warns: list[str] = []
        parent_v = parse_money(node.get("value"))
        kid_vs = [parse_money(k.get("value")) for k in kids]
        if parent_v and kids and all(v is not None for v in kid_vs):
            total = sum(kid_vs)
            if total > parent_v * 1.18:
                warns.append(f"children sum to ${total/1e9:.2f}B — exceeds this node's ${parent_v/1e9:.2f}B")
        for label in (node.get("periods") or {}):
            pv = parse_money((node.get("periods") or {}).get(label))
            kvs = [parse_money((k.get("periods") or {}).get(label)) for k in kids]
            sized = [v for v in kvs if v is not None]
            if pv and sized and len(sized) == len(kids) and sum(sized) > pv * 1.18:
                warns.append(f"{label}: children sum exceeds this node's {label} value")
        if warns:
            node["warnings"] = warns
            all_warnings.extend(f"{node.get('name', '?')}: {w}" for w in warns)
        for k in kids:
            check(k)

    if tree:
        check(tree)
    return all_warnings


class Pipeline:
    """One research run: holds the findings, drives the agents, writes the report.

    Args:
        api_key:    OpenRouter key (supplied by the user at runtime).
        model:      any OpenRouter model id, e.g. "google/gemini-3.7-flash".
        log:        callable(str) — progress lines streamed to the UI.
        max_rounds: how many story-editor search rounds to allow (1-8).
    """

    def __init__(self, api_key: str, model: str, log, max_rounds: int = 4):
        self.api_key = api_key
        self.model = model
        self.log = log
        self.max_rounds = max(1, min(8, max_rounds))
        self.findings: list[dict] = []   # every cited [n] maps to findings[n-1]
        self.seen: set[str] = set()      # URLs already extracted (dedupe across rounds)
        self.searched: list[str] = []    # queries already run (the editor must not repeat them)

    # ------------------------------------------------------------- LLM ----
    def chat(self, system: str, user: str, want_json: bool = False) -> str:
        """One OpenRouter chat completion; returns the raw assistant text."""
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if want_json:
            body["response_format"] = {"type": "json_object"}
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=180) as res:
            data = json.loads(res.read().decode())
        return data["choices"][0]["message"]["content"]

    def chat_json(self, system: str, user: str) -> dict:
        """Chat expecting a JSON object; tolerant of stray text around the braces."""
        raw = self.chat(system, user, want_json=True)
        return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])

    # -------------------------------------------------------- findings ----
    def add_finding(self, item: dict, claim: str, quote: str = "", numbers: str = "", relevance: int = 5):
        """Append one citable finding; its [n] number is its 1-based position."""
        self.findings.append({
            "n": len(self.findings) + 1,
            "source": item["source"], "url": item.get("url", ""), "title": item.get("title", ""),
            "claim": claim, "quote": quote, "numbers": numbers,
            "relevance": relevance, "date": item.get("published"),
        })

    def listing(self, cap: int = 200) -> str:
        """Compact numbered findings list — the shared context for every LLM stage."""
        return "\n".join(
            f"[{f['n']}] ({f['source']}{', ' + f['date'] if f.get('date') else ''}) {f['claim'][:cap]}"
            + (f" — {f['numbers'][:80]}" if f["numbers"] else "")
            for f in self.findings
        )

    # ------------------------------------------------------ pipeline ------
    def run(self, question: str, ticker: str | None) -> dict:
        """Execute the full pipeline; returns {report, findings, insights}.

        Stages: XBRL grounding → metric hunter → planner → N search/extract
        rounds driven by the story editor → insight agent → report writer.
        Every stage is individually fault-tolerant: a failed stage logs a
        warning and the run continues with what it has.
        """
        self.log(f"🔁 Loop budget: up to {self.max_rounds} rounds")
        context = ""
        cik = None

        # 1. Verified grounding (SEC XBRL) + metric hunter
        if ticker:
            try:
                company = sources.edgar_lookup(ticker)
                if company:
                    cik = company["cik"]
                    self.log(f"📊 Grounding in SEC XBRL for {company['name']} (CIK {cik})…")
                    sheet = sources.edgar_fact_sheet(cik, company["name"])
                    context = sheet
                    for line in sheet.split("\n")[1:-1]:
                        date = re.search(r"\d{4}-\d{2}-\d{2}", line)
                        self.add_finding({"source": "xbrl", "url": f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                                          "title": f"SEC XBRL — {company['name']}", "published": date.group(0) if date else None},
                                         line, relevance=10)
                    self.log(f"📊 Fact sheet ready — {len(sheet.splitlines()) - 2} verified lines, cited as [n] findings")
                    self._metric_hunter(question, context)
            except Exception as e:
                self.log(f"⚠️ XBRL grounding failed (continuing): {e}")

        # 2. Plan
        self.log("🧠 Planner: turning the question into jargon-precise searches…")
        plan = self.chat_json(
            "You plan research for a finance YouTube channel. Respond ONLY JSON: "
            '{"reasoning": "...", "youtube": ["q"], "web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. '
            "1-3 queries per source. QUERY CRAFT: hunt NUMBERS not narratives; use the jargon data lives under; "
            "time-anchor; include one competitor-side and one bear-case query. When a company is in focus, ALWAYS "
            "include one query for its revenue breakdown by segment/product (feeds the information tree).",
            f"{context}\n\nResearch question: {question}",
        )
        if plan.get("reasoning"):
            self.log(f"🧠 Strategy: {plan['reasoning']}")

        # 3. Iterative story-editor loop
        for rnd in range(1, self.max_rounds + 1):
            queries = {k: [q for q in plan.get(k, []) if isinstance(q, str)][:3] for k in ("youtube", "web", "news", "edgar")}
            self.searched += [q for qs in queries.values() for q in qs]
            n_before = len(self.findings)
            self._search_round(queries, cik, question, context, rnd)
            self.log(f"🔄 Round {rnd} done: +{len(self.findings) - n_before} findings ({len(self.findings)} total)")
            if rnd == self.max_rounds:
                break
            gap = self._story_editor(question, context, rnd)
            plan = gap
            if not any(gap.get(k) for k in ("youtube", "web", "news", "edgar")):
                # Don't honor an early surrender: real coverage takes rounds.
                if rnd < max(2, self.max_rounds // 2):
                    self.log("🔎 Story editor tried to stop early — insisting on more depth")
                    plan = {"youtube": [], "web": [f"{question} bear case analysis details"],
                            "news": [f"{question.split('?')[0]} latest"], "edgar": []}
                    continue
                self.log("🔎 Story editor declared the story complete — stopping the loop")
                break

        # 4. Insights + report + information tree (with its own gap-filling agent)
        insights = self._insights(question, context)
        report = self._writer(question, context, insights)
        tree = self._tree_agent(question, context, cik)
        if tree:
            warnings = validate_tree(tree)
            if warnings:
                self.log(f"⚠️ Tree validation: {len(warnings)} consistency warning(s) — flagged on the nodes")
        return {"report": report, "findings": self.findings, "insights": insights, "tree": tree}

    # ---------------------------------------------------------- stages ----
    def _metric_hunter(self, question: str, context: str):
        """Invent non-obvious metrics and COMPUTE them from the verified data.

        These become 'derived' findings with the arithmetic shown — the stats
        (Rule of 40, buyback cost per net share retired, …) that make the
        research feel like original analysis rather than news aggregation.
        """
        try:
            self.log("🧪 Metric hunter: computing non-obvious metrics from the verified data…")
            out = self.chat_json(
                "Invent 5-8 UNIQUE decision-relevant metrics for this company (unit economics, capital-allocation "
                "quality, efficiency, Rule of 40, incremental margins). COMPUTE each from the verified data in the "
                'context, showing the arithmetic. Respond ONLY JSON: {"computed": [{"name": "...", '
                '"claim": "<value(s) + what it reveals, with periods>", "math": "<the arithmetic>"}]}. '
                "Only use numbers present in the context.",
                f"{context}\n\nResearch question: {question}",
            )
            for c in out.get("computed", [])[:8]:
                if c.get("name") and c.get("claim"):
                    self.add_finding({"source": "derived", "url": "", "title": f"Derived — {c['name']}", "published": None},
                                     f"{c['claim']} (math: {c.get('math', '')})", relevance=9)
            self.log(f"🧪 {min(len(out.get('computed', [])), 8)} derived metrics computed (math shown in each)")
        except Exception as e:
            self.log(f"⚠️ Metric hunter failed (continuing): {e}")

    def _search_round(self, queries: dict, cik: str | None, question: str, context: str, rnd: int):
        """Run one round's searches in parallel, then extract claims.

        EDGAR hits collapse into a single pointer-finding (they're links to
        primary filings, not claims); everything else goes to the extractor.
        URLs are only marked 'seen' after extraction succeeds, so a transient
        LLM failure leaves the batch retryable in a later round.
        """
        agents = {"youtube": sources.youtube_search, "web": sources.web_search,
                  "news": sources.news_search, "edgar": lambda q: sources.edgar_fts(q, cik)}
        items: list[dict] = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {}
            for src, qs in queries.items():
                for q in qs:
                    self.log(f"▶ {src}: searching “{q}”")
                    futures[pool.submit(agents[src], q)] = (src, q)
            if rnd == 1:  # one-time community sweep
                futures[pool.submit(sources.hn_search, question.split()[0] if not cik else question)] = ("hn", "community sweep")
            for fut, (src, q) in futures.items():
                try:
                    got = [i for i in fut.result() if i["url"] not in self.seen]
                    self.log(f"✓ {src}: {len(got)} new results for “{q}”")
                    items += got
                except Exception as e:
                    self.log(f"⚠️ {src} failed on “{q}”: {str(e)[:100]}")
        # EDGAR hits collapse into one pointer-finding; the rest get claim-extracted.
        edgar_items = [i for i in items if i["source"] == "edgar"][:8]
        if edgar_items:
            for i in edgar_items:
                self.seen.add(i["url"])
            self.add_finding({"source": "edgar", "url": edgar_items[0]["url"],
                              "title": f"SEC EDGAR — {len(edgar_items)} matching filings",
                              "published": edgar_items[0].get("published")},
                             "Primary-source filings matched this round: " + "; ".join(i["title"] for i in edgar_items),
                             relevance=6)
        rest = [i for i in items if i["source"] != "edgar"][:22]
        if rest:
            self._extract(question, context, rest)

    def _extract(self, question: str, context: str, items: list[dict]):
        """Turn raw scraped items into discrete claims with quotes and figures."""
        listing = "\n\n".join(
            f"--- ITEM {i} ---\nTitle: {it['title']}\nURL: {it['url']}"
            + (f"\nPublished: {it['published']}" if it.get("published") else "")
            + f"\n{it['content'][:8000]}"
            for i, it in enumerate(items)
        )
        try:
            out = self.chat_json(
                'Extract factual findings. Respond ONLY JSON: {"claims": [{"idx": <item #>, "claim": "<one sentence>", '
                '"quote": "<short verbatim quote or empty>", "numbers": "<figures, or empty>", "relevance": <0-10>}]}. '
                "Only what sources actually say — never invent numbers. Time matters: old sources describe old financials. "
                "Mine THOROUGHLY: extract every distinct factual claim, figure, estimate, and clearly-labeled opinion — "
                "up to 5 claims per item; number-dense sources deserve the most.",
                f"{context[:6000]}\nResearch question: {question}\n\n{listing}",
            )
            n = 0
            for cl in out.get("claims", []):
                item = items[cl["idx"]] if isinstance(cl.get("idx"), int) and 0 <= cl["idx"] < len(items) else None
                if item and cl.get("claim"):
                    self.add_finding(item, cl["claim"], cl.get("quote", ""), cl.get("numbers", ""),
                                     int(cl.get("relevance", 5)))
                    n += 1
            for it in items:  # only mark consumed after successful extraction
                self.seen.add(it["url"])
            self.log(f"🧩 {n} claims extracted from {len(items)} sources")
        except Exception as e:
            self.log(f"⚠️ Extraction failed (sources stay retryable): {str(e)[:120]}")

    def _story_editor(self, question: str, context: str, rnd: int) -> dict:
        """The loop's brain: 'do I have enough to tell the story? what's missing?'

        States the strongest current narrative, names the missing story elements
        (stakes, turning point, antagonist, counterweight…), and converts them
        into the next round's searches — never repeating past queries.
        """
        self.log(f"🎬 Story editor (round {rnd}): do we have enough to tell the story?")
        try:
            gap = self.chat_json(
                f"You are the STORY EDITOR driving round {rnd} of up to {self.max_rounds} in a research loop for a "
                "finance YouTube video. Step 1: state the strongest narrative the findings support, then ask what the "
                "STORY is missing (origin, stakes number, turning point, antagonist with receipts, payoff proof, "
                "counterweight). Step 2: check the analytical dimensions — every revenue stream sized? management's "
                "levers known? unverified numbers? one-sided coverage? competitor/customer/regulator side? stale "
                "data? Step 3: convert every gap into searches, pushing into NEW territory each round. "
                'Respond ONLY JSON: {"narrative": "...", "gaps": ["missing story element"], "youtube": ["q"], '
                '"web": ["q"], "news": ["q"], "edgar": ["short verbatim phrase"]}. 1-2 queries per source, never '
                "repeat ALREADY SEARCHED queries. Return ALL empty arrays ONLY if both the story AND the analysis "
                "are genuinely exhaustive — thin coverage or a tellable story with a missing act means KEEP SEARCHING.",
                f"{context[:6000]}\nResearch question: {question}\n\nALREADY SEARCHED:\n- "
                + "\n- ".join(self.searched) + f"\n\nFINDINGS:\n{self.listing()[-24000:]}",
            )
            if gap.get("narrative"):
                self.log(f"🎬 Story check: {gap['narrative']}")
            for g in gap.get("gaps", [])[:5]:
                self.log(f"   ◦ story needs: {g}")
            return gap
        except Exception as e:
            self.log(f"⚠️ Story editor failed: {str(e)[:100]}")
            return {}

    def _insights(self, question: str, context: str) -> str:
        """A dedicated pass whose only job is second-order, non-obvious synthesis."""
        self.log("💡 Insight agent: hunting non-obvious, second-order implications…")
        try:
            return self.chat(
                "Produce 4-6 NON-OBVIOUS insights by combining findings — implications no single source states. "
                "The bar: chained reasoning that inverts an obvious narrative (incentive asymmetries, 'good enough' "
                "thresholds, what-must-be-true, consensus fighting the last war). Markdown bullets: bold one-line "
                "thesis, then the reasoning chain citing [n]. Mark pure inference '(inference)'.",
                f"{context[:6000]}\nQuestion: {question}\n\nFINDINGS:\n{self.listing()}",
            )
        except Exception as e:
            self.log(f"⚠️ Insight agent failed: {str(e)[:100]}")
            return ""

    def _tree(self, question: str, context: str) -> dict | None:
        """Build the 'tree of information': a hierarchy of how the money/topic
        breaks down, with analyst-style estimates (math shown) and citations.

        For a company this is a money map — consolidated revenue → segments →
        products/streams. Sizes that findings only imply (a share of a stated
        total, an ARR figure) are COMPUTED and flagged estimated with the basis.
        """
        self.log("🌳 Building the information tree…")
        try:
            out = self.chat_json(
                "Build a TREE of the key information from research findings. For a company: root = consolidated "
                "revenue (state the period in the note), children = business SEGMENTS, grandchildren = "
                "products/streams. Children must be parts of the BUSINESS — never time periods (no quarter/year "
                "breakdowns; the tree shows how the money is made, not when). "
                'Respond ONLY JSON — a single root node: {"name": "...", "value": "$23.8B", "share": "100%", '
                '"growth": "+10% YoY", "note": "<1-2 sentences>", "estimated": false, "basis": "", '
                '"citations": [<finding numbers>], '
                '"periods": {"FY2023": "$19.4B", "FY2024": "$21.5B", "FY2025": "$23.8B"}, '
                '"since": "<the year/period this stream STARTED existing (product launch, acquisition close) when '
                'the findings state it — e.g. "2023" for a product launched in 2023; omit if unknown>", '
                '"children": [...same shape...]}. '
                '"value" is the LATEST size; "periods" holds that same node\'s size at OTHER dates the findings '
                "support (fiscal years and/or quarters, oldest→newest, ~2-8 entries) so the money's flow over time "
                "is visible. PERIOD HISTORY MATTERS: scour the findings for EVERY period each node is sized in — "
                "filings and articles often list several years of segment revenue at once, and a stated share for a "
                "past period times that period's total is a valid ~estimate. Fill 'periods' as fully as the findings "
                "honestly allow; omit the field only when a single period is known. Use CONSISTENT period labels "
                "across all nodes ('FY2024', 'Q2 FY2026') — if a figure is ARR rather than revenue, put 'ARR' in the "
                "VALUE ('$19.2B ARR'), never in the period label. "
                "Max depth 4, max 6 children per node. ESTIMATE like an analyst: when a share of a stated total is "
                "known, compute the value (prefix '~', set estimated true, put the arithmetic in basis). "
                "RANGES over floors: never leave a bare '>$500M' when the disclosure language supports a band — "
                "'exceeded $500M' means just over it, so write '~$500-600M' with the reasoning in basis. "
                "DEDUPE periods: when several labels restate ONE disclosure (FY2025 / H1 FY2026 / Q2 2026 all "
                "carrying the same Q2 FY2026 datapoint), keep only the most precise label. "
                "Include every named stream the findings mention, even unsized. Never invent.",
                f"{context[:6000]}\nResearch question: {question}\n\nFINDINGS:\n{self.listing()}",
            )
            if out.get("name"):
                self.log("🌳 Information tree ready — click nodes in the UI")
                return out
        except Exception as e:
            self.log(f"⚠️ Tree failed (continuing): {str(e)[:100]}")
        return None

    def _tree_agent(self, question: str, context: str, cik: str | None) -> dict | None:
        """Tree agent: draft the tree, hunt down what it's missing, rebuild.

        The flow of money is the heart of the story — so after drafting, this
        agent lists the unsized/history-less nodes and runs targeted searches
        JUST to size them (and to capture how each stream changed over time),
        then rebuilds the tree with the new findings.
        """
        draft = self._tree(question, context)
        if not draft:
            return None

        def unsized(n: dict, out: list):
            if not n.get("value") or "unsized" in str(n.get("value", "")).lower():
                out.append(n["name"])
            for c in n.get("children") or []:
                unsized(c, out)

        missing: list = []
        unsized(draft, missing)
        tree = draft
        if missing[:6]:
            try:
                self.log(f"🌳 Tree agent: {len(missing)} unsized branches ({', '.join(missing[:6])[:120]}) — hunting their numbers…")
                plan = self.chat_json(
                    "You write searches to SIZE the unsized branches of a company's revenue tree. Respond ONLY JSON: "
                    '{"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. Up to 2 per source, '
                    "jargon-precise, aimed at revenue/ARR figures for the named branches.",
                    f"Research question: {question}\nUnsized branches: {'; '.join(missing[:6])}\n"
                    f"Tree so far: {json.dumps(draft)[:3000]}",
                )
                self._search_round({"youtube": [], "web": plan.get("web", [])[:2],
                                    "news": plan.get("news", [])[:2], "edgar": plan.get("edgar", [])[:2]},
                                   cik, question, context, rnd=98)
                self.log("🌳 Tree agent: rebuilding the tree with the new findings…")
                tree = self._tree(question, context) or draft
            except Exception as e:
                self.log(f"⚠️ Tree agent size-hunt failed (keeping draft): {str(e)[:100]}")

        # Pass 2: history hunt — major branches with thin period coverage get
        # dedicated searches so the flow of money is visible OVER TIME, not
        # just at the latest snapshot.
        sparse = [c["name"] for c in (tree.get("children") or []) if len(c.get("periods") or {}) < 3][:4]
        if sparse:
            try:
                self.log(f"🌳 Tree agent: thin history on {', '.join(sparse)[:120]} — hunting past-period sizes…")
                plan = self.chat_json(
                    "You write searches to find a company's SEGMENT revenue in PAST fiscal years and recent quarters "
                    "(multi-year segment tables live in annual reports, investor pages, and coverage articles). "
                    'Respond ONLY JSON: {"web": ["q"], "news": ["q"], "edgar": ["2-4 word verbatim filing phrase"]}. '
                    "Up to 2 per source; time-anchor queries with explicit years (e.g. 'segment revenue 2022 2023 2024').",
                    f"Research question: {question}\nBranches needing history: {'; '.join(sparse)}",
                )
                self._search_round({"youtube": [], "web": plan.get("web", [])[:2],
                                    "news": plan.get("news", [])[:2], "edgar": plan.get("edgar", [])[:2]},
                                   cik, question, context, rnd=99)
                self.log("🌳 Tree agent: rebuilding with period history…")
                tree = self._tree(question, context) or tree
            except Exception as e:
                self.log(f"⚠️ Tree agent history-hunt failed (keeping tree): {str(e)[:100]}")
        return tree

    def _writer(self, question: str, context: str, insights: str) -> str:
        """Aggregate everything into the final report; every claim cited as [n]."""
        self.log(f"📝 Writer: composing the cited report from {len(self.findings)} findings…")
        try:
            report = self.chat(
                "Write a research report for a finance YouTube channel from numbered findings. Sections: "
                "## Verdict / ## How they make money / ## The numbers (table with As-of + Source columns; include "
                "EVERY concrete figure) / ## Non-obvious insights / ## What the discussion says / "
                "## Supports the angle / cuts against it / ## Gaps & follow-ups. Cite EVERY claim as plain [n]. "
                "(xbrl) findings are verified as-filed data and beat social sources; (derived) findings are computed "
                "metrics — feature them with their math. Never blend numbers from different periods; state each "
                "number's period. PLAIN TEXT ONLY: never use LaTeX ($$, \\text, \\frac) — write arithmetic inline "
                "like '$9.85B / $23.77B = 41.4%'.",
                f"{context[:8000]}\nResearch question: {question}\n\nFINDINGS:\n{self.listing(300)}"
                + (f"\n\nPRE-GENERATED INSIGHTS:\n{insights}" if insights else ""),
            )
            self.log("✅ Report ready")
            return report
        except Exception as e:
            self.log(f"⚠️ Writer failed: {e}")
            return f"_Report generation failed ({e}). Findings are intact below._"
