import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, assetRanges, listAllocations, runPortfolioBacktest,
  type Allocation, type AssetConfig, type BacktestResponse,
} from "./api";
import { Card, ErrorBox } from "./ui";
import { ComparisonTable, RebalanceLog } from "./Results";
import ManageAllocations from "./ManageAllocations";
import { usePersisted, isOneOf } from "../persist";
import PlanPicker from "./PlanPicker";
import PlanComparison from "./PlanComparison";

type Tab = "buyhold" | "rebalancing";
// Rebalance choices shown in the page (the API also accepts "monthly").
type Freq = "quarterly" | "halfyearly" | "yearly";
const FREQ_LABEL: Record<Freq, string> = { quarterly: "Quarterly", halfyearly: "Half-yearly", yearly: "Yearly" };
const FREQ_PERIOD: Record<Freq, string> = { quarterly: "quarter (Jan, Apr, Jul, Oct)", halfyearly: "half year (Jan, Jul)", yearly: "year" };
const isDate = (v: unknown) => typeof v === "string" && (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v));
const input = "mt-1 block w-full rounded-lg border border-border bg-bg px-3 py-2 text-base text-fg";
// One fixed colour per plan (by its place in the list), so a plan keeps its colour when others are ticked.
const PLAN_COLORS = ["#f472b6", "#22d3ee", "#facc15", "#34d399", "#60a5fa", "#fb923c", "#e879f9", "#a3e635",
  "#f87171", "#2dd4bf", "#fbbf24", "#818cf8", "#4ade80", "#fda4af", "#38bdf8"];

// Stays mounted while another tab is shown (to keep its results): memo stops it from
// re-drawing its charts on every slider move in the Asset Allocation tab.
export default memo(BacktesterPage);

function BacktesterPage({ active = true }: { active?: boolean } = {}) {
  const [assets, setAssets] = useState<Record<string, AssetConfig>>({});
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [ranges, setRanges] = useState<Record<string, { first: string; last: string } | null>>({});
  const [loadErr, setLoadErr] = useState<string[]>([]);
  const [tab, setTab] = usePersisted<Tab>("bt.tab", "buyhold", isOneOf("buyhold", "rebalancing"));
  const [savedSel, setSavedSel] = usePersisted<string[]>("bt.plans", ["balanced_4_asset"],
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"));
  const [selected, setSelected] = useState<string[]>(savedSel);
  useEffect(() => { setSavedSel(selected); }, [selected, setSavedSel]);
  const [detailId, setDetailId] = useState("");
  const [start, setStart] = usePersisted("bt.start", "", isDate);
  const [end, setEnd] = usePersisted("bt.end", "", isDate);
  const [amount, setAmount] = usePersisted("bt.amount", 100000, (v) => typeof v === "number" && v > 0 && v < 1e13);
  const [freq, setFreq] = usePersisted<Freq>("bt.freq", "yearly", isOneOf("quarterly", "halfyearly", "yearly"));
  const [results, setResults] = useState<Partial<Record<Tab, BacktestResponse[]>>>({});
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string[]>([]);
  const [manage, setManage] = useState(false);

  const reload = async (selectId?: string) => {
    const d = await listAllocations();
    setAssets(d.assets);
    setAllocations(d.allocations);
    const ids = d.allocations.map((a) => a.id);
    setSelected((cur) => {
      const keep = ids.filter((id) => id === selectId || cur.includes(id));
      return keep.length ? keep : ids.slice(0, 1);
    });
  };

  useEffect(() => {
    Promise.all([reload(), assetRanges().then(setRanges)])
      .catch((e) => setLoadErr(e instanceof ApiError ? e.errors : [String(e)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The page stays mounted while hidden: pick up plans saved elsewhere when it is shown again.
  useEffect(() => {
    if (active) reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const chosen = allocations.filter((a) => selected.includes(a.id));
  const colorOf = (id: string) => {
    const i = allocations.findIndex((a) => a.id === id);
    return PLAN_COLORS[(i < 0 ? 0 : i) % PLAN_COLORS.length];
  };

  // dates every priced asset of the ticked plans has data for
  const common = useMemo(() => {
    if (!chosen.length) return null;
    const used = new Set(chosen.flatMap((a) => Object.keys(a.weights)));
    const priced = [...used].map((a) => ranges[a]).filter(Boolean) as { first: string; last: string }[];
    const list = priced.length ? priced : ranges.NIFTY ? [ranges.NIFTY] : [];
    if (!list.length) return null;
    const firsts = list.map((r) => r.first).sort();
    return { first: firsts[firsts.length - 1], last: list.map((r) => r.last).sort()[0] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.join(","), allocations, ranges]);

  useEffect(() => {
    if (!common) return;
    if (!start || start < common.first) setStart(common.first);
    if (!end || end > common.last) setEnd(common.last);
    // only when the allocation's data range changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [common?.first, common?.last]);

  // Everything the result depends on; when it changes (and the page is shown) the backtest runs by itself.
  const inputKey = `${tab}|${selected.join(",")}|${start}|${end}|${amount}|${freq}`;
  const ranKey = useRef("");        // inputs of the last successful run: no need to run those again
  const runId = useRef(0);          // only the newest run may show its result

  const run = async () => {
    const id = ++runId.current, key = inputKey;
    if (!chosen.length) { setRunErr(["Tick at least one plan."]); return; }
    setRunErr([]);
    if (!start || !end) { setRunErr(["Pick a start and an end date."]); return; }
    if (start > end) { setRunErr(["Start date must be before the end date."]); return; }
    if (!(amount > 0)) { setRunErr(["Initial amount must be more than 0."]); return; }
    setRunning(true);
    try {
      const runs = await Promise.all(chosen.map((a) => runPortfolioBacktest({
        allocation_id: a.id, start_date: start, end_date: end, initial_amount: amount,
        rebalance: tab === "buyhold" ? "none" : freq, compare: tab === "rebalancing",
      })));
      if (id !== runId.current) return;
      ranKey.current = key;
      setResults((prev) => ({ ...prev, [tab]: runs }));
      if (!runs.some((r) => r.allocation.id === detailId)) setDetailId(runs[0]?.allocation.id ?? "");
    } catch (e) {
      if (id === runId.current) setRunErr(e instanceof ApiError ? e.errors : [String(e)]);
    } finally {
      if (id === runId.current) setRunning(false);
    }
  };

  // Auto run: shortly after a plan is ticked / unticked or a date, amount, tab or frequency changes.
  useEffect(() => {
    if (!active || !allocations.length || !common) return;                      // wait until the plans and data ranges are loaded
    if (ranKey.current === inputKey && results[tab]) return;                    // same inputs as the result on screen
    const t = setTimeout(run, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, inputKey, allocations.length, !!common]);

  const runs = results[tab] ?? [];
  const res = runs.find((r) => r.allocation.id === detailId) ?? runs[0];

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
          <div className="block text-sm text-fg-muted">
            Allocation <span className="text-xs">(tick more than one to compare)</span>
            <PlanPicker assets={assets} allocations={allocations} selected={selected} colorOf={colorOf} onChange={setSelected} />
          </div>
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
              <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} className={input}>
                {Object.entries(FREQ_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
          <div className="flex items-end">
            <button type="button" onClick={() => { ranKey.current = ""; run(); }} disabled={running || !chosen.length}
              className="w-full rounded-lg border border-accent bg-accent/15 px-5 py-2 text-base font-semibold text-accent hover:bg-accent/25 disabled:opacity-50">
              {running ? "Running…" : chosen.length > 1 ? `Compare ${chosen.length}` : "Run"}
            </button>
          </div>
        </div>
        {common && (
          <p className="mt-2 text-sm text-fg-muted">
            Data for {chosen.length > 1 ? "all ticked plans" : "this allocation"}: {common.first} to {common.last}.{" "}
            {tab === "buyhold"
              ? "Bought once on the first day and held (no rebalancing)."
              : `Reset to the target weights on the first trading day of every ${FREQ_PERIOD[freq]}.`}
          </p>
        )}
      </section>

      <ErrorBox errors={runErr} />
      {!res && !running && <p className="py-8 text-center text-fg-muted">Tick one or more plans: the result appears by itself.</p>}

      {runs.length > 0 && (
        <div className={running ? "opacity-50" : ""}>
          <Card title={runs.length > 1 ? `Comparing ${runs.length} plans` : "Value and drawdown"} note={`${tab === "buyhold" ? "Each plan bought once and held" : `Each plan reset to its weights ${FREQ_LABEL[freq].toLowerCase()}`}, same dates and the same starting amount.`}>
            <PlanComparison runs={runs} colorOf={colorOf} showRebalances={tab === "rebalancing"} />
          </Card>
          {runs.length > 1 && tab === "rebalancing" && <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-muted">Details for:</span>
            {runs.map((r) => {
              const on = r.allocation.id === res?.allocation.id;
              return (
                <button key={r.allocation.id} type="button" onClick={() => setDetailId(r.allocation.id ?? "")}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${on ? "border-accent bg-accent/15 text-fg" : "border-border text-fg-muted hover:text-fg"}`}>
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(r.allocation.id ?? "") }} />
                  {r.allocation.name}
                </button>
              );
            })}
          </div>}
        </div>
      )}

      {res && tab === "rebalancing" && (
        <div className={running ? "opacity-50" : ""}>
          {tab === "rebalancing" && res.buy_and_hold && (
            <Card title="Rebalancing vs buy & hold" note="Same allocation, same dates: one run reset to the target weights, the other bought once and held.">
              <ComparisonTable rb={res.result} bh={res.buy_and_hold} rbLabel={`${FREQ_LABEL[res.result.rebalance as Freq] ?? res.result.rebalance} rebalance`} />
            </Card>
          )}

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
