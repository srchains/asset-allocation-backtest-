import { useEffect, useMemo, useState } from "react";
import {
  ApiError, assetRanges, listAllocations, runPortfolioBacktest,
  type Allocation, type AssetConfig, type BacktestResponse, type Rebalance,
} from "./api";
import { Card, ErrorBox } from "./ui";
import { AssetTable, ComparisonTable, DataNotes, RebalanceLog, SummaryCards, ValueAndDrawdown, YearTable } from "./Results";
import ManageAllocations from "./ManageAllocations";
import { weightsText } from "./format";

type Tab = "buyhold" | "rebalancing";
const FREQ_LABEL: Record<Exclude<Rebalance, "none">, string> = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const input = "mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-base text-fg";

export default function BacktesterPage({ initialAllocId }: { initialAllocId?: string } = {}) {
  const [assets, setAssets] = useState<Record<string, AssetConfig>>({});
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [ranges, setRanges] = useState<Record<string, { first: string; last: string } | null>>({});
  const [loadErr, setLoadErr] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("buyhold");
  const [allocId, setAllocId] = useState(initialAllocId ?? "balanced_4_asset");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [amount, setAmount] = useState(100000);
  const [freq, setFreq] = useState<Exclude<Rebalance, "none">>("yearly");
  const [results, setResults] = useState<Partial<Record<Tab, BacktestResponse>>>({});
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string[]>([]);
  const [manage, setManage] = useState(false);

  const reload = async (selectId?: string) => {
    const d = await listAllocations();
    setAssets(d.assets);
    setAllocations(d.allocations);
    if (selectId) setAllocId(selectId);
    else if (!d.allocations.some((a) => a.id === allocId)) setAllocId(d.allocations[0]?.id ?? "");
  };

  useEffect(() => {
    Promise.all([reload(), assetRanges().then(setRanges)])
      .catch((e) => setLoadErr(e instanceof ApiError ? e.errors : [String(e)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const alloc = allocations.find((a) => a.id === allocId);

  // dates every priced asset of this allocation has data for
  const common = useMemo(() => {
    if (!alloc) return null;
    const priced = Object.keys(alloc.weights).map((a) => ranges[a]).filter(Boolean) as { first: string; last: string }[];
    const list = priced.length ? priced : ranges.NIFTY ? [ranges.NIFTY] : [];
    if (!list.length) return null;
    const firsts = list.map((r) => r.first).sort();
    return { first: firsts[firsts.length - 1], last: list.map((r) => r.last).sort()[0] };
  }, [alloc, ranges]);

  useEffect(() => {
    if (!common) return;
    if (!start || start < common.first) setStart(common.first);
    if (!end || end > common.last) setEnd(common.last);
    // only when the allocation's data range changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [common?.first, common?.last]);

  const run = async () => {
    if (!alloc) return;
    setRunErr([]);
    if (!start || !end) { setRunErr(["Pick a start and an end date."]); return; }
    if (start > end) { setRunErr(["Start date must be before the end date."]); return; }
    if (!(amount > 0)) { setRunErr(["Initial amount must be more than 0."]); return; }
    setRunning(true);
    try {
      const r = await runPortfolioBacktest({
        allocation_id: alloc.id, start_date: start, end_date: end, initial_amount: amount,
        rebalance: tab === "buyhold" ? "none" : freq, compare: tab === "rebalancing",
      });
      setResults((prev) => ({ ...prev, [tab]: r }));
    } catch (e) {
      setRunErr(e instanceof ApiError ? e.errors : [String(e)]);
    } finally {
      setRunning(false);
    }
  };

  const res = results[tab];
  const groups: [string, Allocation[]][] = [
    ["Predefined", allocations.filter((a) => a.type === "predefined")],
    ["Custom", allocations.filter((a) => a.type === "custom")],
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-panel p-1">
          {([["buyhold", "Buy & Hold"], ["rebalancing", "Rebalancing"]] as [Tab, string][]).map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setTab(k); setRunErr([]); }}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === k ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg"}`}>
              {l}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setManage(true)}
          className="rounded-lg border border-border bg-panel px-3.5 py-1.5 text-sm text-fg-muted hover:text-fg">
          Manage allocations
        </button>
      </div>

      <ErrorBox errors={loadErr} />

      <section className="mb-5 rounded-xl border border-border bg-panel p-4">
        <div className={`grid gap-3 ${tab === "rebalancing" ? "md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]" : "md:grid-cols-[2fr_1fr_1fr_1fr_auto]"}`}>
          <label className="block text-sm text-fg-muted">
            Allocation
            <select value={allocId} onChange={(e) => setAllocId(e.target.value)} className={input}>
              {groups.map(([g, list]) => list.length > 0 && (
                <optgroup key={g} label={g}>
                  {list.map((a) => <option key={a.id} value={a.id}>{a.name} — {weightsText(assets, a.weights)}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="block text-sm text-fg-muted">
            Start date
            <input type="date" value={start} min={common?.first} max={common?.last} onChange={(e) => setStart(e.target.value)} className={input} />
          </label>
          <label className="block text-sm text-fg-muted">
            End date
            <input type="date" value={end} min={common?.first} max={common?.last} onChange={(e) => setEnd(e.target.value)} className={input} />
          </label>
          <label className="block text-sm text-fg-muted">
            Initial amount (₹)
            <input type="number" min={1} step={1000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className={input} />
          </label>
          {tab === "rebalancing" && (
            <label className="block text-sm text-fg-muted">
              Rebalance
              <select value={freq} onChange={(e) => setFreq(e.target.value as Exclude<Rebalance, "none">)} className={input}>
                {Object.entries(FREQ_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
          <div className="flex items-end">
            <button type="button" onClick={run} disabled={running || !alloc}
              className="w-full rounded-lg border border-accent bg-accent/15 px-5 py-2 text-base font-semibold text-accent hover:bg-accent/25 disabled:opacity-50">
              {running ? "Running…" : "Run"}
            </button>
          </div>
        </div>
        {common && (
          <p className="mt-2 text-sm text-fg-muted">
            Data for this allocation: {common.first} to {common.last}.{" "}
            {tab === "buyhold"
              ? "Bought once on the first day and held (no rebalancing)."
              : `Reset to the target weights on the first trading day of every ${freq === "monthly" ? "month" : freq === "quarterly" ? "quarter (Jan, Apr, Jul, Oct)" : "year"}.`}
          </p>
        )}
      </section>

      <ErrorBox errors={runErr} />
      {!res && !running && <p className="py-8 text-center text-fg-muted">Pick an allocation and dates, then press Run.</p>}

      {res && (
        <div className={running ? "opacity-50" : ""}>
          <p className="mb-3 text-sm text-fg-muted">
            <span className="font-semibold text-fg">{res.allocation.name}</span> — {weightsText(assets, res.allocation.weights)} ·
            {" "}{res.result.start_date} to {res.result.end_date} · {res.result.trading_days.toLocaleString("en-IN")} trading days
          </p>
          <DataNotes run={res.result} />
          <SummaryCards run={res.result} showRebalances={tab === "rebalancing"} />

          {tab === "rebalancing" && res.buy_and_hold && (
            <Card title="Rebalancing vs buy & hold" note="Same allocation, same dates: one run reset to the target weights, the other bought once and held.">
              <ComparisonTable rb={res.result} bh={res.buy_and_hold} rbLabel={`${FREQ_LABEL[res.result.rebalance as Exclude<Rebalance, "none">]} rebalance`} />
            </Card>
          )}

          <Card title="Portfolio value and drawdown" note={tab === "buyhold"
            ? "Your portfolio against the same amount put 100% into each asset on the first day and held."
            : "The rebalanced portfolio against buy & hold (dashed) and the same amount put 100% into each asset."}>
            <ValueAndDrawdown run={res.result} bh={tab === "rebalancing" ? res.buy_and_hold : undefined} assets={assets} />
          </Card>
          <Card title="Calendar-year returns">
            <YearTable run={res.result} other={res.buy_and_hold} otherLabel="Buy & hold" />
          </Card>
          <Card title="Asset-wise contribution" note="Gain = what each asset added in rupees over the whole period (it adds up to the total gain).">
            <AssetTable run={res.result} assets={assets} />
          </Card>
          {tab === "rebalancing" && (
            <Card title="Rebalance log" note="Weight before → after for each asset on every rebalance date, with the amount and the Nifty shares / gold grams bought or sold.">
              <RebalanceLog run={res.result} assets={assets} />
            </Card>
          )}
        </div>
      )}

      {manage && (
        <ManageAllocations assets={assets} allocations={allocations} onClose={() => setManage(false)}
          onChanged={async (id) => { await reload(id); }} />
      )}
    </div>
  );
}
