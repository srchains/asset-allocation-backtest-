import { useState } from "react";
import type { AssetConfig, BacktestRun } from "./api";
import { inr, pct, num2, fmtDate, th, td } from "./format";

type Assets = Record<string, AssetConfig>;

// Units are shown for Nifty (shares) and Gold (grams) only; Bond is an index level and Cash has no units.
const unitName = (a: string) => (a === "NIFTY" ? "shares" : a === "GOLD" ? "g" : null);
const label = (assets: Assets, a: string) => assets[a]?.label ?? a;

export function ComparisonTable({ rb, bh, rbLabel }: { rb: BacktestRun; bh: BacktestRun; rbLabel: string }) {
  const rows: [string, (r: BacktestRun) => string, number][] = [
    ["Final value", (r) => inr(r.final_value), rb.final_value - bh.final_value],
    ["CAGR", (r) => pct(r.cagr_pct), rb.cagr_pct - bh.cagr_pct],
    ["Max drawdown", (r) => `${r.max_drawdown_pct.toFixed(2)}%`, rb.max_drawdown_pct - bh.max_drawdown_pct],
    ["Volatility", (r) => `${r.volatility_pct.toFixed(2)}%`, bh.volatility_pct - rb.volatility_pct],
  ];
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[560px] border-collapse text-base">
        <thead>
          <tr className="bg-bg text-left text-sm uppercase tracking-wide text-fg-muted">
            <th className={th}></th>
            <th className={`${th} text-right`}>{rbLabel}</th>
            <th className={`${th} text-right`}>Buy &amp; hold</th>
            <th className={`${th} text-right`}>Better</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f, diff]) => (
            <tr key={name} className="border-t border-border">
              <td className={td}>{name}</td>
              <td className={`${td} text-right font-semibold`}>{f(rb)}</td>
              <td className={`${td} text-right`}>{f(bh)}</td>
              <td className={`${td} text-right ${Math.abs(diff) < 1e-9 ? "text-fg-muted" : diff > 0 ? "text-accent" : "text-fg-muted"}`}>
                {Math.abs(diff) < 1e-9 ? "same" : diff > 0 ? "Rebalancing" : "Buy & hold"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RebalanceLog({ run, assets }: { run: BacktestRun; assets: Assets }) {
  const [page, setPage] = useState(0);
  const per = 10;
  const pages = Math.max(1, Math.ceil(run.rebalance_log.length / per));
  const rows = run.rebalance_log.slice(page * per, page * per + per);
  const keys = Object.keys(run.weights);
  if (!run.rebalance_log.length) return <p className="text-sm text-fg-muted">No rebalance in this period.</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[820px] border-collapse text-base">
          <thead>
            <tr className="bg-bg text-left text-sm uppercase tracking-wide text-fg-muted">
              <th className={th}>Date</th>
              <th className={`${th} text-right`}>Portfolio</th>
              {keys.map((a) => <th key={a} className={`${th} text-right`}>{label(assets, a)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.date} className="border-t border-border align-top">
                <td className={td}>{fmtDate(e.date)}</td>
                <td className={`${td} text-right`}>{inr(e.total_before)}</td>
                {keys.map((a) => {
                  const x = e.assets[a];
                  return (
                    <td key={a} className={`${td} text-right`}>
                      <div>{x.weight_before.toFixed(1)}% → {x.weight_after.toFixed(1)}%</div>
                      <div className={`text-sm ${x.traded_value >= 0 ? "text-bonds" : "text-danger"}`}>
                        {Math.abs(x.traded_value) < 0.5 ? "—" : `${x.traded_value >= 0 ? "Buy" : "Sell"} ${inr(Math.abs(x.traded_value))}`}
                      </div>
                      {unitName(a) && x.units_traded !== null && Math.abs(x.traded_value) >= 0.5 && (
                        <div className="text-xs text-fg-muted">
                          {x.units_traded >= 0 ? "+" : "−"}{num2(Math.abs(x.units_traded))} {unitName(a)} @ {num2(x.price ?? 0)}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-sm text-fg-muted">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}
          className="rounded-lg border border-border bg-bg px-3 py-1.5 enabled:hover:text-fg disabled:opacity-40">← Prev</button>
        <span>Page {page + 1} of {pages} · {run.rebalance_log.length} rebalances</span>
        <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}
          className="rounded-lg border border-border bg-bg px-3 py-1.5 enabled:hover:text-fg disabled:opacity-40">Next →</button>
      </div>
    </>
  );
}
