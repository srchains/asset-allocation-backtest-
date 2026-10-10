import { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import type { AssetConfig, BacktestRun } from "./api";
import { Stat } from "./ui";
import { inr, signedInr, pct, num2, lakh, thin, tooltipStyle, th, td } from "./format";

type Assets = Record<string, AssetConfig>;

// Units are shown for Nifty (shares) and Gold (grams) only; Bond is an index level and Cash has no units.
const unitName = (a: string) => (a === "NIFTY" ? "shares" : a === "GOLD" ? "g" : null);
const label = (assets: Assets, a: string) => assets[a]?.label ?? a;
const color = (assets: Assets, a: string) => assets[a]?.color ?? "#8891a8";
const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export function SummaryCards({ run, showRebalances }: { run: BacktestRun; showRebalances?: boolean }) {
  return (
    <div className={`mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 ${showRebalances ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
      <Stat label="Final value" value={inr(run.final_value)} sub={`from ${inr(run.initial_amount)}`} />
      <Stat label="Total return" value={pct(run.total_return_pct)} tone={run.total_return_pct >= 0 ? "good" : "bad"} />
      <Stat label="CAGR" value={pct(run.cagr_pct)} sub={`${fmtDate(run.start_date)} – ${fmtDate(run.end_date)}`} />
      <Stat label="Max drawdown" value={`${run.max_drawdown_pct.toFixed(2)}%`} tone="bad"
        sub={`${fmtDate(run.max_drawdown_peak)} → ${fmtDate(run.max_drawdown_trough)}${run.max_drawdown_recovered ? `, back ${fmtDate(run.max_drawdown_recovered)}` : ", not recovered"}`} />
      <Stat label="Volatility (yearly)" value={`${run.volatility_pct.toFixed(2)}%`} />
      {showRebalances && <Stat label="Rebalances" value={String(run.rebalance_count)} sub={`${run.rebalance} reset to target`} />}
    </div>
  );
}

/** Colour key in a box at the top-left inside a chart (same as the Asset Allocation page). */
function KeyBox({ items, bottom }: { items: { name: string; color: string }[]; bottom?: boolean }) {
  return (
    <div className={`pointer-events-none absolute left-[84px] ${bottom ? "bottom-9" : "top-2"} z-10 rounded-md border border-border bg-bg/90 px-2.5 py-2 text-xs text-fg`}>
      {items.map((e) => (
        <div key={e.name} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-3 w-5 shrink-0 rounded-[2px]" style={{ background: e.color }} />
          <span className="whitespace-nowrap">{e.name}</span>
        </div>
      ))}
    </div>
  );
}

const PINK = "#f472b6";
const PURPLE = "#a78bfa";   // inflation, same colour as the Asset Allocation page
const lineColor = (assets: Assets, a: string) => (a === "CASH" ? "#ffffff" : color(assets, a));

/** Running fall from the previous high, in %, for one value series (0 = at a new high). */
function drawdowns(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? (v / peak - 1) * 100 : 0;
  });
}

function worst(dd: number[], dates: string[]) {
  let k = 0;
  dd.forEach((v, i) => { if (v < dd[k]) k = i; });
  return { value: dd[k], date: dates[k] };
}

/** One card: the value of each asset stacked with the portfolio line on top, and below it the
 *  drawdown of the portfolio and of each asset on the same time axis (tooltips move together).
 *  `bh` (the buy & hold run, on the Rebalancing page) adds its value and drawdown lines; the
 *  asset drawdowns always come from buy & hold values, which move exactly with each asset's price. */
export function ValueAndDrawdown({ run, bh, assets }: { run: BacktestRun; bh?: BacktestRun; assets: Assets }) {
  const keys = Object.keys(run.weights);
  const dates = run.series.dates;
  const priceRun = bh ?? run;
  const ddAssets = keys.filter((a) => {
    const v = priceRun.series.values[a];
    return v && v.some((x, i) => i > 0 && Math.abs(x - v[i - 1]) > 1e-9);        // skip flat cash
  });
  const ddPort = drawdowns(run.series.total);
  const ddBh = bh ? drawdowns(bh.series.total) : null;
  // After inflation = portfolio / inflation line x starting amount (its fall from the previous high).
  const infl = run.series.inflation;
  const ddReal = drawdowns(run.series.total.map((v, i) => (v / infl[i]) * run.initial_amount));
  const ddA: Record<string, number[]> = Object.fromEntries(ddAssets.map((a) => [a, drawdowns(priceRun.series.values[a])]));
  const portName = bh ? "Rebalanced" : "Portfolio";
  const rows = thin(dates.map((d, i) => {
    const row: Record<string, string | number> = { date: d, total: run.series.total[i], dd: ddPort[i], infl: infl[i], ddreal: ddReal[i] };
    for (const a of keys) row[a] = (priceRun.series.values[a][i] / priceRun.weights[a]) * 100;   // 100% in this asset
    if (bh && ddBh) { row.bh = bh.series.total[i]; row.ddbh = ddBh[i]; }
    for (const a of ddAssets) row[`dd_${a}`] = ddA[a][i];
    return row;
  }));
  const chips = [
    { name: portName, color: "#f472b6", ...worst(ddPort, dates) },
    { name: `${portName} after inflation`, color: PURPLE, ...worst(ddReal, dates) },
    ...(bh && ddBh ? [{ name: "Buy & hold", color: "#22d3ee", ...worst(ddBh, dates) }] : []),
    ...ddAssets.map((a) => ({ name: label(assets, a), color: color(assets, a), ...worst(ddA[a], dates) })),
  ];
  const xAxis = <XAxis dataKey="date" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} tickFormatter={(d: string) => d.slice(0, 7)} />;
  const valueKey = [
    ...keys.map((a) => ({ name: `100% ${label(assets, a)}`, color: lineColor(assets, a) })),
    { name: "Inflation", color: PURPLE },
    ...(bh ? [{ name: "Buy & hold", color: "#22d3ee" }] : []),
    { name: bh ? "My Portfolio (rebalanced)" : "My Portfolio", color: PINK },
  ];
  const ddKey = [
    ...ddAssets.map((a) => ({ name: label(assets, a), color: lineColor(assets, a) })),
    { name: "My Portfolio after inflation", color: PURPLE },
    ...(bh ? [{ name: "Buy & hold", color: "#22d3ee" }] : []),
    { name: bh ? "My Portfolio (rebalanced)" : "My Portfolio", color: PINK },
  ];
  return (
    <>
      <div className="relative">
      <KeyBox items={valueKey} />
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={rows} syncId="bt" margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
          {xAxis}
          <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={70} tickFormatter={(v) => lakh(Number(v))} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => fmtDate(String(d))}
            formatter={(v, n) => [inr(Number(v)), n === "total" ? portName : n === "bh" ? "Buy & hold" : n === "infl" ? "Inflation" : `100% ${label(assets, String(n))}`]} />
          {keys.map((a) => (
            <Line key={a} type="monotone" dataKey={a} stroke={lineColor(assets, a)} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
          <Line type="monotone" dataKey="infl" stroke={PURPLE} dot={false} strokeWidth={2} isAnimationActive={false} />
          {bh && <Line type="monotone" dataKey="bh" stroke="#22d3ee" dot={false} strokeWidth={2} strokeDasharray="6 3" isAnimationActive={false} />}
          <Line type="monotone" dataKey="total" stroke={PINK} dot={false} strokeWidth={5} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      </div>

      <h4 className="mb-1 mt-5 text-base font-semibold text-fg">Drawdown: fall from the previous high</h4>
      <p className="mb-2 text-sm text-fg-muted">
        How far each line was below its highest earlier value (0% = at a new high). Assets are shown as if held on their own; the purple line is your portfolio after inflation.
      </p>
      <div className="relative">
      <KeyBox items={ddKey} bottom />
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} syncId="bt" margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
          {xAxis}
          <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={70} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => fmtDate(String(d))}
            formatter={(v, n) => [`${Number(v).toFixed(2)}%`, n === "dd" ? portName : n === "ddbh" ? "Buy & hold" : n === "ddreal" ? `${portName} after inflation` : label(assets, String(n).slice(3))]} />
          {ddAssets.map((a) => (
            <Line key={a} type="monotone" dataKey={`dd_${a}`} stroke={lineColor(assets, a)} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
          <Line type="monotone" dataKey="ddreal" stroke={PURPLE} dot={false} strokeWidth={2} isAnimationActive={false} />
          {bh && <Line type="monotone" dataKey="ddbh" stroke="#22d3ee" dot={false} strokeWidth={2} strokeDasharray="6 3" isAnimationActive={false} />}
          <Line type="monotone" dataKey="dd" stroke={PINK} dot={false} strokeWidth={5} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {chips.map((c) => (
          <div key={c.name} className="rounded-lg border border-border bg-bg px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <span className="inline-block h-3 w-5 shrink-0 rounded-[2px]" style={{ background: c.color }} />
              {c.name}
            </div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${c.value < -0.005 ? "text-danger" : "text-fg"}`}>
              {c.value < -0.005 ? `${c.value.toFixed(2)}%` : "0.00%"}
            </div>
            <div className="text-xs text-fg-muted">worst fall{c.value < -0.005 ? `, ${fmtDate(c.date)}` : ""}</div>
          </div>
        ))}
      </div>
    </>
  );
}

export function YearTable({ run, other, otherLabel }: { run: BacktestRun; other?: BacktestRun; otherLabel?: string }) {
  const otherBy = new Map((other?.calendar_years ?? []).map((y) => [y.year, y]));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[620px] border-collapse text-base">
        <thead>
          <tr className="bg-bg text-left text-sm uppercase tracking-wide text-fg-muted">
            <th className={th}>Year</th>
            <th className={`${th} text-right`}>Start value</th>
            <th className={`${th} text-right`}>End value</th>
            <th className={`${th} text-right`}>Return</th>
            {other && <th className={`${th} text-right`}>{otherLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {run.calendar_years.map((y) => {
            const o = otherBy.get(y.year);
            return (
              <tr key={y.year} className="border-t border-border">
                <td className={td}>
                  {y.year}
                  {y.partial && <span className="ml-1.5 text-xs text-fg-muted">({fmtDate(y.from)} – {fmtDate(y.to)})</span>}
                  {y.year === run.best_year.year && <span className="ml-2 rounded bg-bonds/15 px-1.5 py-0.5 text-xs text-bonds">best</span>}
                  {y.year === run.worst_year.year && <span className="ml-2 rounded bg-danger/15 px-1.5 py-0.5 text-xs text-danger">worst</span>}
                </td>
                <td className={`${td} text-right`}>{inr(y.start_value)}</td>
                <td className={`${td} text-right`}>{inr(y.end_value)}</td>
                <td className={`${td} text-right ${y.return_pct >= 0 ? "text-bonds" : "text-danger"}`}>{pct(y.return_pct)}</td>
                {other && <td className={`${td} text-right text-fg-muted`}>{o ? pct(o.return_pct) : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AssetTable({ run, assets }: { run: BacktestRun; assets: Assets }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[760px] border-collapse text-base">
        <thead>
          <tr className="bg-bg text-left text-sm uppercase tracking-wide text-fg-muted">
            {["Asset", "Weight", "Start value", "End value", "Gain", "Contribution to return", "Shares / grams start → end"].map((h, k) => (
              <th key={h} className={`${th} ${k ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.assets.map((a) => (
            <tr key={a.asset} className="border-t border-border">
              <td className={td}>
                <span className="mr-2 inline-block h-3 w-3 rounded-sm align-middle" style={{ background: color(assets, a.asset) }} />
                {label(assets, a.asset)}
              </td>
              <td className={`${td} text-right`}>{a.weight}%</td>
              <td className={`${td} text-right`}>{inr(a.start_value)}</td>
              <td className={`${td} text-right`}>{inr(a.end_value)}</td>
              <td className={`${td} text-right ${a.pnl >= 0 ? "text-bonds" : "text-danger"}`}>{signedInr(a.pnl)}</td>
              <td className={`${td} text-right`}>{pct(a.contribution_pct)}</td>
              <td className={`${td} text-right text-fg-muted`}>
                {unitName(a.asset) && a.units_start !== null && a.units_end !== null
                  ? `${num2(a.units_start)} → ${num2(a.units_end)} ${unitName(a.asset)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

export function DataNotes({ run }: { run: BacktestRun }) {
  const notes: string[] = [];
  if ("BOND" in run.weights && run.start_date < "2015-10-13")
    notes.push("Bond before 2015-10-13 is the SBI FD rate spread evenly over each year (no daily bond prices), so it moves in a straight line there.");
  if ("GOLD" in run.weights && run.start_date < "2005-06-06")
    notes.push("Gold before 2005-06-06 is the global GOLDINR price × the MCX matching factor (MCX starts in June 2005).");
  if (run.data_log.excluded.length)
    notes.push(`${run.data_log.excluded.length} day(s) left out because an asset had no price for more than 5 days.`);
  if (run.data_log.forward_filled)
    notes.push(`${run.data_log.forward_filled} missing price(s) carried forward from the previous day (holidays).`);
  if (!notes.length) return null;
  return (
    <ul className="mb-5 list-disc space-y-1 rounded-lg border border-border bg-panel px-8 py-3 text-sm text-fg-muted">
      {notes.map((n) => <li key={n}>{n}</li>)}
    </ul>
  );
}

