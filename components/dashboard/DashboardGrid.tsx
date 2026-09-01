"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GridLayout,
  type Layout,
  type LayoutItem,
  useContainerWidth,
} from "react-grid-layout";

import "react-grid-layout/css/styles.css";

import type { Dashboard, Widget, WidgetSpec } from "./dashboard-types";
import { DEFAULT_COLS, genId } from "./dashboard-types";
import { RenderedWidget } from "./dashboard-widgets";
import gridStyles from "./DashboardGrid.module.css";

// Ported from StocksMax `DashboardGrid.tsx` (sandbox subset): the same
// 12-column react-grid-layout with drag + resize in edit mode, an add-widget
// menu, per-cell remove badges, a debounced symbol selector that every widget
// bound to "{{symbol}}" tracks, and a memoized widget cell so dragging one
// widget doesn't re-render every chart.

const ROW_HEIGHT = 80;

const MemoWidget = memo(RenderedWidget);

const ADD_OPTIONS: Array<{
  label: string;
  build: () => WidgetSpec & { size: { col: number; row: number; w: number; h: number } };
}> = [
  { label: "Headline", build: () => ({ kind: "headline", text: "# Section", size: { col: 0, row: 0, w: 12, h: 1 } }) },
  { label: "Price header (name + price + range)", build: () => ({ kind: "priceHeader", symbol: "{{symbol}}", size: { col: 0, row: 0, w: 6, h: 3 } }) },
  { label: "Price chart (5y)", build: () => ({ kind: "price", symbol: "{{symbol}}", years: 5, size: { col: 0, row: 0, w: 8, h: 4 } }) },
  { label: "Price chart (1y)", build: () => ({ kind: "price", symbol: "{{symbol}}", years: 1, size: { col: 0, row: 0, w: 8, h: 4 } }) },
  { label: "Compare price vs SPY", build: () => ({ kind: "compare", symbol: "{{symbol}}", benchmarks: ["SPY"], years: 2, size: { col: 0, row: 0, w: 8, h: 4 } }) },
  { label: "Compare vs QQQ + SPY", build: () => ({ kind: "compare", symbol: "{{symbol}}", benchmarks: ["QQQ", "SPY"], years: 2, size: { col: 0, row: 0, w: 8, h: 4 } }) },
  { label: "Stats grid (returns, vol, drawdown…)", build: () => ({ kind: "statsGrid", symbol: "{{symbol}}", size: { col: 0, row: 0, w: 6, h: 6 } }) },
  { label: "News feed", build: () => ({ kind: "news", symbol: "{{symbol}}", size: { col: 0, row: 0, w: 6, h: 5 } }) },
  { label: "Watchlist", build: () => ({ kind: "watchlist", symbols: "AAPL, MSFT, NVDA, SPY", size: { col: 0, row: 0, w: 6, h: 4 } }) },
  { label: "AI summary (stock)", build: () => ({ kind: "aiSummary", symbol: "{{symbol}}", size: { col: 0, row: 0, w: 8, h: 4 } }) },
  { label: "KPI Finder — source any metric (web)", build: () => ({ kind: "kpiSource", symbol: "{{symbol}}", kpi: "", chartType: "bar", size: { col: 0, row: 0, w: 6, h: 5 } }) },
  { label: "Sticky notes", build: () => ({ kind: "notes", size: { col: 0, row: 0, w: 4, h: 3 } }) },
  { label: "10-Q Filing (locked)", build: () => ({ kind: "placeholder", feature: "10-Q Filing viewer", note: "Inline SEC filings with delta chips require the EDGAR pipeline.", size: { col: 0, row: 0, w: 4, h: 3 } }) },
  { label: "My Quant score (locked)", build: () => ({ kind: "placeholder", feature: "My Quant", note: "Custom quant scores require the scoring engine.", size: { col: 0, row: 0, w: 4, h: 3 } }) },
  { label: "DCF valuation (locked)", build: () => ({ kind: "placeholder", feature: "DCF valuation", note: "DCF models require the fundamentals pipeline.", size: { col: 0, row: 0, w: 4, h: 3 } }) },
];

function widgetToLayoutItem(w: Widget, cols: number): LayoutItem {
  return {
    i: w.id,
    x: Math.max(0, Math.min(cols - 1, w.size.col)),
    y: Math.max(0, w.size.row),
    w: Math.max(1, Math.min(cols, w.size.w)),
    h: Math.max(1, w.size.h),
  };
}

type Props = {
  dashboard: Dashboard;
  onChange: (next: Dashboard) => void;
  onReset?: () => void;
};

export function DashboardGrid({ dashboard, onChange, onReset }: Props) {
  const [editing, setEditing] = useState(false);
  // The text field updates on every keystroke; `symbolOverride` (which drives
  // widget refetches) is committed after a debounce so typing "NVDA" doesn't
  // fire four fetch storms.
  const [symbolInput, setSymbolInput] = useState(dashboard.defaultSymbol ?? "AAPL");
  const [symbolOverride, setSymbolOverride] = useState(dashboard.defaultSymbol ?? "AAPL");
  useEffect(() => {
    const t = setTimeout(() => setSymbolOverride(symbolInput), 350);
    return () => clearTimeout(t);
  }, [symbolInput]);

  const cols = dashboard.cols ?? DEFAULT_COLS;
  const lastSerialized = useRef<string>(JSON.stringify(dashboard));
  // Latest dashboard in a ref so the per-widget update callback stays stable
  // (keeps MemoWidget from re-rendering every chart when one widget updates).
  const dashboardRef = useRef(dashboard);
  useEffect(() => {
    lastSerialized.current = JSON.stringify(dashboard);
    dashboardRef.current = dashboard;
  }, [dashboard]);

  // Patch one widget's spec (used by the KPI Finder to persist its metric).
  const updateWidget = useCallback((id: string, patch: Partial<WidgetSpec>) => {
    const d = dashboardRef.current;
    onChange({
      ...d,
      widgets: d.widgets.map((w) => (w.id === id ? ({ ...w, ...patch } as Widget) : w)),
    });
  }, [onChange]);

  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1100 });
  const layoutWidth = Math.max(width, cols * 56);

  const layout = useMemo<Layout>(
    () => dashboard.widgets.map((w) => widgetToLayoutItem(w, cols)),
    [dashboard.widgets, cols],
  );

  function applyLayout(next: Layout) {
    if (!editing) return;
    const byId = new Map(next.map((l) => [l.i, l]));
    let changed = false;
    const updated: Widget[] = dashboard.widgets.map((w) => {
      const l = byId.get(w.id);
      if (!l) return w;
      if (w.size.col === l.x && w.size.row === l.y && w.size.w === l.w && w.size.h === l.h) return w;
      changed = true;
      return { ...w, size: { col: l.x, row: l.y, w: l.w, h: l.h } };
    });
    if (!changed) return;
    const serialized = JSON.stringify({ ...dashboard, widgets: updated });
    if (serialized === lastSerialized.current) return;
    lastSerialized.current = serialized;
    onChange({ ...dashboard, widgets: updated, defaultSymbol: symbolOverride });
  }

  function nextRowBottom(): number {
    return dashboard.widgets.reduce((acc, w) => Math.max(acc, w.size.row + w.size.h), 0);
  }

  function addWidget(idx: number) {
    const opt = ADD_OPTIONS[idx];
    if (!opt) return;
    const spec = opt.build();
    const widget: Widget = { ...spec, id: genId(), size: { ...spec.size, row: nextRowBottom() } } as Widget;
    onChange({ ...dashboard, widgets: [...dashboard.widgets, widget] });
  }

  function removeWidget(id: string) {
    onChange({ ...dashboard, widgets: dashboard.widgets.filter((w) => w.id !== id) });
  }

  return (
    <div>
      <div className={gridStyles.toolbar}>
        <span className={gridStyles.toolbarLabel}>{dashboard.name}</span>
        <span className={gridStyles.toolbarLabel}>· Symbol</span>
        <input
          className={gridStyles.toolbarInput}
          value={symbolInput}
          onChange={(e) => setSymbolInput(e.target.value.trim().toUpperCase())}
          placeholder="AAPL"
        />
        <span className={gridStyles.toolbarSpacer} />
        {editing ? (
          <select
            className={gridStyles.toolbarSelect}
            onChange={(e) => {
              const idx = Number(e.target.value);
              if (Number.isFinite(idx)) addWidget(idx);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>+ Add widget…</option>
            {ADD_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>{o.label}</option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className={editing ? gridStyles.btnPrimary : gridStyles.btn}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? "Done editing" : "Edit"}
        </button>
        {onReset ? (
          <button type="button" className={gridStyles.btnDanger} onClick={onReset}>
            Reset
          </button>
        ) : null}
      </div>

      <div ref={containerRef} className={gridStyles.gridArea}>
        {mounted && layoutWidth > 0 ? (
          <GridLayout
            width={layoutWidth}
            layout={layout}
            onLayoutChange={applyLayout}
            gridConfig={{ cols, rowHeight: ROW_HEIGHT, margin: [10, 10] }}
            dragConfig={{ enabled: editing, bounded: false, threshold: 3 }}
            resizeConfig={{ enabled: editing, handles: ["se"] }}
          >
            {dashboard.widgets.map((w) => (
              <div key={w.id} style={{ position: "relative" }} className={editing ? gridStyles.dragHint : undefined}>
                {editing ? (
                  <button type="button" className={gridStyles.removeBadge} onClick={() => removeWidget(w.id)}>
                    ×
                  </button>
                ) : null}
                <MemoWidget widget={w} symbolOverride={symbolOverride || undefined} onUpdate={updateWidget} />
              </div>
            ))}
          </GridLayout>
        ) : null}
      </div>
    </div>
  );
}
