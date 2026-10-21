import type { ReactNode } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import type { BacktestResponse } from "./api";
import { inr, pct, lakh, thin, tooltipStyle, th, td, fmtDate, drawdowns } from "./format";
import { usePersisted, isBool } from "../persist";
import { logAxis } from "../logScale";
import LogToggle from "../LogToggle";

const INFLATION = "#a78bfa";

function ChartBox({ title, note, action, children }: { title: string; note: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 rounded-lg border border-border bg-bg p-3">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-base font-semibold text-fg">{title}</h4>
        {action}
      </div>
      <p className="mb-2 text-xs text-fg-muted">{note}</p>
      {children}
    </div>
  );
}

/** The ticked plans (one or more) on two charts, value (with the inflation line and an optional log
 *  scale) and drawdown, one line per plan in its colour, and a table of final value, return, CAGR,
 *  max drawdown and volatility. `runs` share the dates and the starting amount. */
export default function PlanComparison({ runs, colorOf, showRebalances }: {
  runs: BacktestResponse[];
  colorOf: (id: string) => string;
  showRebalances?: boolean;
}) {
  const [logScale, setLogScale] = usePersisted("logCmp", false, isBool);
  const best = Math.max(...runs.map((r) => r.result.cagr_pct));
  // Plans can have slightly different trading days (assets differ): join them by date.
  const byDate = new Map<string, Record<string, number | string>>();
  runs.forEach((r, i) => {
    const s = r.result.series;
    const dd = drawdowns(s.total);
    s.dates.forEach((d, j) => {
      const row = byDate.get(d) ?? { date: d };
      row[`p${i}`] = s.total[j];
      row[`dd${i}`] = dd[j];
      if (row.infl === undefined) row.infl = s.inflation[j];
      byDate.set(d, row);
    });
  });
  const rows = thin([...byDate.keys()].sort().map((d) => byDate.get(d)!));
  const color = (i: number) => colorOf(runs[i].allocation.id ?? "");
  const planName = (n: string) => (n === "infl" ? "Inflation" : runs[Number(n.replace(/^\D+/, ""))]?.allocation.name ?? n);
  const xAxis = <XAxis dataKey="date" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} tickFormatter={(d: string) => d.slice(0, 7)} />;
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />;
  const logAx = logScale
    ? logAxis(rows.flatMap((r) => [...runs.keys()].map((i) => Number(r[`p${i}`])).concat(Number(r.infl))))
    : null;

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-2">
        {runs.map((r, i) => (
          <div key={r.allocation.id} className="flex items-center gap-2 text-sm">
            <span className="h-3 w-5 shrink-0 rounded-[2px]" style={{ background: color(i) }} />
            <span className="text-fg">{r.allocation.name}</span>
            <span className="font-semibold tabular-nums text-fg">{inr(r.result.final_value)}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 text-sm">
          <span className="h-0 w-5 shrink-0 border-t-2 border-dashed" style={{ borderColor: INFLATION }} />
          <span className="text-fg-muted">Inflation</span>
        </div>
      </div>

      <ChartBox title="Value" action={<LogToggle checked={logScale} onChange={setLogScale} />}
        note="Each plan's value in rupees; the dashed line is what the money needs to keep up with inflation.">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={rows} syncId="plans" margin={{ left: 8, right: 8 }}>
            {grid}{xAxis}
            <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={70} tickFormatter={(v) => lakh(Number(v))}
              scale={logAx ? "log" : "auto"} domain={logAx ? logAx.domain : [0, "auto"]} ticks={logAx?.ticks} allowDataOverflow={!!logAx} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => fmtDate(String(d))}
              itemSorter={(it) => -Number(it.value ?? 0)} formatter={(v, n) => [inr(Number(v)), planName(String(n))]} />
            <Line type="monotone" dataKey="infl" stroke={INFLATION} dot={false} strokeWidth={2} strokeDasharray="6 4" isAnimationActive={false} />
            {runs.map((_, i) => (
              <Line key={i} type="monotone" dataKey={`p${i}`} stroke={color(i)} dot={false} strokeWidth={2.5} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      <ChartBox title="Drawdown" note="How far each plan was below its highest earlier value (0% = at a new high).">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={rows} syncId="plans" margin={{ left: 8, right: 8 }}>
            {grid}{xAxis}
            <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={70} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => fmtDate(String(d))}
              itemSorter={(it) => Number(it.value ?? 0)} formatter={(v, n) => [`${Number(v).toFixed(2)}%`, planName(String(n))]} />
            {runs.map((_, i) => (
              <Line key={i} type="monotone" dataKey={`dd${i}`} stroke={color(i)} dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="bg-bg text-left text-xs uppercase tracking-wide text-fg-muted">
              <th className={th}>Plan</th>
              {["Final value", "Total return", "CAGR", "Max drawdown", "Volatility", ...(showRebalances ? ["Rebalances"] : [])]
                .map((h) => <th key={h} className={`${th} text-right`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {[...runs].sort((a, b) => b.result.cagr_pct - a.result.cagr_pct).map((r) => {
              const x = r.result;
              return (
                <tr key={r.allocation.id} className="border-t border-border">
                  <td className={`${td} text-fg`}>
                    <span className="mr-2 inline-block h-3 w-5 rounded-[2px] align-middle" style={{ background: colorOf(r.allocation.id ?? "") }} />
                    {r.allocation.name}
                    {x.cagr_pct === best && runs.length > 1 && (
                      <span className="ml-2 rounded bg-bonds/15 px-1.5 py-0.5 text-xs font-medium text-bonds">best CAGR</span>
                    )}
                  </td>
                  <td className={`${td} text-right font-semibold`}>{inr(x.final_value)}</td>
                  <td className={`${td} text-right ${x.total_return_pct >= 0 ? "text-bonds" : "text-danger"}`}>{pct(x.total_return_pct)}</td>
                  <td className={`${td} text-right`}>{pct(x.cagr_pct)}</td>
                  <td className={`${td} text-right text-danger`}>{x.max_drawdown_pct.toFixed(2)}%</td>
                  <td className={`${td} text-right`}>{x.volatility_pct.toFixed(2)}%</td>
                  {showRebalances && <td className={`${td} text-right`}>{x.rebalance_count}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
