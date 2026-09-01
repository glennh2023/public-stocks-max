"use client";

import { useMemo, useState } from "react";
import type { MoneyNode } from "@/lib/gff-research";

// Sandbox port of the money tree UI (legacy-python/app.py's tree panel + the
// full app's MoneyMap.tsx): a collapsible revenue tree where every node has a
// PERIOD TABLE for time-travel. Each cell is honest about its state:
//   · a value            — found (✎ to override manually)
//   · "n/a — didn't exist yet" — the stream launched after that period (since)
//   · red "cannot find"  — a hunt actually searched and came up empty
//   · dim "not searched" — nobody has looked yet (🔍 runs a targeted hunt)

export type TreeCellHandlers = {
  /** Run a targeted hunt for this node+period. Path is root-first node names. */
  onHunt?: (path: string[], period: string) => Promise<void>;
  /** Save a manually entered value (validated upstream; throws on bad input). */
  onSetValue?: (path: string[], period: string, value: string) => void;
  busy?: boolean;
};

type PeriodState =
  | { kind: "ok"; value: string; manual: boolean }
  | { kind: "na"; since: string }
  | { kind: "searched_missing" }
  | { kind: "missing" };

function periodYear(label: string): number | null {
  const m = /(\d{4})/.exec(label);
  return m ? parseInt(m[1], 10) : null;
}

function periodState(node: MoneyNode, period: string): PeriodState {
  const value = period === "latest" ? node.value : node.periods?.[period];
  if (value) return { kind: "ok", value, manual: (node.manual_labels ?? []).includes(period) };
  const sinceY = node.since ? periodYear(node.since) : null;
  const py = periodYear(period);
  if (sinceY !== null && py !== null && py < sinceY) return { kind: "na", since: node.since! };
  if (node.searched_periods?.[period] === "not_found") return { kind: "searched_missing" };
  return { kind: "missing" };
}

/** All period labels in the tree, oldest→newest (years first, then quarters). */
function collectPeriods(root: MoneyNode): string[] {
  const labels = new Set<string>();
  (function walk(n: MoneyNode) {
    Object.keys(n.periods ?? {}).forEach((l) => labels.add(l));
    Object.keys(n.searched_periods ?? {}).forEach((l) => l !== "latest" && labels.add(l));
    (n.children ?? []).forEach(walk);
  })(root);
  return [...labels].sort((a, b) => (periodYear(a) ?? 0) - (periodYear(b) ?? 0) || a.localeCompare(b));
}

function Chip({ label, value, tone }: { label: string; value?: string; tone?: string }) {
  if (!value) return null;
  return (
    <span className="badge" style={{ marginLeft: 6, color: tone || "var(--muted)" }}>
      {label} {value}
    </span>
  );
}

function PeriodRow({ node, path, period, handlers }: {
  node: MoneyNode; path: string[]; period: string; handlers: TreeCellHandlers;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [hunting, setHunting] = useState(false);
  const st = periodState(node, period);

  const save = () => {
    try {
      handlers.onSetValue?.(path, period, draft.trim());
      setEditing(false); setErr(null); setDraft("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const hunt = async () => {
    if (!handlers.onHunt || hunting || handlers.busy) return;
    setHunting(true);
    try { await handlers.onHunt(path, period); } finally { setHunting(false); }
  };

  return (
    <tr>
      <td style={{ padding: "2px 10px 2px 0", color: "var(--muted)", whiteSpace: "nowrap" }}>
        {period === "latest" ? "latest" : period}
      </td>
      <td style={{ padding: "2px 0" }}>
        {editing ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
              placeholder="$3.4B / ~$500-600M / $19.2B ARR"
              style={{ fontSize: 12, width: 150, padding: "1px 6px" }} />
            <button className="badge" style={{ cursor: "pointer" }} onClick={save}>save</button>
            <button className="badge" style={{ cursor: "pointer" }} onClick={() => { setEditing(false); setErr(null); }}>✕</button>
            {err ? <span style={{ color: "var(--danger, #e5484d)", fontSize: 11 }}>{err}</span> : null}
          </span>
        ) : st.kind === "ok" ? (
          <span>
            <b style={{ color: st.value.startsWith("~") ? "var(--warn)" : "var(--accent)" }}>{st.value}</b>
            {st.manual ? <span className="label" style={{ marginLeft: 6 }}>manual</span> : null}
            {handlers.onSetValue ? (
              <a href="#" style={{ marginLeft: 8, fontSize: 11 }}
                onClick={(e) => { e.preventDefault(); setDraft(st.value); setEditing(true); }}>✎</a>
            ) : null}
          </span>
        ) : st.kind === "na" ? (
          <span style={{ color: "var(--muted)" }}>n/a — didn&apos;t exist yet (since {st.since})</span>
        ) : (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {st.kind === "searched_missing" ? (
              <span style={{ color: "var(--danger, #e5484d)" }}>cannot find — searched, likely undisclosed</span>
            ) : (
              <span style={{ color: "var(--muted)", opacity: 0.7 }}>not searched yet</span>
            )}
            {handlers.onHunt ? (
              <a href="#" style={{ fontSize: 11 }} onClick={(e) => { e.preventDefault(); hunt(); }}>
                {hunting ? "hunting…" : "🔍 hunt"}
              </a>
            ) : null}
            {handlers.onSetValue ? (
              <a href="#" style={{ fontSize: 11 }}
                onClick={(e) => { e.preventDefault(); setDraft(""); setEditing(true); }}>✎ set</a>
            ) : null}
          </span>
        )}
      </td>
    </tr>
  );
}

function Node({ node, path, depth, defaultOpen, allPeriods, handlers }: {
  node: MoneyNode; path: string[]; depth: number; defaultOpen: boolean;
  allPeriods: string[]; handlers: TreeCellHandlers;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showBasis, setShowBasis] = useState(false);
  const [showPeriods, setShowPeriods] = useState(false);
  const hasKids = !!node.children?.length;
  const ownPeriods = Object.keys(node.periods ?? {}).length;

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 18, borderLeft: depth === 0 ? "none" : "1px solid var(--border)", paddingLeft: depth === 0 ? 0 : 12, marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 4 }}>
        {hasKids ? (
          <button onClick={() => setOpen(!open)}
            style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, width: 16 }}>
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span style={{ width: 16, display: "inline-block" }} />
        )}
        <span style={{ fontWeight: depth <= 1 ? 700 : 500, fontSize: depth === 0 ? 16 : 14 }}>
          {node.name}
        </span>
        <Chip label="" value={node.value} tone={node.estimated ? "var(--warn)" : "var(--accent)"} />
        <Chip label="share" value={node.share} />
        <Chip label="growth" value={node.growth} />
        <Chip label="margin" value={node.margin} />
        {node.since ? <Chip label="since" value={node.since} /> : null}
        {node.warnings?.length ? (
          <span title={node.warnings.join("\n")} style={{ color: "var(--warn)", cursor: "help", fontSize: 13 }}>⚠</span>
        ) : null}
        {node.estimated && node.basis ? (
          <a href="#" style={{ fontSize: 11 }} onClick={(e) => { e.preventDefault(); setShowBasis(!showBasis); }}>
            {showBasis ? "hide basis" : "≈ basis"}
          </a>
        ) : null}
        <a href="#" style={{ fontSize: 11 }} onClick={(e) => { e.preventDefault(); setShowPeriods(!showPeriods); }}>
          {showPeriods ? "hide history" : `⏳ history${ownPeriods ? ` (${ownPeriods})` : ""}`}
        </a>
        {node.citations?.length ? (
          <span className="label">[{node.citations.join(", ")}]</span>
        ) : null}
      </div>
      {node.note ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginLeft: 16, marginTop: 2 }}>{node.note}</div>
      ) : null}
      {showBasis && node.basis ? (
        <div style={{ fontSize: 12, color: "var(--warn)", marginLeft: 16, marginTop: 2 }}>Estimate basis: {node.basis}</div>
      ) : null}
      {node.warnings?.length ? (
        <div style={{ fontSize: 12, color: "var(--warn)", marginLeft: 16, marginTop: 2 }}>
          {node.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      ) : null}
      {showPeriods ? (
        <table style={{ marginLeft: 16, marginTop: 4, fontSize: 12.5, borderCollapse: "collapse" }}>
          <tbody>
            <PeriodRow node={node} path={path} period="latest" handlers={handlers} />
            {allPeriods.map((p) => (
              <PeriodRow key={p} node={node} path={path} period={p} handlers={handlers} />
            ))}
          </tbody>
        </table>
      ) : null}
      {open && node.children?.map((c, i) => (
        <Node key={`${c.name}-${i}`} node={c} path={[...path, c.name]} depth={depth + 1}
          defaultOpen={depth < 1} allPeriods={allPeriods} handlers={handlers} />
      ))}
    </div>
  );
}

export default function MoneyMap({ root, handlers = {} }: { root: MoneyNode; handlers?: TreeCellHandlers }) {
  const allPeriods = useMemo(() => collectPeriods(root), [root]);
  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 4 }}>
        💸 Money tree — where the revenue comes from, over time ([n] = citations · ~ = analyst
        estimate · ⏳ = time-travel a node&apos;s periods · 🔍 = hunt a missing cell · ✎ = enter a value yourself)
      </div>
      <Node node={root} path={[root.name]} depth={0} defaultOpen
        allPeriods={allPeriods} handlers={handlers} />
    </div>
  );
}
