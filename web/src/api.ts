export interface MonthRow {
  period: string;
  nominalValue: number;
  realValue: number;
  equityValue: number;
  goldValue: number;
  bondsValue: number;
  midcapValue: number;
  smallcapValue: number;
  cashValue: number;
}

export interface RiskMetrics {
  volatilityPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
}

export interface MarketDataRow {
  period: string;
  niftyClose: number;
  goldPerGram: number;
  bondsRetPct: number; // Bonds return of that period (a year)
  inflationPct: number;
  midcapClose: number;
  smallcapClose: number;
}

export interface RebalanceItem {
  asset: string;
  targetPct: number;
  actualPct: number;
  driftPct: number;
  actualValue: number;
  targetValue: number;
  trade: number;
}

export interface RebalanceEvent {
  period: string;
  total: number;
  rebalanced: boolean;
  items: RebalanceItem[];
}

export interface BacktestResult {
  rebalanceEvents: RebalanceEvent[];
  rows: MonthRow[];
  clampedStart: string;
  clampedEnd: string;
  cashPct: number;
  periodsPerYear: number; // 1: every row is a December close
  buyPeriod: string; // the December the money is put in
  risk: RiskMetrics;
  riskFreePct: number;
  marketData: MarketDataRow[];
  goldBuyPerGram: number;
  niftyBuyClose: number;
  midcapBuyClose: number;
  smallcapBuyClose: number;
}

export interface DataRange {
  min: string;
  max: string;
  data_through?: string;   // the newest day the API has data for
  last_close?: string;     // the close (last trading day) of the last complete month, used for "as of now"
  latest?: { nifty: number; nifty_date: string; gold: number; gold_date: string };   // newest prices
}

async function fetchRangeOnce(): Promise<DataRange> {
  const res = await fetch("/api/range", { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Failed to fetch data range: ${res.status}`);
  }
  return res.json();
}

/** The data range, retried a few times (the backend may still be starting or loading the API
 *  data), so the page doesn't stay on "Loading" forever after one failed or stuck request. */
export async function fetchRange(tries = 5): Promise<DataRange> {
  for (let i = 1; ; i++) {
    try {
      return await fetchRangeOnce();
    } catch (e) {
      if (i >= tries) throw e instanceof Error && e.name === "TimeoutError" ? new Error("The backend did not answer (timed out). Is it running?") : e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

interface RiskMetricsWire {
  volatility_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number | null;
}

function riskFromWire(r: RiskMetricsWire): RiskMetrics {
  return { volatilityPct: r.volatility_pct, maxDrawdownPct: r.max_drawdown_pct, sharpeRatio: r.sharpe_ratio };
}

export async function fetchBacktest(
  params: {
    capital: number;
    equity: number;
    gold: number;
    bonds: number;
    midcap: number;
    smallcap: number;
    start: string;
    end: string;
    rebalance: boolean;
    tolerance: number;
    frequency: "yearly" | "monthly";
  },
  signal?: AbortSignal
): Promise<BacktestResult> {
  const res = await fetch("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((d: { loc?: string[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`).join("; ")
      : body.detail;
    throw new Error(detail || `Backtest request failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    rows: data.rows.map((r: {
      period: string; nominal_value: number; real_value: number;
      equity_value: number; gold_value: number; bonds_value: number; midcap_value: number;
      smallcap_value: number; cash_value: number;
    }) => ({
      period: r.period,
      nominalValue: r.nominal_value,
      realValue: r.real_value,
      equityValue: r.equity_value,
      goldValue: r.gold_value,
      bondsValue: r.bonds_value,
      midcapValue: r.midcap_value,
      smallcapValue: r.smallcap_value,
      cashValue: r.cash_value,
    })),
    rebalanceEvents: (data.rebalance_events ?? []).map((e: {
      period: string; total: number; rebalanced: boolean;
      items: { asset: string; target_pct: number; actual_pct: number; drift_pct: number;
               actual_value: number; target_value: number; trade: number }[];
    }) => ({
      period: e.period,
      total: e.total,
      rebalanced: e.rebalanced,
      items: e.items.map((i) => ({
        asset: i.asset, targetPct: i.target_pct, actualPct: i.actual_pct, driftPct: i.drift_pct,
        actualValue: i.actual_value, targetValue: i.target_value, trade: i.trade,
      })),
    })),
    clampedStart: data.clamped_start,
    clampedEnd: data.clamped_end,
    cashPct: data.cash_pct,
    periodsPerYear: data.periods_per_year ?? 12,
    buyPeriod: data.buy_period ?? "",
    risk: riskFromWire(data.risk),
    riskFreePct: data.risk_free_pct,
    marketData: data.market_data.map((d: {
      period: string; nifty_close: number; gold_per_gram: number;
      bonds_ret_pct: number; inflation_pct: number; midcap_close: number; smallcap_close: number;
    }) => ({
      period: d.period,
      niftyClose: d.nifty_close,
      goldPerGram: d.gold_per_gram,
      bondsRetPct: d.bonds_ret_pct,
      inflationPct: d.inflation_pct,
      midcapClose: d.midcap_close,
      smallcapClose: d.smallcap_close,
    })),
    goldBuyPerGram: data.gold_buy_per_gram,
    niftyBuyClose: data.nifty_buy_close,
    midcapBuyClose: data.midcap_buy_close,
    smallcapBuyClose: data.smallcap_buy_close,
  };
}
