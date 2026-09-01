/**
 * Sandbox subset of the StocksMax dashboard widget schema
 * (`web/src/lib/dashboard-types.ts`). Same shape — widget specs are JSON with
 * a `size` in grid units and a `{{symbol}}` placeholder that tracks the
 * dashboard's symbol selector — but only the widget kinds this limited demo
 * can drive from Tiingo data (plus an optional AI summary) are included.
 */

export const DEFAULT_COLS = 12;

export type WidgetSize = { col: number; row: number; w: number; h: number };

export type WidgetKind =
  | "headline"
  | "priceHeader"
  | "price"
  | "compare"
  | "statsGrid"
  | "news"
  | "watchlist"
  | "aiSummary"
  | "kpiSource"
  | "notes"
  | "placeholder";

export type WidgetSpec =
  | { kind: "headline"; text: string }
  | { kind: "priceHeader"; symbol: string }
  | { kind: "price"; symbol: string; years?: number }
  | { kind: "compare"; symbol: string; benchmarks: string[]; years?: number }
  | { kind: "statsGrid"; symbol: string }
  | { kind: "news"; symbol: string }
  | { kind: "watchlist"; symbols: string }
  | { kind: "aiSummary"; symbol: string }
  | { kind: "kpiSource"; symbol: string; kpi: string; chartType?: "bar" | "line" }
  | { kind: "notes" }
  | { kind: "placeholder"; feature: string; note: string };

export type Widget = WidgetSpec & { id: string; size: WidgetSize };

export type Dashboard = {
  name: string;
  defaultSymbol?: string;
  cols: number;
  widgets: Widget[];
};

/** Replace the `{{symbol}}` placeholder with the dashboard's active symbol. */
export function substituteSymbol(value: string, symbol: string | undefined): string {
  return value.replace(/\{\{symbol\}\}/g, symbol || "AAPL");
}

export function genId(): string {
  return `w_${Math.random().toString(36).slice(2, 9)}`;
}
