// Client for the backtester endpoints (allocations + daily portfolio backtest).

export type AssetKey = string;

export interface AssetConfig {
  label: string;
  symbol?: string;
  loader?: string;
  color?: string;
  annual_return_pct?: number;
  source?: string;
}

export interface Allocation {
  id: string;
  name: string;
  type: "predefined" | "custom";
  weights: Record<AssetKey, number>;
  created_at?: string;
  updated_at?: string;
}

export type Rebalance = "none" | "monthly" | "quarterly" | "yearly";

export interface CalendarYear {
  year: number;
  start_value: number;
  end_value: number;
  return_pct: number;
  partial: boolean;
  from: string;
  to: string;
}

export interface AssetRow {
  asset: AssetKey;
  weight: number;
  start_value: number;
  end_value: number;
  pnl: number;
  contribution_pct: number;
  units_start: number | null;
  units_end: number | null;
}

export interface RebalanceAsset {
  weight_before: number;
  weight_after: number;
  value_before: number;
  value_after: number;
  traded_value: number;
  price: number | null;
  units_before: number | null;
  units_after: number | null;
  units_traded: number | null;
}

export interface RebalanceEntry {
  date: string;
  total_before: number;
  cost: number;
  assets: Record<AssetKey, RebalanceAsset>;
}

export interface BacktestRun {
  weights: Record<AssetKey, number>;
  rebalance: Rebalance;
  initial_amount: number;
  start_date: string;
  end_date: string;
  trading_days: number;
  series: { dates: string[]; total: number[]; values: Record<AssetKey, number[]>; inflation: number[] };
  final_value: number;
  total_return_pct: number;
  cagr_pct: number;
  volatility_pct: number;
  max_drawdown_pct: number;
  max_drawdown_peak: string;
  max_drawdown_trough: string;
  max_drawdown_recovered: string | null;
  calendar_years: CalendarYear[];
  best_year: CalendarYear;
  worst_year: CalendarYear;
  assets: AssetRow[];
  rebalance_count: number;
  rebalance_log: RebalanceEntry[];
  data_log: { excluded: { date: string; reason: string }[]; forward_filled: number };
}

export interface BacktestResponse {
  allocation: { id: string | null; name: string; type: string; weights: Record<AssetKey, number> };
  result: BacktestRun;
  buy_and_hold?: BacktestRun;
}

export interface ImportSummary {
  imported: Allocation[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; errors: string[] }[];
}

export class ApiError extends Error {
  errors: string[];
  constructor(message: string, errors: string[] = [message]) {
    super(message);
    this.errors = errors;
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const d = body.detail;
    if (d && typeof d === "object" && !Array.isArray(d) && d.message) throw new ApiError(d.message, d.errors ?? [d.message]);
    if (Array.isArray(d)) {
      const msgs = d.map((x: { loc?: string[]; msg?: string }) => `${(x.loc ?? []).slice(1).join(".")}: ${x.msg}`);
      throw new ApiError(msgs.join("; "), msgs);
    }
    throw new ApiError(typeof d === "string" ? d : `Request failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const listAllocations = () =>
  call<{ assets: Record<AssetKey, AssetConfig>; allocations: Allocation[] }>("/api/allocations");
export const assetRanges = () => call<Record<AssetKey, { first: string; last: string } | null>>("/api/assets/ranges");
export const createAllocation = (name: string, weights: Record<AssetKey, number>) =>
  call<Allocation>("/api/allocations", { method: "POST", body: JSON.stringify({ name, weights }) });
export const updateAllocation = (id: string, name: string, weights: Record<AssetKey, number>) =>
  call<Allocation>(`/api/allocations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name, weights }) });
export const deleteAllocation = (id: string) =>
  call<Allocation>(`/api/allocations/${encodeURIComponent(id)}`, { method: "DELETE" });
export const duplicateAllocation = (id: string, name: string) =>
  call<Allocation>(`/api/allocations/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: JSON.stringify({ name }) });
export const exportAllocations = () => call<unknown>("/api/allocations/export");
export const importAllocations = (doc: unknown) =>
  call<ImportSummary>("/api/allocations/import", { method: "POST", body: JSON.stringify(doc) });

export const runPortfolioBacktest = (params: {
  allocation_id: string;
  start_date: string;
  end_date: string;
  initial_amount: number;
  rebalance: Rebalance;
  compare?: boolean;
}, signal?: AbortSignal) =>
  call<BacktestResponse>("/api/portfolio-backtest", { method: "POST", body: JSON.stringify(params), signal });
