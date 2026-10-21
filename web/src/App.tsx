import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import KeyBox from "./KeyBox";
import { usePersisted, isIntIn, isIntOrNull, isOneOf, isBool } from "./persist";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import {
  exportTablesExcel, exportTablesPdf,
  type Table,
} from "./exportYearly";
import { fetchRange, fetchBacktest, type BacktestResult, type DataRange } from "./api";
import BacktesterPage from "./backtester/BacktesterPage";
import SavePlan from "./backtester/SavePlan";
import OpenPlan from "./backtester/OpenPlan";
import LogToggle from "./LogToggle";
import { logAxis } from "./logScale";

// Midcap and Smallcap are hidden everywhere in the UI. Flip to true to show them again
// (the backend and data still support both).
const SHOW_MIDSMALL = false;

function ymToParts(ym: string): [number, number] {
  const [y, m] = ym.split("-").map(Number);
  return [y, m];
}

type PageKey = "main" | "rebalance" | "backtester";

const tabIcon = (paths: string[]) => (
  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => <path key={d} d={d} />)}
  </svg>
);

const PAGE_TABS: { key: PageKey; label: string; icon: React.ReactNode }[] = [
  { key: "main", label: "Asset Allocation", icon: tabIcon(["M12 3v9h9", "M21 12a9 9 0 1 1-9-9"]) },
  { key: "rebalance", label: "Rebalance", icon: tabIcon(["M12 4v16", "M5 8h14", "M5 8l-3 7h6z", "M19 8l-3 7h6z", "M8 20h8"]) },
  { key: "backtester", label: "Comparison chart", icon: tabIcon(["M3 3v18h18", "M7 15l4-6 3 4 5-8"]) },
];

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m > 1 ? `${y}-${String(m - 1).padStart(2, "0")}` : `${y - 1}-12`;
}

function money2(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatINR(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function formatLakh(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${+(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${+(n / 1e5).toFixed(1)}L`;
  return `₹${formatINR(n)}`;
}

const headerSelect =
  "rounded-md border border-border bg-bg px-2 py-1 text-xl text-fg focus:outline-none focus:ring-1 focus:ring-accent";

export default function App() {
  const [range, setRange] = useState<DataRange | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [capitalText, setCapitalText] = usePersisted("capital", "200000", (v) => typeof v === "string" && /^\d{0,13}$/.test(v));
  const capital = Number(capitalText) || 0;
  const [startYear, setStartYear] = usePersisted<number | null>("startYear", null, isIntOrNull(1900, 2200));
  const [startMonth, setStartMonth] = usePersisted<number | null>("startMonth", null, isIntOrNull(1, 12));
  const [endYear, setEndYear] = usePersisted<number | null>("endYear", null, isIntOrNull(1900, 2200));
  const [endMonth, setEndMonth] = usePersisted<number | null>("endMonth", null, isIntOrNull(1, 12));

  const [equity, setEquity] = usePersisted("equity", SHOW_MIDSMALL ? 30 : 50, isIntIn(0, 100));
  const [gold, setGold] = usePersisted("gold", 30, isIntIn(0, 100));
  const [bonds, setBonds] = usePersisted("bonds", 15, isIntIn(0, 100));
  const [midcap, setMidcap] = usePersisted("midcap", SHOW_MIDSMALL ? 10 : 0, isIntIn(0, 100));
  const [smallcap, setSmallcap] = usePersisted("smallcap", SHOW_MIDSMALL ? 10 : 0, isIntIn(0, 100));
  const [page, setPage] = usePersisted<PageKey>("page", "main", isOneOf(...PAGE_TABS.map((t) => t.key)));
  const [sidebarW, setSidebarW] = usePersisted("sidebarWidth", SIDEBAR_DEFAULT, isIntIn(SIDEBAR_MIN, SIDEBAR_MAX));
  // Header spots the Asset Allocation page fills (portfolio value cards, allocation pie).
  const [metricsSlot, setMetricsSlot] = useState<HTMLDivElement | null>(null);
  const [cagrSlot, setCagrSlot] = useState<HTMLDivElement | null>(null);
  const [pieSlot, setPieSlot] = useState<HTMLDivElement | null>(null);
  const frequency: "yearly" | "monthly" = "monthly"; // the December-only view was removed from the UI (the API still supports it)
  const cash = 100 - equity - gold - bonds - midcap - smallcap;

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendDown, setBackendDown] = useState(false);

  useEffect(() => {
    fetchRange()
      .then((r) => {
        setRange(r);
        const [minY, minM] = ymToParts(r.min);
        const [maxY, maxM] = ymToParts(r.max);
        // Keep the remembered period if it still fits the data; otherwise use the full range.
        const ym = (y: number | null, m: number | null) => (y && m ? `${y}-${String(m).padStart(2, "0")}` : "");
        const s = ym(startYear, startMonth), e = ym(endYear, endMonth);
        if (!s || s < r.min || s > r.max) { setStartYear(minY); setStartMonth(minM); }
        if (!e || e < r.min || e > r.max) { setEndYear(maxY); setEndMonth(maxM); }
      })
      .catch((e) => setRangeError(e.message));
    // only on start: the remembered period is checked against the data once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEquity = (v: number) => {
    setEquity(v);
    const rest = 100 - v;
    if (gold + bonds + midcap + smallcap > rest) {
      const scale = rest / (gold + bonds + midcap + smallcap || 1);
      const newGold = Math.round(gold * scale);
      const newBonds = Math.round(bonds * scale);
      const newMidcap = Math.round(midcap * scale);
      setGold(newGold);
      setBonds(newBonds);
      setMidcap(newMidcap);
      setSmallcap(rest - newGold - newBonds - newMidcap);
    }
  };
  // Typing Cash: the other assets share the rest in the same proportions as now.
  const handleCash = (c: number) => {
    const rest = 100 - c;
    const now = [equity, gold, bonds, midcap, smallcap];
    const total = now.reduce((t, x) => t + x, 0);
    const next = total > 0 ? now.map((x) => Math.floor((x * rest) / total)) : [rest, 0, 0, 0, 0];
    // hand the rounding leftovers to the largest holdings so the total is exactly 100
    let left = rest - next.reduce((t, x) => t + x, 0);
    for (const i of [...now.keys()].sort((a, b) => now[b] - now[a])) { if (left <= 0) break; if (now[i] > 0 || total === 0) { next[i]++; left--; } }
    setEquity(next[0]); setGold(next[1]); setBonds(next[2]); setMidcap(next[3]); setSmallcap(next[4]);
  };
  const handleGold = (v: number) => {
    const maxAllowed = 100 - equity;
    const clamped = Math.min(v, maxAllowed);
    setGold(clamped);
    const remaining = maxAllowed - clamped;
    if (bonds + midcap + smallcap > remaining) {
      const scale = remaining / (bonds + midcap + smallcap || 1);
      const newBonds = Math.round(bonds * scale);
      const newMidcap = Math.round(midcap * scale);
      setBonds(newBonds);
      setMidcap(newMidcap);
      setSmallcap(remaining - newBonds - newMidcap);
    }
  };
  const handleBonds = (v: number) => {
    const maxAllowed = 100 - equity - gold;
    const clamped = Math.min(v, maxAllowed);
    setBonds(clamped);
    const remaining = maxAllowed - clamped;
    if (midcap + smallcap > remaining) {
      const scale = remaining / (midcap + smallcap || 1);
      const newMidcap = Math.round(midcap * scale);
      setMidcap(newMidcap);
      setSmallcap(remaining - newMidcap);
    }
  };
  const handleMidcap = (v: number) => {
    const maxAllowed = 100 - equity - gold - bonds;
    const clamped = Math.min(v, maxAllowed);
    setMidcap(clamped);
    if (clamped + smallcap > maxAllowed) {
      setSmallcap(maxAllowed - clamped);
    }
  };
  const handleSmallcap = (v: number) => {
    const maxAllowed = 100 - equity - gold - bonds - midcap;
    setSmallcap(Math.min(v, maxAllowed));
  };

  const startYM = startYear && startMonth ? `${startYear}-${frequency === "monthly" ? String(startMonth).padStart(2, "0") : "01"}` : null;
  const endYM = endYear && endMonth ? `${endYear}-${frequency === "monthly" ? String(endMonth).padStart(2, "0") : "12"}` : null;

  useEffect(() => {
    if (!startYM || !endYM) return;
    if (!(capital > 0)) {
      setResult(null);
      setError("Enter a capital amount greater than 0.");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      fetchBacktest(
        { capital, equity, gold, bonds, midcap, smallcap, start: startYM, end: endYM, rebalance: false, tolerance: 5, frequency },
        controller.signal
      )
        .then((r) => {
          setResult(r);
          setBackendDown(false);
        })
        .catch((e) => {
          if (e.name === "AbortError") return;
          setResult(null);
          setError(e.message);
          if (e instanceof TypeError) setBackendDown(true);
        })
        .finally(() => setLoading(false));
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [capital, equity, gold, bonds, midcap, smallcap, startYM, endYM, frequency]);

  const years = range ? Array.from(
    { length: ymToParts(range.max)[0] - ymToParts(range.min)[0] + 1 },
    (_, i) => ymToParts(range.min)[0] + i
  ) : [];

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="w-full px-4 pb-10 pt-5 lg:px-6">
        <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3 lg:justify-between lg:self-stretch">
          <div className="flex flex-col gap-3">
          <div>
            <h1 className="flex items-center gap-3 text-4xl font-bold text-fg">
            <svg className="h-9 w-9 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 15l4-6 3 4 5-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Asset Allocation
          </h1>
          <p className="mt-1.5 text-lg text-fg-muted">
            Portfolio &mdash; vs Inflation
          </p>
          </div>
          <nav role="tablist" aria-label="Pages" className="flex flex-wrap gap-1.5 border-b border-border">
            {PAGE_TABS.map((t) => {
              const on = page === t.key;
              return (
                <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setPage(t.key)}
                  className={`-mb-px flex cursor-pointer items-center gap-2.5 rounded-t-lg border px-5 py-3 text-lg font-medium transition-colors ${
                    on
                      ? "border-border border-t-2 border-t-accent border-b-bg bg-bg text-fg"
                      : "border-transparent text-fg-muted hover:bg-panel hover:text-fg"
                  }`}>
                  <span className={on ? "text-accent" : ""}>{t.icon}</span>
                  {t.label}
                </button>
              );
            })}
          </nav>
          </div>
          {range && (page === "main" || page === "rebalance") && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-panel px-5 py-4 text-xl text-fg-muted">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex items-center gap-1.5">
                  Capital ₹
                  <input type="number" value={capitalText} min={1} step={1000} aria-label="Capital in rupees"
                    onChange={(e) => setCapitalText(e.target.value)}
                    className="w-40 rounded-md border border-border bg-bg px-2 py-1 text-xl text-fg focus:outline-none focus:ring-1 focus:ring-accent" />
                </label>
                <span className="flex items-center gap-1.5">
                  Start
                  <select className={headerSelect} value={startMonth ?? ""} aria-label="Start month" onChange={(e) => setStartMonth(Number(e.target.value))}>
                    {MONTHS.map((m) => <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>)}
                  </select>
                  <select className={headerSelect} value={startYear ?? ""} aria-label="Start year" onChange={(e) => setStartYear(Number(e.target.value))}>
                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </span>
                <span className="flex items-center gap-1.5">
                  End
                  <select className={headerSelect} value={endMonth ?? ""} aria-label="End month" onChange={(e) => setEndMonth(Number(e.target.value))}>
                    {MONTHS.map((m) => <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>)}
                  </select>
                  <select className={headerSelect} value={endYear ?? ""} aria-label="End year" onChange={(e) => setEndYear(Number(e.target.value))}>
                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </span>
                </div>
                {/* the Asset Allocation page puts its portfolio values here */}
                <div ref={setMetricsSlot} className="contents" />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                <p className="text-lg text-fg-muted">
                  Bought once at the <strong className="text-fg">{startYM ? prevMonth(startYM) : ""}</strong> month-end price and held till the end; Start = the first month of returns.
                </p>
                {/* the Asset Allocation page puts its CAGR line here */}
                <div ref={setCagrSlot} className="contents" />
              </div>
            </div>
          )}
          </div>
          <div ref={setPieSlot} className="self-center" />
        </header>

        {rangeError && (
          <ErrorNotice>
            Could not reach the backend API at <code className="rounded bg-danger/20 px-1.5 py-0.5">/api/range</code>: {rangeError}.
            Make sure the FastAPI server is running (<code className="rounded bg-danger/20 px-1.5 py-0.5">uvicorn server:app --port 8000</code>).
          </ErrorNotice>
        )}

        {!range && !rangeError && <p className="py-10 text-center text-fg-muted">Loading data range from backend&hellip;</p>}

        <div hidden={page !== "backtester"}>
          <BacktesterPage active={page === "backtester"} />
        </div>

        {range && startYM && endYM && page === "rebalance" && (
          <RebalancePage capital={capital} weights={{ equity, gold, bonds, midcap, smallcap, cash }}
            start={startYM} end={endYM} frequency={frequency} metricsSlot={metricsSlot} pieSlot={pieSlot}
            dataThrough={range.data_through} lastClose={range.last_close} latestPrices={range.latest} />
        )}

        {range && startYear && startMonth && endYear && endMonth && (
          <div hidden={page !== "main"} className="grid grid-cols-1 gap-5 md:grid-cols-[var(--sb)_minmax(0,1fr)]" style={{ "--sb": `${sidebarW}px` } as CSSProperties}>
            <div className="relative h-fit md:sticky md:top-4">
            <div className="mb-3">
              <OpenPlan current={{ equity, gold, bonds }}
                onOpen={(w) => { setEquity(w.equity); setGold(w.gold); setBonds(w.bonds); setMidcap(0); setSmallcap(0); }} />
            </div>
            <aside className="rounded-xl border border-border bg-panel p-4 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto md:overflow-x-hidden">
              <section>
                <h2 className="mb-3.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">Allocation</h2>

                <SliderField label="Equity (Nifty)" colorClass="bg-equity" value={equity} capital={capital} max={100} onChange={handleEquity} />
                <SliderField label="Gold" colorClass="bg-gold" value={gold} capital={capital} max={100 - equity} onChange={handleGold} />
                <SliderField label="Bonds" colorClass="bg-bonds" value={bonds} capital={capital} max={100 - equity - gold} onChange={handleBonds} />
                {SHOW_MIDSMALL && (
                  <>
                <SliderField label="Midcap" colorClass="bg-midcap" value={midcap} capital={capital} max={100 - equity - gold - bonds} onChange={handleMidcap} />
                <SliderField label="Smallcap" colorClass="bg-smallcap" value={smallcap} capital={capital} max={100 - equity - gold - bonds - midcap} onChange={handleSmallcap} />
                  </>
                )}

                <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-bg px-3 py-2.5 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-cash" />
                  <span>Cash (auto)</span>
                  <span className="ml-auto tabular-nums text-fg-muted">₹{formatINR((capital * cash) / 100)}</span>
                  <PercentInput value={cash} max={100} onChange={handleCash} label="Cash" />
                </div>

                <SavePlan weights={{ NIFTY: equity, GOLD: gold, BOND: bonds, CASH: cash }} />

              </section>
            </aside>
            <SidebarResizer width={sidebarW} onChange={setSidebarW} />
            </div>

            <main className="min-w-0">
              {backendDown && (
                <ErrorNotice>
                  Lost connection to the backend API. Make sure{" "}
                  <code className="rounded bg-danger/20 px-1.5 py-0.5">uvicorn server:app --port 8000</code> is still running.
                </ErrorNotice>
              )}
              {error && !backendDown && <ErrorNotice>{error}</ErrorNotice>}
              {!result && !error && <p className="py-10 text-center text-fg-muted">Loading backtest&hellip;</p>}
              {result && (
                <div className={loading ? "opacity-55 transition-opacity" : "transition-opacity"}>
                  <ResultsView result={result} capital={capital} weights={{ equity, gold, bonds, midcap, smallcap, cash }}
                    metricsSlot={page === "main" ? metricsSlot : null} pieSlot={page === "main" ? pieSlot : null}
                    cagrSlot={page === "main" ? cagrSlot : null} />
                </div>
              )}
            </main>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4.5 rounded-lg border border-danger bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      {children}
    </div>
  );
}

function PercentInput({ value, max, onChange, label }: {
  value: number; max: number; onChange: (v: number) => void; label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Math.round(Number(draft));
    if (draft.trim() !== "" && Number.isFinite(n)) onChange(Math.max(0, Math.min(max, n)));
    setDraft(null);
  };
  return (
    <span className="flex items-center rounded-md border border-border bg-bg focus-within:ring-1 focus-within:ring-accent">
      <input type="text" inputMode="numeric" aria-label={`${label} percent`}
        value={draft ?? String(value)}
        onFocus={(e) => { setDraft(String(value)); e.currentTarget.select(); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); }
        }}
        className="w-9 bg-transparent py-0.5 pl-1.5 text-right font-semibold tabular-nums text-fg outline-none" />
      <span className="pr-1.5 font-semibold text-fg">%</span>
    </span>
  );
}

function SliderField({
  label, colorClass, value, capital, max, onChange,
}: {
  label: string;
  colorClass: string;
  value: number;
  capital: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-4.5">
      <div className="mb-1.5 flex items-center gap-2 text-sm text-fg">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorClass}`} />
        <span>{label}</span>
        <span className="ml-auto tabular-nums text-fg-muted">₹{formatINR((capital * value) / 100)}</span>
        <PercentInput value={value} max={max} onChange={onChange} label={label} />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Math.min(Number(e.target.value), max))}
        className="w-full"
      />
    </div>
  );
}

interface Weights {
  equity: number;
  gold: number;
  bonds: number;
  midcap: number;
  smallcap: number;
  cash: number;
}

function ResultsView({ result, capital, weights, metricsSlot, pieSlot, cagrSlot }: {
  result: BacktestResult; capital: number; weights: Weights;
  metricsSlot: HTMLElement | null; pieSlot: HTMLElement | null; cagrSlot: HTMLElement | null;
}) {
  const { rows, clampedStart, clampedEnd, marketData, goldBuyPerGram, niftyBuyClose, midcapBuyClose, smallcapBuyClose, periodsPerYear } = result;
  const stepMonths = 12 / periodsPerYear; // months per row: 12 for the December-only data
  const buyMonth = result.buyPeriod || prevMonth(clampedStart);
  const buyLabel = `${buyMonth.slice(0, 4)} ${MONTH_NAMES[Number(buyMonth.slice(5, 7)) - 1]}`; // "1995 Dec"
  const niftyUnitsBought = (capital * weights.equity) / 100 / niftyBuyClose;
  const goldGramsBought = (capital * weights.gold) / 100 / goldBuyPerGram;
  const midcapUnitsBought = (capital * weights.midcap) / 100 / midcapBuyClose;
  const smallcapUnitsBought = (capital * weights.smallcap) / 100 / smallcapBuyClose;
  const final = rows[rows.length - 1];
  // CAGR in % per year: the money grown from `capital` over the months between buy and the last row
  const yearsHeld = rows.length / periodsPerYear;
  const cagrOf = (value: number) => (value > 0 && capital > 0 && yearsHeld > 0 ? ((value / capital) ** (1 / yearsHeld) - 1) * 100 : -100);
  // Buy & hold: each part is what you bought at the start, still held each month.
  // "100%" lines: the full capital put into that one asset at the start and held.
  // Bonds has no single price to ratio against (it's a year-end bonds index
  // rate), so its 100% line is compounded year by year from the Bonds return.
  let bondsFactor = 1;
  const priceSeries = rows.map((r, i) => ({
    period: r.period,
    gold100: capital * (marketData[i].goldPerGram / goldBuyPerGram),
    nifty100: capital * (marketData[i].niftyClose / niftyBuyClose),
    bonds100: capital * (bondsFactor *= 1 + marketData[i].bondsRetPct / 100),
    cash100: capital,
    midcap100: capital * (marketData[i].midcapClose / midcapBuyClose),
    smallcap100: capital * (marketData[i].smallcapClose / smallcapBuyClose),
    portfolio: r.nominalValue,
    nifty: r.equityValue,
    gold: r.goldValue,
    bonds: r.bondsValue,
    cash: r.cashValue,
    midcap: r.midcapValue,
    smallcap: r.smallcapValue,
    inflation: capital * (r.nominalValue / r.realValue),
  }));

  // Drawdown: how far below its previous highest value (starting with the capital) each line is, in %.
  const drawdownOf = (vals: number[]) => {
    let peak = capital;
    return vals.map((v) => {
      peak = Math.max(peak, v);
      return (v / peak - 1) * 100;
    });
  };
  const ddGold = drawdownOf(priceSeries.map((p) => p.gold100));
  const ddNifty = drawdownOf(priceSeries.map((p) => p.nifty100));
  const ddBonds = drawdownOf(priceSeries.map((p) => p.bonds100));
  const ddCash = drawdownOf(priceSeries.map((p) => p.cash100));
  const ddMidcap = drawdownOf(priceSeries.map((p) => p.midcap100));
  const ddSmallcap = drawdownOf(priceSeries.map((p) => p.smallcap100));
  const ddPortfolio = drawdownOf(priceSeries.map((p) => p.portfolio));
  const ddReal = drawdownOf(rows.map((r) => r.realValue));   // Portfolio after inflation
  const drawdownData = priceSeries.map((p, i) => ({
    period: p.period, gold: ddGold[i], nifty: ddNifty[i], bonds: ddBonds[i], cash: ddCash[i],
    midcap: ddMidcap[i], smallcap: ddSmallcap[i], portfolio: ddPortfolio[i], real: ddReal[i],
  }));
  // Worst drawdown episode: peak month -> lowest month -> month it got back to the old peak.

  // Year-end snapshot: always December for a year that reaches it; only the
  // final, still-in-progress year (e.g. "2026 (8 mo)") falls back to its
  // last available month, since December hasn't happened yet for it.
  const yearEndIdx: number[] = [];
  {
    const decIdxByYear = new Map<string, number>();
    const lastIdxByYear = new Map<string, number>();
    rows.forEach((r, i) => {
      const year = r.period.slice(0, 4);
      lastIdxByYear.set(year, i);
      if (r.period.slice(5, 7) === "12") decIdxByYear.set(year, i);
    });
    for (const year of lastIdxByYear.keys()) {
      yearEndIdx.push(decIdxByYear.get(year) ?? lastIdxByYear.get(year)!);
    }
  }

  const yearly: {
    year: string; months: number; nifty: number; gold: number; bonds: number; midcap: number; smallcap: number; cash: number;
    portfolio: number; yearReturn: number; inflation: number; avgSoFar: number;
  }[] = [];
  yearEndIdx.forEach((i, idx) => {
    const r = rows[i];
    const year = r.period.slice(0, 4);
    const prev = idx === 0 ? capital : rows[yearEndIdx[idx - 1]].nominalValue;
    const monthsSoFar = (i + 1) * stepMonths;
    const monthsThisYear = (idx === 0 ? i + 1 : i - yearEndIdx[idx - 1]) * stepMonths;
    yearly.push({
      year,
      months: monthsThisYear,
      nifty: r.equityValue, gold: r.goldValue, bonds: r.bondsValue, midcap: r.midcapValue,
      smallcap: r.smallcapValue, cash: r.cashValue,
      portfolio: r.nominalValue,
      yearReturn: (r.nominalValue / prev - 1) * 100,
      inflation: marketData[i].inflationPct,
      avgSoFar: (Math.pow(r.nominalValue / capital, 12 / monthsSoFar) - 1) * 100,
    });
  });

  // Download table: for every asset its price, the quantity held (bought once, never sold) and the value
  const bondsYearRet = new Map<string, number>();    // each year's Bonds return (the months of the year compounded)
  rows.forEach((r, i) => {
    const y = r.period.slice(0, 4);
    bondsYearRet.set(y, (bondsYearRet.get(y) ?? 1) * (1 + marketData[i].bondsRetPct / 100));
  });
  const downloadTable: Table = {
    plainRupees: true,
    groups: [
      { label: "", span: 1 },
      { label: `NIFTY (target ${weights.equity}%)`, span: 3, color: "#DBEAFE" },
      { label: `GOLD (target ${weights.gold}%)`, span: 3, color: "#FEF3C7" },
      { label: `BONDS (target ${weights.bonds}%)`, span: 2, color: "#DCFCE7" },
      { label: `CASH (target ${weights.cash}%)`, span: 1, color: "#F3F4F6" },
      { label: "PORTFOLIO", span: 1, color: "#FCE7F3" },
      { label: "RETURNS", span: 3, color: "#EDE9FE" },
    ],
    headers: ["Year", "Price", "Qty (shares)", "Value Rs", "Price Rs/g", "Qty (grams)", "Value Rs", "Return that year %", "Value Rs",
      "Value Rs", "Value Rs", "Return that year %", "Inflation %", "Avg per year so far %"],
    kinds: { 1: "num2", 2: "num2", 3: "rupee", 4: "num2", 5: "num2", 6: "rupee", 7: "pct", 8: "rupee", 9: "rupee", 10: "rupee",
      11: "pct", 12: "pct2", 13: "pct" },
    rows: [
      [`${buyLabel} close (buy)`,
        niftyBuyClose, niftyUnitsBought, (capital * weights.equity) / 100,
        goldBuyPerGram, goldGramsBought, (capital * weights.gold) / 100,
        null, (capital * weights.bonds) / 100, (capital * weights.cash) / 100, capital,
        null, null, null],
      ...yearly.map((y, k) => [y.months < 12 ? `${y.year} (${y.months} mo)` : y.year,
        marketData[yearEndIdx[k]].niftyClose, niftyUnitsBought, y.nifty,
        marketData[yearEndIdx[k]].goldPerGram, goldGramsBought, y.gold,
        ((bondsYearRet.get(y.year) ?? 1) - 1) * 100, y.bonds, y.cash, y.portfolio,
        y.yearReturn, y.inflation, y.avgSoFar]),
    ],
    notes: [
      "Price = the December month-end close (Nifty index level; gold in Rs per gram); the last row is the last complete month.",
      "Qty = shares / grams bought once at the start and held (never sold). Value = Qty x Price; Bonds and Cash are in rupees.",
      "The target % of each asset is in its group heading.",
      "The values add up to the Portfolio value.",
    ],
  };

  // The two big charts depend only on the result: keep them as they are while a slider moves
  // (until the new result arrives), instead of redrawing ~700 points per line on every step.
  const [logScale, setLogScale] = usePersisted("logMain", false, isBool);
  const last = priceSeries[priceSeries.length - 1];
  // CAGR of the portfolio and of each asset on its own, shown in one line beside the note under the header
  const cagrItems = [
    { name: "Portfolio", color: "#f472b6", value: last.portfolio },
    { name: "Nifty", color: "#3b82f6", value: last.nifty100 },
    { name: "Gold", color: "#facc15", value: last.gold100 },
    { name: "Bonds", color: "#22c55e", value: last.bonds100 },
  ];
  const charts = useMemo(() => {
    // log scale: round axis ends and ticks around the lowest and highest value drawn
    const logAx = logScale
      ? logAxis(priceSeries.flatMap((p) => [p.gold100, p.nifty100, p.bonds100, p.cash100, p.portfolio, p.inflation]))
      : null;
    return (
    <>
        <section className="mb-5 rounded-xl border border-border bg-panel p-4">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-fg">Portfolio vs Gold, Nifty, Bonds, Cash and Inflation</h3>
          <LogToggle checked={logScale} onChange={setLogScale} />
        </div>
        <p className="mb-2.5 text-xs text-fg-muted">
          Your portfolio against the same {"₹"}{formatINR(capital)} put fully into one asset at {buyMonth} and held till {clampedEnd}. Inflation = what it needs to grow to just keep up with prices.
        </p>
        <div className="relative">
        <KeyBox items={LINE_KEY} />
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={priceSeries} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} />
            <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={64} tickFormatter={(v) => formatLakh(Number(v))}
              scale={logAx ? "log" : "auto"} domain={logAx ? logAx.domain : [0, "auto"]} ticks={logAx?.ticks} allowDataOverflow={!!logAx} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`₹${formatINR(Number(v))}`, name]} />
            <Line isAnimationActive={false} type="monotone" dataKey="gold100" name="Gold" stroke="#facc15" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="nifty100" name="Nifty" stroke="#3b82f6" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="bonds100" name="Bonds" stroke="#22c55e" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="cash100" name="Cash" stroke="#ffffff" dot={false} strokeWidth={2} />
            {SHOW_MIDSMALL && <Line isAnimationActive={false} type="monotone" dataKey="midcap100" name="Midcap" stroke="#fb923c" dot={false} strokeWidth={2} />}
            {SHOW_MIDSMALL && <Line isAnimationActive={false} type="monotone" dataKey="smallcap100" name="Smallcap" stroke="#2dd4bf" dot={false} strokeWidth={2} />}
            <Line isAnimationActive={false} type="monotone" dataKey="inflation" name="Inflation" stroke="#a78bfa" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="portfolio" name="Portfolio" stroke="#f472b6"
              dot={false} strokeWidth={5} />
          </LineChart>
        </ResponsiveContainer>
        </div>
        </section>

        <section className="mb-5 rounded-xl border border-border bg-panel p-4">
        <h3 className="mb-1 text-base font-semibold text-fg">Drawdown: fall from the previous peak</h3>
        <p className="mb-2.5 text-xs text-fg-muted">
          How far each line was below its highest earlier value, year by year (December closes; 0% = at a new high). Purple = Portfolio after inflation.
        </p>
        <div className="relative">
        <KeyBox bottom left={60} items={LINE_KEY.map((k) => ({ ...k, name: k.name === "Inflation" ? "Portfolio after inflation" : k.name }))} />
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={drawdownData} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
            <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} />
            <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={52} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`${Number(v).toFixed(2)}%`, name]} />
            <Line isAnimationActive={false} type="monotone" dataKey="gold" name="Gold" stroke="#facc15" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="nifty" name="Nifty" stroke="#3b82f6" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="bonds" name="Bonds" stroke="#22c55e" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="cash" name="Cash" stroke="#ffffff" dot={false} strokeWidth={2} />
            {SHOW_MIDSMALL && <Line isAnimationActive={false} type="monotone" dataKey="midcap" name="Midcap" stroke="#fb923c" dot={false} strokeWidth={2} />}
            {SHOW_MIDSMALL && <Line isAnimationActive={false} type="monotone" dataKey="smallcap" name="Smallcap" stroke="#2dd4bf" dot={false} strokeWidth={2} />}
            <Line isAnimationActive={false} type="monotone" dataKey="real" name="Portfolio after inflation" stroke="#a78bfa" dot={false} strokeWidth={2} />
            <Line isAnimationActive={false} type="monotone" dataKey="portfolio" name="Portfolio" stroke="#f472b6"
              dot={false} strokeWidth={5} />
          </LineChart>
        </ResponsiveContainer>
        </div>
        </section>
    </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, capital, logScale]);

  return (
    <>

      {metricsSlot && createPortal(
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <InlineValue label="Portfolio" value={final.nominalValue} delta={final.nominalValue - capital} cagr={cagrOf(final.nominalValue)} />
        </div>, metricsSlot)}
      {cagrSlot && createPortal(
        <div className="flex flex-wrap items-center ml-auto justify-end gap-x-5 gap-y-0.5 text-xl text-fg-muted">
          <span className="font-semibold uppercase tracking-wide">CAGR</span>
          {cagrItems.map((it) => {
            const c = cagrOf(it.value);
            return (
              <span key={it.name} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-3 w-3 rounded-[2px]" style={{ background: it.color }} />
                {it.name}
                <strong className={`tabular-nums ${c >= 0 ? "text-bonds" : "text-danger"}`}>{fmtCagr(c)}</strong>
              </span>
            );
          })}
        </div>, cagrSlot)}
      {pieSlot && createPortal(
        <AllocationPie capital={capital} weights={weights} cagr={cagrOf(final.nominalValue)}
          assetCagr={{ "Equity (Nifty)": cagrOf(last.nifty100), Gold: cagrOf(last.gold100), Bonds: cagrOf(last.bonds100), Cash: 0 }} />, pieSlot)}

      {charts}

      <section className="mt-5 rounded-xl border border-border bg-panel p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-fg">Year by year</h3>
        <DownloadMenu
          onExcel={() => exportTablesExcel(`year-by-year_${clampedStart}_${clampedEnd}`, [{ name: "Year by year", table: downloadTable }])}
          onPdf={() => exportTablesPdf(`year-by-year_${clampedStart}_${clampedEnd}`, "Year by year",
            `Portfolio vs inflation, ${clampedStart} to ${clampedEnd}, starting capital Rs ${Math.round(capital).toLocaleString("en-IN")}`,
            [{ heading: "Year by year: price, quantity and value of each asset", table: downloadTable }])} />
      </div>
      <p className="mb-2.5 text-xs text-fg-muted">
        First row = the amounts, and the units/grams you bought at the {buyLabel} closing price (never sold) &mdash; Nifty in shares, Gold in grams. Then the value at each year end (December close).
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="bg-bg text-left text-xs uppercase tracking-wide text-fg-muted">
              {["Year", "Nifty", "Gold", "Bonds", "Midcap", "Smallcap", "Cash", "Portfolio", "Return that year", "Inflation"]
                .filter((h) => SHOW_MIDSMALL || (h !== "Midcap" && h !== "Smallcap"))
                .map((h, k) => (
                  <th key={h} className={`whitespace-nowrap px-3 py-2 font-semibold ${k ? "text-right" : ""}`}>{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border bg-accent/10">
              <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-fg">
                {buyLabel} <span className="text-xs font-normal text-fg-muted">close (buy)</span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                ₹{formatINR((capital * weights.equity) / 100)}
                <div className="text-[10px] font-normal text-fg-muted">{niftyUnitsBought.toFixed(2)} shares @ {niftyBuyClose.toFixed(2)}</div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                ₹{formatINR((capital * weights.gold) / 100)}
                <div className="text-[10px] font-normal text-fg-muted">{goldGramsBought.toFixed(2)} g @ ₹{goldBuyPerGram.toFixed(2)}/g</div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR((capital * weights.bonds) / 100)}</td>
              {SHOW_MIDSMALL && (
                <>
              <td className="px-3 py-1.5 text-right tabular-nums">
                ₹{formatINR((capital * weights.midcap) / 100)}
                <div className="text-[10px] font-normal text-fg-muted">{midcapUnitsBought.toFixed(2)} units</div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                ₹{formatINR((capital * weights.smallcap) / 100)}
                <div className="text-[10px] font-normal text-fg-muted">{smallcapUnitsBought.toFixed(2)} units</div>
              </td>
                </>
              )}
              <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR((capital * weights.cash) / 100)}</td>
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">₹{formatINR(capital)}</td>
              <td className="px-3 py-1.5 text-right text-fg-muted">—</td>
              <td className="px-3 py-1.5 text-right text-fg-muted">—</td>
              <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(capital)}</td>
              <td className="px-3 py-1.5 text-right text-fg-muted">—</td>
            </tr>
            {yearly.map((y) => (
              <tr key={y.year} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-1.5 text-fg">
                  {y.year}{y.months < 12 && <span className="text-xs text-fg-muted"> ({y.months} mo)</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.nifty)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.gold)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.bonds)}</td>
                {SHOW_MIDSMALL && (
                  <>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.midcap)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.smallcap)}</td>
                  </>
                )}
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.cash)}</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">₹{formatINR(y.portfolio)}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${y.yearReturn >= 0 ? "text-bonds" : "text-danger"}`}>
                  {y.yearReturn >= 0 ? "+" : ""}{y.yearReturn.toFixed(2)}%
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-fg-muted">{y.inflation.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>

    </>
  );
}

const ASSET_LABEL: Record<string, string> = {
  equity: "Nifty", gold: "Gold", bonds: "Bonds", midcap: "Midcap", smallcap: "Smallcap", cash: "Cash",
};

// Nifty is held in shares (index units) and Gold in grams; Bonds and Cash have no units (the amount is the holding).
const UNIT_NAME: Record<string, string> = { equity: "shares", gold: "g" };

type ReviewPrices = Record<string, { equity: number; gold: number }>;

/** Units (Nifty) / grams (Gold) for a rupee amount at the review's closing price; null for Bonds and Cash. */
function unitsFor(asset: string, amount: number, prices: ReviewPrices[string] | undefined): number | null {
  if (!prices || (asset !== "equity" && asset !== "gold")) return null;
  return amount / prices[asset];
}

function UnitLine({ asset, units, signed }: { asset: string; units: number | null; signed?: boolean }) {
  if (units === null) return null;
  return (
    <div className="text-[10px] font-normal text-fg-muted">
      {signed ? (units >= 0 ? "+" : "−") : ""}{Math.abs(units).toFixed(2)} {UNIT_NAME[asset]}
    </div>
  );
}

type RbYear = {
  label: string;            // "1997 Dec" or "2026 (9 mo)"
  partial: boolean;
  review: boolean;          // a December review happened
  rebalanced: boolean;
  total: number;
  inflation: number;
  ret: number;
  avg: number;
  why: string;              // the asset furthest from its target
  bondsRet: number;         // Bonds return of that year (Jan to the row's month)
  px: ReviewPrices[string];
  cells: Record<string, { before: number; trade: number; after: number }>;
};

/** One row per December (plus the last, unfinished year) of the rebalanced portfolio: the amount in each
 *  asset at the year-end close, what was bought / sold that December, and what it was after. */
function rebalanceYears(rb: BacktestResult, capital: number, assets: string[]): RbYear[] {
  const stepMonths = 12 / (rb.periodsPerYear || 12);
  const out: RbYear[] = [];
  let prevTotal = capital;
  const byPeriod = new Map(rb.rebalanceEvents.map((e) => [e.period, e]));
  const bondsGrowth = new Map<string, number>();     // year -> growth factor of Bonds in that year
  for (const m of rb.marketData) {
    const y = m.period.slice(0, 4);
    bondsGrowth.set(y, (bondsGrowth.get(y) ?? 1) * (1 + m.bondsRetPct / 100));
  }
  rb.rows.forEach((r, idx) => {
    const isLast = idx === rb.rows.length - 1;
    const ev = byPeriod.get(r.period);
    if (!ev && !isLast) return;
    const md = rb.marketData[idx];
    const px = { equity: md.niftyClose, gold: md.goldPerGram };
    const value: Record<string, number> = {
      equity: r.equityValue, gold: r.goldValue, bonds: r.bondsValue,
      midcap: r.midcapValue, smallcap: r.smallcapValue, cash: r.cashValue,
    };
    const cells: RbYear["cells"] = {};
    for (const a of assets) {
      const it = ev?.items.find((i) => i.asset === a);
      const before = it ? it.actualValue : value[a];
      const trade = ev?.rebalanced && it ? it.trade : 0;
      cells[a] = { before, trade, after: before + trade };
    }
    const total = ev ? ev.total : r.nominalValue;
    const far = ev?.items.filter((i) => assets.includes(i.asset))
      .reduce((m, i) => (Math.abs(i.driftPct) > Math.abs(m.driftPct) ? i : m));
    const months = (idx + 1) * stepMonths;
    out.push({
      label: ev ? `${r.period.slice(0, 4)} Dec` : `${r.period.slice(0, 4)} (${Number(r.period.slice(5, 7))} mo)`,
      partial: !ev,
      review: !!ev,
      rebalanced: !!ev?.rebalanced,
      total,
      inflation: md.inflationPct,
      ret: total / prevTotal - 1,
      avg: (total / capital) ** (12 / months) - 1,
      why: far ? `${ASSET_LABEL[far.asset]} ${far.actualPct.toFixed(1)}% vs ${far.targetPct}% target` : "",
      bondsRet: (bondsGrowth.get(r.period.slice(0, 4)) ?? 1) - 1,
      px,
      cells,
    });
    prevTotal = total;
  });
  return out;
}

function RebalanceYearByYear({ rb, capital, weights, tolerance, action }: {
  rb: BacktestResult; capital: number; weights: Weights; tolerance: number; action?: React.ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const assets = ["equity", "gold", "bonds", "midcap", "smallcap", "cash"]
    .filter((a) => SHOW_MIDSMALL || (a !== "midcap" && a !== "smallcap"));
  const years = rebalanceYears(rb, capital, assets);
  const buyPx: ReviewPrices[string] = { equity: rb.niftyBuyClose, gold: rb.goldBuyPerGram };
  const buyLabel = `${rb.buyPeriod.slice(0, 4)} ${MONTH_NAMES[Number(rb.buyPeriod.slice(5, 7)) - 1]}`;
  const weight = weights as unknown as Record<string, number>;
  const priceText = (a: string, px: ReviewPrices[string]) => (a === "equity" ? money2(px.equity) : `₹${money2(px.gold)}/g`);
  const done = years.filter((y) => y.rebalanced).length;
  const reviews = years.filter((y) => y.review).length;
  const nCols = assets.length + 4;
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allKeys = ["buy", ...years.map((y) => y.label)];
  const allOpen = allKeys.every((k) => open.has(k));

  const Detail = ({ y }: { y: (typeof years)[number] }) => (
    <div>
      <table className="w-full max-w-[1100px] border-collapse text-sm tabular-nums">
        <thead>
          <tr className="text-left text-[13px] uppercase tracking-wide text-fg-muted">
            {["Asset", "At the close", "Buy / sell", "After", "Shares / grams"].map((h, k) => (
              <th key={h} className={`whitespace-nowrap px-3 py-1.5 font-medium ${k ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => {
            const c = y.cells[a];
            const traded = Math.abs(c.trade) >= 0.5;
            const held = unitsFor(a, c.before, y.px);
            const after = unitsFor(a, c.after, y.px);
            const pctBefore = (c.before / y.total) * 100;
            const pctAfter = (c.after / y.total) * 100;
            return (
              <tr key={a} className="border-t border-border">
                <td className="whitespace-nowrap px-3 py-1.5 font-medium text-fg">{ASSET_LABEL[a]}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  ₹{formatINR(c.before)} <span className="text-[13px] text-fg-muted">{pctBefore.toFixed(1)}%</span>
                </td>
                <td className={`whitespace-nowrap px-3 py-1.5 text-right font-medium ${traded ? (c.trade >= 0 ? "text-bonds" : "text-danger") : "text-fg-muted"}`}>
                  {traded ? `${c.trade >= 0 ? "+" : "−"}₹${formatINR(Math.abs(c.trade))}` : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  ₹{formatINR(c.after)} <span className="text-[13px] text-fg-muted">{pctAfter.toFixed(1)}%</span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  {held !== null && after !== null ? (
                    <>
                      {held.toFixed(2)}{traded && <> &rarr; {after.toFixed(2)}</>} {UNIT_NAME[a]}{" "}
                      <span className="text-[13px] text-fg-muted">@ {priceText(a, y.px)}</span>
                    </>
                  ) : a === "bonds" ? (
                    <span className="text-[13px] text-fg-muted">
                      {y.bondsRet >= 0 ? "+" : ""}{(y.bondsRet * 100).toFixed(2)}% {y.partial ? "this year so far" : "this year"}
                    </span>
                  ) : (
                    <span className="text-fg-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {y.review && (
        <div className="mt-2 px-3 text-sm text-fg-muted">
          {y.rebalanced ? "Rebalanced because " : "Not rebalanced: furthest from target was "}{y.why}
          {tolerance ? ` (limit ${tolerance} points).` : "."}
        </div>
      )}
      {y.partial && <div className="mt-2 px-3 text-sm text-fg-muted">No December review yet in this year.</div>}
    </div>
  );

  return (
    <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-fg">Year by year (with rebalancing)</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}
            className="rounded-lg border border-border bg-bg px-4 py-2.5 text-sm text-fg-muted hover:text-fg">
            {allOpen ? "Close all" : "Open all"}
          </button>
          {action}
        </div>
      </div>
      <p className="mb-3 text-sm text-fg-muted">
        The amount in each asset at every December close. Click a year (&#9656;) to see the
        details: Nifty shares / gold grams @ price, what was bought or sold, and the Bonds return. <span className="text-accent">●</span> = rebalanced
        that December ({done} of {reviews} years
        {tolerance ? `, only when an asset is more than ${tolerance}% away from its target` : ", every year"}).
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] border-collapse text-base">
          <thead>
            <tr className="bg-bg text-left text-sm uppercase tracking-wide text-fg-muted">
              {["Year", ...assets.map((a) => ASSET_LABEL[a]), "Portfolio", "Return that year", "Inflation"]
                .map((h, k) => (
                  <th key={h} className={`whitespace-nowrap px-4 py-3 font-semibold ${k ? "text-right" : ""}`}>{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            <tr className="cursor-pointer border-t border-border bg-accent/10 hover:bg-accent/15" onClick={() => toggle("buy")}>
              <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-fg">
                <span className="mr-1.5 inline-block w-4 text-fg-muted">{open.has("buy") ? "▾" : "▸"}</span>
                {buyLabel} <span className="text-sm font-normal text-fg-muted">close (buy)</span>
              </td>
              {assets.map((a) => (
                <td key={a} className="px-4 py-2.5 text-right tabular-nums">₹{formatINR((capital * (weight[a] ?? 0)) / 100)}</td>
              ))}
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums">₹{formatINR(capital)}</td>
              <td className="px-4 py-2.5 text-right text-fg-muted">—</td>
              <td className="px-4 py-2.5 text-right text-fg-muted">—</td>
              <td className="px-4 py-2.5 text-right tabular-nums">₹{formatINR(capital)}</td>
              <td className="px-4 py-2.5 text-right text-fg-muted">—</td>
            </tr>
            {open.has("buy") && (
              <tr className="bg-bg/60">
                <td colSpan={nCols} className="px-4 py-3">
                  <div className="flex flex-wrap gap-2 text-sm tabular-nums">
                    {assets.map((a) => {
                      const amt = (capital * (weight[a] ?? 0)) / 100;
                      const u = unitsFor(a, amt, buyPx);
                      return (
                        <div key={a} className="rounded-lg border border-border bg-panel px-4 py-2.5">
                          <span className="font-semibold text-fg">{ASSET_LABEL[a]}</span>: ₹{formatINR(amt)}
                          {u !== null && <span className="text-fg-muted"> &middot; {u.toFixed(2)} {UNIT_NAME[a]} bought @ {priceText(a, buyPx)}</span>}
                        </div>
                      );
                    })}
                  </div>
                </td>
              </tr>
            )}
            {years.map((y) => (
              <Fragment key={y.label}>
                <tr className="cursor-pointer border-t border-border hover:bg-bg/60" onClick={() => toggle(y.label)}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-fg">
                    <span className="mr-1.5 inline-block w-4 text-fg-muted">{open.has(y.label) ? "▾" : "▸"}</span>{y.label}
                    {y.rebalanced && <span className="ml-2 text-lg leading-none text-accent" title="Rebalanced this December">●</span>}
                  </td>
                  {assets.map((a) => (
                    <td key={a} className="px-4 py-2.5 text-right tabular-nums">₹{formatINR(y.cells[a].before)}</td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">₹{formatINR(y.total)}</td>
                  <td className={`px-4 py-2.5 text-right tabular-nums ${y.ret < 0 ? "text-danger" : "text-bonds"}`}>
                    {y.ret >= 0 ? "+" : ""}{(y.ret * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{y.inflation.toFixed(2)}%</td>
                </tr>
                {open.has(y.label) && (
                  <tr className="bg-bg/60">
                    <td colSpan={nCols} className="px-4 py-3"><Detail y={y} /></td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Last Rebalance results by their inputs: switching tabs back shows them at once.
const rebalanceCache = new Map<string, { rb: BacktestResult; bh: BacktestResult }>();

/** Proof of the header numbers: what each asset is worth at the end with and without rebalancing,
 *  how many shares / grams are held, and the difference (the sum of the differences = the gain). */
function WithVsWithout({ rb, bh, capital, weights, done, reviews }: {
  rb: BacktestResult; bh: BacktestResult; capital: number; weights: Weights; done: number; reviews: number;
}) {
  const withEnd = rb.rows[rb.rows.length - 1], withoutEnd = bh.rows[bh.rows.length - 1];
  const px = rb.marketData[rb.marketData.length - 1];
  const lines = [
    { key: "equity", label: "Nifty", color: "#3b82f6", w: weights.equity, a: withEnd.equityValue, b: withoutEnd.equityValue,
      buyPx: rb.niftyBuyClose, endPx: px.niftyClose, unit: "shares" },
    { key: "gold", label: "Gold", color: "#facc15", w: weights.gold, a: withEnd.goldValue, b: withoutEnd.goldValue,
      buyPx: rb.goldBuyPerGram, endPx: px.goldPerGram, unit: "g" },
    { key: "bonds", label: "Bonds", color: "#22c55e", w: weights.bonds, a: withEnd.bondsValue, b: withoutEnd.bondsValue },
    { key: "cash", label: "Cash", color: "#ffffff", w: weights.cash, a: withEnd.cashValue, b: withoutEnd.cashValue },
  ];
  const years = rb.rows.length / rb.periodsPerYear;
  const cagr = (v: number) => (v > 0 ? ((v / capital) ** (1 / years) - 1) * 100 : -100);
  const gain = withEnd.nominalValue - withoutEnd.nominalValue;
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}₹${formatINR(Math.abs(n))}`;
  const tone = (n: number) => (n >= 0 ? "text-bonds" : "text-danger");
  const Units = ({ n, unit }: { n: number; unit?: string }) => (unit ? <div className="text-[11px] font-normal text-fg-muted">{n.toFixed(2)} {unit}</div> : null);
  return (
    <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-fg">With vs without rebalancing: how the numbers come</h3>
      <p className="mb-2.5 text-xs text-fg-muted">
        Same {"₹"}{formatINR(capital)} bought at {rb.buyPeriod} and valued at {rb.clampedEnd}. <strong className="text-fg">Without</strong> = held as bought, nothing sold.
        {" "}<strong className="text-fg">With</strong> = every December the assets are sold / bought back to the target % ({done} of {reviews} Decembers did it).
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-bg text-xs uppercase tracking-wide text-fg-muted">
              <th className="px-3 py-2 text-left font-semibold">Asset</th>
              <th className="px-3 py-2 text-right font-semibold">Bought (target)</th>
              <th className="px-3 py-2 text-right font-semibold">Without rebalance</th>
              <th className="px-3 py-2 text-right font-semibold">With rebalance</th>
              <th className="px-3 py-2 text-right font-semibold">With − without</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const start = (capital * l.w) / 100;
              return (
                <tr key={l.key} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-fg">
                    <span className="mr-2 inline-block h-3 w-5 rounded-[2px] align-middle" style={{ background: l.color }} />{l.label} <span className="text-fg-muted">{l.w}%</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(start)}{l.buyPx && <Units n={start / l.buyPx} unit={l.unit} />}</td>
                  <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(l.b)}{l.endPx && l.buyPx && <Units n={start / l.buyPx} unit={l.unit} />}</td>
                  <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(l.a)}{l.endPx && <Units n={l.a / l.endPx} unit={l.unit} />}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${tone(l.a - l.b)}`}>{signed(l.a - l.b)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border bg-bg font-semibold">
              <td className="px-3 py-2 text-fg">Portfolio</td>
              <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(capital)}</td>
              <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(withoutEnd.nominalValue)}<div className="text-[11px] font-normal text-fg-muted">CAGR {fmtCagr(cagr(withoutEnd.nominalValue))}</div></td>
              <td className="px-3 py-2 text-right tabular-nums">₹{formatINR(withEnd.nominalValue)}<div className="text-[11px] font-normal text-fg-muted">CAGR {fmtCagr(cagr(withEnd.nominalValue))}</div></td>
              <td className={`px-3 py-2 text-right tabular-nums ${tone(gain)}`}>{signed(gain)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-xs text-fg-muted">
        Rebalance gain = ₹{formatINR(withEnd.nominalValue)} (with) − ₹{formatINR(withoutEnd.nominalValue)} (without) = <strong className={tone(gain)}>{signed(gain)}</strong>.
        {" "}Each asset: shares / grams × the {rb.clampedEnd} price (Nifty {px.niftyClose.toFixed(2)}, Gold ₹{px.goldPerGram.toFixed(2)}/g); Bonds and Cash in rupees.
        {gain < 0 && <>{" "}The gain is negative because the assets sold each December went on to grow faster than the ones bought.</>}
      </p>
    </section>
  );
}

/** "13 Oct 2026" from "2026-10-13". */
const prettyDate = (iso: string) => `${iso.slice(8, 10)} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** The December month-end of `year` (the last weekday, a weekend 31 Dec moves back) and how many days away it is. */
const todayText = () => {
  const t = new Date();
  return `${t.toLocaleDateString("en-IN", { weekday: "short" })}, ${String(t.getDate()).padStart(2, "0")} ${MONTH_NAMES[t.getMonth()]} ${t.getFullYear()}`;
};

function nextDecemberReview(year: number) {
  const d = new Date(year, 11, 31);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  return {
    label: `${String(d.getDate()).padStart(2, "0")} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`,
    when: days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : days === 0 ? "today" : `${-days} days ago`,
  };
}

function RebalancePage({ capital, weights, start, end, frequency, metricsSlot, pieSlot, dataThrough, lastClose, latestPrices }: {
  capital: number; weights: Weights; start: string; end: string; frequency: "yearly" | "monthly";
  metricsSlot: HTMLElement | null; pieSlot: HTMLElement | null; dataThrough?: string; lastClose?: string;
  latestPrices?: DataRange["latest"];
}) {
  const [tolerance, setTolerance] = usePersisted("tolerance", 0, isOneOf(0, 5, 10));
  // "As of now" shows the position with rebalancing; ticking the box shows it without (buy & hold)
  const [showWithout, setShowWithout] = usePersisted("asOfWithout", false, isBool);
  // ...and it can be valued at the newest prices (today) instead of the last complete month's close
  const [useLatest, setUseLatest] = usePersisted("asOfLatest", false, isBool);
  const { equity, gold, bonds, midcap, smallcap } = weights;
  const cacheKey = JSON.stringify({ capital, equity, gold, bonds, midcap, smallcap, start, end, tolerance, frequency });
  // The last answer from the API, tagged with the inputs it was for.
  const [fetched, setFetched] = useState<{ key: string; data?: { rb: BacktestResult; bh: BacktestResult }; error?: string } | null>(null);

  useEffect(() => {
    if (rebalanceCache.has(cacheKey)) return;
    const controller = new AbortController();
    const base = JSON.parse(cacheKey) as Parameters<typeof fetchBacktest>[0];
    Promise.all([
      fetchBacktest({ ...base, rebalance: true }, controller.signal),
      fetchBacktest({ ...base, rebalance: false }, controller.signal),
    ])
      .then(([rb, bh]) => {
        if (rebalanceCache.size > 20) rebalanceCache.clear();
        rebalanceCache.set(cacheKey, { rb, bh });
        setFetched({ key: cacheKey, data: { rb, bh } });
      })
      .catch((e) => { if (e.name !== "AbortError") setFetched({ key: cacheKey, error: e.message }); });
    return () => controller.abort();
  }, [cacheKey]);

  // Cached result for these inputs, else the last one shown (while the new one loads).
  const data = rebalanceCache.get(cacheKey) ?? fetched?.data ?? null;
  const error = fetched?.key === cacheKey ? fetched.error : undefined;

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!data) return <p className="py-10 text-center text-fg-muted">Loading rebalance calculation&hellip;</p>;

  const { rb, bh } = data;
  const events = rb.rebalanceEvents;
  const done = events.filter((e) => e.rebalanced).length;
  const rbFinal = rb.rows[rb.rows.length - 1];
  const bhFinal = bh.rows[bh.rows.length - 1];
  const latest = events.length ? events[events.length - 1] : null;
  const heldYears = rb.rows.length / rb.periodsPerYear;
  const cagrOf = (v: number) => (v > 0 && capital > 0 && heldYears > 0 ? ((v / capital) ** (1 / heldYears) - 1) * 100 : -100);
  const monthPx = rb.marketData[rb.marketData.length - 1];
  const live = useLatest && latestPrices ? latestPrices : null;
  const nowPx = live ? { equity: live.nifty, gold: live.gold } : { equity: monthPx.niftyClose, gold: monthPx.goldPerGram };
  // Bonds and Cash keep the last complete month's value (Bonds earn their yearly return in one step)
  const growth = live ? { equity: live.nifty / monthPx.niftyClose, gold: live.gold / monthPx.goldPerGram } : { equity: 1, gold: 1 };
  // Where one run (with or without rebalancing) stands at the last complete month against the target.
  const asOf = (row: (typeof rb.rows)[number]) => {
    const vals: Record<string, number> = {
      equity: row.equityValue * growth.equity, gold: row.goldValue * growth.gold, bonds: row.bondsValue,
      midcap: row.midcapValue, smallcap: row.smallcapValue, cash: row.cashValue,
    };
    const total = Object.values(vals).reduce((t, v) => t + v, 0);
    const items = (["equity", "gold", "bonds", "midcap", "smallcap", "cash"] as const)
      .filter((a) => SHOW_MIDSMALL || (a !== "midcap" && a !== "smallcap"))
      .map((a) => {
        const target = (weights as unknown as Record<string, number>)[a] ?? 0;
        const actualPct = total ? (100 * vals[a]) / total : 0;
        return { asset: a, target, actualPct, drift: actualPct - target, trade: (total * target) / 100 - vals[a] };
      });
    const needs = items.some((i) => Math.abs(i.drift) > tolerance + 1e-9 && (tolerance > 0 || Math.abs(i.trade) >= 1));
    return { total, items, needs };
  };
  const nowRow = rb.rows[rb.rows.length - 1];
  const nowModes = showWithout
    ? [{ key: "without", label: "Without rebalance (buy & hold)", ...asOf(bh.rows[bh.rows.length - 1]) }]
    : [{ key: "with", label: "With rebalance", ...asOf(nowRow) }];
  const todayLabel = todayText();
  const liveDates = live ? (live.nifty_date === live.gold_date ? prettyDate(live.nifty_date) : `Nifty ${prettyDate(live.nifty_date)}, Gold ${prettyDate(live.gold_date)}`) : "";
  const nowIsDec = nowRow.period.slice(5, 7) === "12";
  const nextReview = nextDecemberReview(Number(nowRow.period.slice(0, 4)) + (nowIsDec ? 1 : 0));
  const prices: ReviewPrices = {};
  for (const e of events) {
    const k = rb.rows.findIndex((r) => r.period === e.period);
    if (k >= 0) prices[e.period] = { equity: rb.marketData[k].niftyClose, gold: rb.marketData[k].goldPerGram };
  }
  const ybyAssets = ["equity", "gold", "bonds", "midcap", "smallcap", "cash"]
    .filter((a) => SHOW_MIDSMALL || (a !== "midcap" && a !== "smallcap"));
  const ybyYears = rebalanceYears(rb, capital, ybyAssets);
  const wmap = weights as unknown as Record<string, number>;
  const ybyKinds: Table["kinds"] = {};
  let kcol = 1;
  for (const a of ybyAssets) {
    const hasUnits = a === "equity" || a === "gold";
    ybyKinds[kcol] = "rupee"; ybyKinds[kcol + 1] = "signedRupee";
    if (hasUnits) { ybyKinds[kcol + 2] = "signedNum2"; ybyKinds[kcol + 3] = "num2"; }
    if (a === "bonds") ybyKinds[kcol + 2] = "pct";
    kcol += hasUnits ? 4 : a === "bonds" ? 3 : 2;
  }
  ybyKinds[kcol] = "rupee"; ybyKinds[kcol + 1] = "pct"; ybyKinds[kcol + 2] = "pct2";
  ybyKinds[kcol + 3] = "pct2";
  // New style: for every asset its price, the quantity held and the value, as it stands after each December's review
  const qtyOf = (a: "equity" | "gold", amount: number, px: ReviewPrices[string]) => amount / px[a];
  const buyAmt = (a: "equity" | "gold" | "bonds" | "cash") => (capital * (wmap[a] ?? 0)) / 100;
  const qtyTable: Table = {
    plainRupees: true,
    groups: [
      { label: "", span: 1 },
      { label: `NIFTY (target ${weights.equity}%)`, span: 3, color: "#DBEAFE" },
      { label: `GOLD (target ${weights.gold}%)`, span: 3, color: "#FEF3C7" },
      { label: `BONDS (target ${weights.bonds}%)`, span: 2, color: "#DCFCE7" },
      { label: `CASH (target ${weights.cash}%)`, span: 1, color: "#F3F4F6" },
      { label: "PORTFOLIO", span: 1, color: "#FCE7F3" },
      { label: "RETURNS", span: 3, color: "#EDE9FE" },
    ],
    headers: ["Year", "Price", "Qty (shares)", "Value Rs", "Price Rs/g", "Qty (grams)", "Value Rs", "Return that year %", "Value Rs",
      "Value Rs", "Value Rs", "Return that year %", "Inflation %", "Avg per year so far %"],
    kinds: { 1: "num2", 2: "num2", 3: "rupee", 4: "num2", 5: "num2", 6: "rupee", 7: "pct", 8: "rupee", 9: "rupee", 10: "rupee",
      11: "pct", 12: "pct2", 13: "pct" },
    rows: [
      [`${rb.buyPeriod} (buy)`,
        rb.niftyBuyClose, buyAmt("equity") / rb.niftyBuyClose, buyAmt("equity"),
        rb.goldBuyPerGram, buyAmt("gold") / rb.goldBuyPerGram, buyAmt("gold"),
        null, buyAmt("bonds"), buyAmt("cash"), capital, null, null, null],
      ...ybyYears.map((y) => [y.label,
        y.px.equity, qtyOf("equity", y.cells.equity.after, y.px), y.cells.equity.after,
        y.px.gold, qtyOf("gold", y.cells.gold.after, y.px), y.cells.gold.after,
        y.bondsRet * 100, y.cells.bonds.after, y.cells.cash.after,
        y.total, y.ret * 100, y.inflation, y.avg * 100]),
    ],
    notes: [
      "Price = the December month-end close (Nifty index level; gold in Rs per gram).",
      "Qty and Value = what is held after that December's review: unchanged in a year that was not rebalanced. The target % of each asset is in its group heading.",
      "Value = Qty x Price for Nifty and Gold; Bonds and Cash are in rupees. The values add up to the Portfolio value.",
    ],
  };
  const ybyTable: Table = {
    headers: ["Year",
      ...ybyAssets.flatMap((a) => {
        const n = ASSET_LABEL[a];
        const u = a === "equity" ? "shares" : a === "gold" ? "grams" : null;
        if (a === "bonds") return [`${n} Rs (Dec close)`, `${n} buy/sell Rs`, `${n} return that year %`];
        return u ? [`${n} Rs (Dec close)`, `${n} buy/sell Rs`, `${n} ${u} bought/sold`, `${n} ${u} after`]
                 : [`${n} Rs (Dec close)`, `${n} buy/sell Rs`];
      }),
      "Portfolio Rs", "Return that year %", "Inflation %", "Avg per year so far %"],
    rows: [
      [`${rb.buyPeriod} (buy)`,
        ...ybyAssets.flatMap((a) => {
          const amt = (capital * (wmap[a] ?? 0)) / 100;
          const u = unitsFor(a, amt, { equity: rb.niftyBuyClose, gold: rb.goldBuyPerGram });
          if (a === "bonds") return [amt, null, null];
          return u !== null ? [amt, null, null, u] : [amt, null];
        }),
        capital, null, null, null],
      ...ybyYears.map((y) => [y.label,
        ...ybyAssets.flatMap((a) => {
          const c = y.cells[a];
          const tu = unitsFor(a, c.trade, y.px);
          const au = unitsFor(a, c.after, y.px);
          if (a === "bonds") return [c.before, y.rebalanced ? c.trade : null, y.bondsRet * 100];
          return tu !== null
            ? [c.before, y.rebalanced ? c.trade : null, y.rebalanced ? tu : null, au]
            : [c.before, y.rebalanced ? c.trade : null];
        }),
        y.total, y.ret * 100, y.inflation, y.avg * 100]),
    ],
    kinds: ybyKinds,
  };
  const rbFile = `rebalance_${rb.clampedStart}_${rb.clampedEnd}_band${tolerance}`;
  const rbTitle = "Annual rebalance (every December)";
  const rbSub = `Capital Rs ${Math.round(capital).toLocaleString("en-IN")}, ${rb.clampedStart} to ${rb.clampedEnd}, ` +
    `Nifty ${weights.equity}% / Gold ${weights.gold}% / Bonds ${weights.bonds}% / Cash ${weights.cash}%, ` +
    `rebalance only if drift is more than ${tolerance}%. ` +
    `With rebalance Rs ${Math.round(rbFinal.nominalValue).toLocaleString("en-IN")} vs buy & hold Rs ${Math.round(bhFinal.nominalValue).toLocaleString("en-IN")}.`;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-3.5 py-2.5 text-sm text-fg-muted">
        <span>
          Annual rebalance (every December) for ₹{formatINR(capital)}, {rb.clampedStart} to {rb.clampedEnd}. Target:
          Nifty {weights.equity}% · Gold {weights.gold}% · Bonds {weights.bonds}%
          {SHOW_MIDSMALL ? ` · Midcap ${weights.midcap}% · Smallcap ${weights.smallcap}%` : ""} · Cash {weights.cash}%
        </span>
        <label className="ml-auto flex items-center gap-2">
          <span>Rebalance only if drift is more than</span>
          <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}
            className="rounded border border-border bg-bg px-1.5 py-0.5 text-fg">
            <option value={0}>0% (always)</option>
            <option value={5}>±5%</option>
            <option value={10}>±10%</option>
          </select>
        </label>
      </div>

      {metricsSlot && createPortal(
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <InlineValue label="With rebalance" value={rbFinal.nominalValue} delta={rbFinal.nominalValue - capital} cagr={cagrOf(rbFinal.nominalValue)} />
          <span className="h-8 w-px bg-border" />
          <InlineValue label="Without rebalance" value={bhFinal.nominalValue} delta={bhFinal.nominalValue - capital} cagr={cagrOf(bhFinal.nominalValue)} />
          <span className="h-8 w-px bg-border" />
          <InlineValue label="Rebalance gain" value={rbFinal.nominalValue - bhFinal.nominalValue} signed />
          <span className="text-sm text-fg-muted">
            <strong className="text-fg">{done}</strong> of {events.length} reviews rebalanced
          </span>
        </div>, metricsSlot)}
      {pieSlot && createPortal(
        <AllocationPie capital={capital} weights={weights}
          cagr={rbFinal.nominalValue > 0 && capital > 0 ? ((rbFinal.nominalValue / capital) ** (rb.periodsPerYear / rb.rows.length) - 1) * 100 : -100} />, pieSlot)}

      {latest && (
        <section className="mb-5 grid gap-4 rounded-xl border border-accent/50 bg-panel p-4 xl:grid-cols-2">
          <div>
          <h3 className="mb-1 text-base font-semibold text-fg">
            Latest review: {latest.period.slice(0, 4)} Dec &mdash; {latest.rebalanced ? "Rebalance recommended" : "No action needed"}
          </h3>
          <p className="mb-2 text-xs text-fg-muted">
            Portfolio ₹{formatINR(latest.total)}.{" "}
            {latest.rebalanced
              ? "Buy / reduce these amounts to return to your target."
              : `Every asset is within ${tolerance}% of its target.`}
          </p>
          {latest.rebalanced && (
            <div className="flex flex-wrap gap-2 text-sm tabular-nums">
              {latest.items.filter((i) => SHOW_MIDSMALL || (i.asset !== "midcap" && i.asset !== "smallcap")).map((i) => (
                <span key={i.asset} className={`rounded-lg border border-border bg-bg px-3 py-1.5 ${i.trade >= 0 ? "text-bonds" : "text-danger"}`}>
                  {ASSET_LABEL[i.asset]}: {i.trade >= 0 ? "Buy +" : "Reduce −"}₹{formatINR(Math.abs(i.trade))}
                  <UnitLine asset={i.asset} units={unitsFor(i.asset, i.trade, prices[latest.period])} signed />
                </span>
              ))}
            </div>
          )}
          </div>

          <div className="border-border xl:border-l xl:pl-4">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h3 className="text-base font-semibold text-fg">As of now: {live ? prettyDate(live.nifty_date > live.gold_date ? live.nifty_date : live.gold_date) : nowRow.period}</h3>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-muted hover:text-fg">
                <input type="checkbox" checked={showWithout} className="h-4 w-4 accent-[var(--color-accent)]"
                  onChange={(e) => setShowWithout(e.target.checked)} />
                Without rebalance
              </label>
            </div>
            <div className="mb-2 space-y-0.5 text-xs text-fg-muted">
              <p>
                Today: <strong className="text-fg">{todayLabel}</strong>.{" "}
                Last update: <strong className="text-fg">{dataThrough ? prettyDate(dataThrough) : nowRow.period}</strong>
                {" "}(newest data).{" "}
                {live
                  ? <>Position is valued at the latest prices (<strong className="text-fg">{liveDates}</strong>); Bonds and Cash as of the last complete month.</>
                  : <>Position is at the <strong className="text-fg">{lastClose ? prettyDate(lastClose) : nowRow.period}</strong> close, the last complete month.</>}
              </p>
              {latestPrices && (
                <label className="flex w-fit cursor-pointer items-center gap-2 py-0.5 text-sm text-fg-muted hover:text-fg">
                  <input type="checkbox" checked={useLatest} onChange={(e) => setUseLatest(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  Use today&apos;s latest prices
                </label>
              )}
              <p>
                Next rebalance due: <strong className="text-fg">{nextReview.label}</strong> ({nextReview.when}), the December month-end close.
              </p>
            </div>
            {nowModes.map((m) => (
              <div key={m.key} className="mb-3 rounded-lg border border-border bg-bg p-3 last:mb-0">
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <strong className="text-fg">{m.label}</strong>
                  <span className="tabular-nums text-fg-muted">Portfolio ₹{formatINR(m.total)}</span>
                  <span className={`font-semibold ${m.needs ? "text-danger" : "text-bonds"}`}>{m.needs ? "Rebalance needed" : "On target"}</span>
                </div>
                <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-fg-muted">
                  {m.items.map((i) => (
                    <span key={i.asset}>
                      {ASSET_LABEL[i.asset]} <strong className="text-fg">{i.actualPct.toFixed(1)}%</strong> / {i.target}%
                      <span className={Math.abs(i.drift) > tolerance ? (i.drift > 0 ? " text-danger" : " text-bonds") : ""}>
                        {" "}({i.drift >= 0 ? "+" : "−"}{Math.abs(i.drift).toFixed(1)})
                      </span>
                    </span>
                  ))}
                </div>
                {m.needs ? (
                  <div className="flex flex-wrap gap-2 text-sm tabular-nums">
                    {m.items.filter((i) => Math.abs(i.trade) >= 1).map((i) => (
                      <span key={i.asset} className={`rounded-lg border border-border bg-panel px-3 py-1.5 ${i.trade >= 0 ? "text-bonds" : "text-danger"}`}>
                        {ASSET_LABEL[i.asset]}: {i.trade >= 0 ? "Buy +" : "Reduce −"}₹{formatINR(Math.abs(i.trade))}
                        <UnitLine asset={i.asset} units={unitsFor(i.asset, i.trade, nowPx)} signed />
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-fg-muted">Every asset is within {tolerance}% of its target.</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <WithVsWithout rb={rb} bh={bh} capital={capital} weights={weights} done={done} reviews={events.length} />

      <RebalanceYearByYear rb={rb} capital={capital} weights={weights} tolerance={tolerance} action={
        <DownloadMenu
          onExcel={() => exportTablesExcel(`${rbFile}_year-by-year`, [
            { name: "Price, qty, value", table: qtyTable },
            { name: "Buy and sell", table: ybyTable },
          ])}
          onPdf={() => exportTablesPdf(`${rbFile}_year-by-year`, rbTitle, rbSub,
            [
              { heading: "Year by year with rebalancing: price, quantity and value of each asset after each December review", table: qtyTable },
              { heading: "Buy and sell at each December review (amount at the close, buy / sell, after)", table: ybyTable },
            ])}
        />
      } />
    </div>
  );
}

function DownloadMenu({ onExcel, onPdf }: { onExcel: () => void; onPdf: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-fg hover:border-accent">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Download
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4l4 4 4-4z" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-panel shadow-lg">
          <button type="button" className="block w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-bg"
            onClick={() => { setOpen(false); onExcel(); }}>Excel (.xlsx)</button>
          <button type="button" className="block w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-bg"
            onClick={() => { setOpen(false); onPdf(); }}>PDF (.pdf)</button>
        </div>
      )}
    </div>
  );
}

const LINE_KEY_ALL = [
  { name: "Gold", color: "#facc15" },
  { name: "Nifty", color: "#3b82f6" },
  { name: "Bonds", color: "#22c55e" },
  { name: "Cash", color: "#ffffff" },
  { name: "Midcap", color: "#fb923c" },
  { name: "Smallcap", color: "#2dd4bf" },
  { name: "Inflation", color: "#a78bfa" },
  { name: "Portfolio", color: "#f472b6" },
];

const LINE_KEY = LINE_KEY_ALL.filter((k) => SHOW_MIDSMALL || (k.name !== "Midcap" && k.name !== "Smallcap"));

/** Pie colours: the same as the chart lines (`text` = label colour on that fill). */
const PIE_COLORS: Record<string, { top: string; side: string; text: string }> = {
  "Equity (Nifty)": { top: "#3b82f6", side: "#1d4ed8", text: "#ffffff" },
  Gold: { top: "#facc15", side: "#ca8a04", text: "#422006" },
  Bonds: { top: "#22c55e", side: "#15803d", text: "#052e16" },
  Midcap: { top: "#fb923c", side: "#c2410c", text: "#431407" },
  Smallcap: { top: "#2dd4bf", side: "#0f766e", text: "#042f2e" },
  Cash: { top: "#ffffff", side: "#9ca3af", text: "#111827" },
};

const SHORT_NAME: Record<string, string> = { "Equity (Nifty)": "Nifty" };

/** Allocation ring: thick segments of slightly different sizes with the asset name and a big %
 *  on each, and the total amount in a circle in the middle. Colours = the chart lines. */
const fmtCagr = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

function RingPie({ slices, capital, cagr, assetCagr }: {
  slices: { name: string; value: number }[]; capital: number;
  cagr?: number;                          // the portfolio's CAGR, written in the middle
  assetCagr?: Record<string, number>;     // each asset's own CAGR, shown when the mouse is on its slice
}) {
  const S = 240, C = S / 2, R_IN = 50, R_OUT = [112, 104, 108, 100, 110, 102];
  const total = slices.reduce((t, s) => t + s.value, 0) || 1;
  const pt = (r: number, a: number) => `${C + r * Math.cos(a)} ${C + r * Math.sin(a)}`;
  const spans = slices.map((s) => (2 * Math.PI * s.value) / total);
  const starts = spans.map((_, i) => -Math.PI / 2 + spans.slice(0, i).reduce((t, x) => t + x, 0));
  // Name + big % written inside the slice: the text is shrunk until all four corners of its box
  // are inside the ring segment (between the two straight edges and the two arcs); if even the
  // name does not fit, only the % is shown, and a slice too thin for that gets no label.
  const fitLabel = (name: string, value: number, a0: number, a1: number, ro: number) => {
    const word = (SHORT_NAME[name] ?? name).toUpperCase();
    const mid = (a0 + a1) / 2;
    const inside = (x: number, y: number) => {
      const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
      if (r < R_IN + 3 || r > ro - 3) return false;
      let a = Math.atan2(dy, dx) - a0;
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const margin = 3 / r;                                   // keep ~3px away from the straight edges
      return a1 - a0 >= 2 * Math.PI - 1e-6 || (a >= margin && a <= a1 - a0 - margin);
    };
    for (const withName of [true, false]) {
      for (let k = 0; k <= 12; k++) {
        const scale = 1 - k * 0.05;
        const f1 = 13 * scale, f2 = (value >= 20 ? 26 : 21) * scale;
        if (withName ? f1 < 8.5 : f2 < 10) break;                 // too small to read: next mode / no label
        const w1 = withName ? word.length * (0.66 * f1 + 0.5) : 0;
        const w2 = (String(value).length * 0.6 + 0.9) * f2;
        const hw = Math.max(w1, w2) / 2;
        const H = (withName ? f1 + 2 : 0) + f2;
        // try the middle of the ring first, then other radii and a little to either side of the middle
        for (const off of [0, -0.12, 0.12, -0.22, 0.22]) {
          for (const dr of [0, 4, -4, 8, -8, 12, -10]) {
            const lr = (R_IN + ro) / 2 + dr, a = mid + off * (a1 - a0);
            const x = C + lr * Math.cos(a), y = C + lr * Math.sin(a);
            if ([[-1, -1], [1, -1], [-1, 1], [1, 1]].every(([sx, sy]) => inside(x + sx * hw, y + sy * H / 2)))
              return { word: withName ? word : "", x, y, f1, f2, y1: y - H / 2 + f1 / 2, y2: y + H / 2 - f2 / 2 };
          }
        }
      }
    }
    return null;
  };
  const parts = slices.map((s, i) => {
    const span = spans[i], a0 = starts[i], a1 = a0 + span;
    const ro = slices.length === 1 ? R_OUT[0] : R_OUT[i % R_OUT.length];
    const big = span > Math.PI ? 1 : 0;
    const d = span >= 2 * Math.PI - 1e-6
      ? `M${pt(ro, 0)} A${ro} ${ro} 0 1 1 ${pt(ro, Math.PI)} A${ro} ${ro} 0 1 1 ${pt(ro, 0)} Z`
      : `M${pt(R_IN, a0)} L${pt(ro, a0)} A${ro} ${ro} 0 ${big} 1 ${pt(ro, a1)} L${pt(R_IN, a1)} A${R_IN} ${R_IN} 0 ${big} 0 ${pt(R_IN, a0)} Z`;
    return { ...s, d, label: fitLabel(s.name, s.value, a0, a1, ro), pct: (100 * s.value) / total };
  });
  return (
    <svg viewBox={`-16 -16 ${S + 32} ${S + 32}`} className="h-auto w-full overflow-visible" role="img" aria-label="Allocation pie chart">
      <defs>
        <filter id="ringShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.45" />
        </filter>
      </defs>
      {parts.map((p) => (
        <path key={p.name} d={p.d} fill={PIE_COLORS[p.name].top} filter="url(#ringShadow)">
          <title>{`${p.name}: ${p.value}%${assetCagr?.[p.name] !== undefined ? ` · CAGR ${fmtCagr(assetCagr[p.name])}` : ""}`}</title>
        </path>
      ))}
      {parts.filter((p) => p.label).map((p) => (
        <g key={`t-${p.name}`} fill={PIE_COLORS[p.name].text} pointerEvents="none" textAnchor="middle" dominantBaseline="central">
          {p.label!.word && <text x={p.label!.x} y={p.label!.y1} fontSize={p.label!.f1} fontWeight={700} letterSpacing={0.5}>{p.label!.word}</text>}
          <text x={p.label!.x} y={p.label!.y2} fontSize={p.label!.f2} fontWeight={800}>{`${p.value}%`}</text>
        </g>
      ))}
      <circle cx={C} cy={C} r={R_IN - 4} fill="var(--color-bg)" stroke="var(--color-border, #2a3147)" strokeWidth={1} filter="url(#ringShadow)" />
      <text x={C} y={cagr === undefined ? C : C - 7} textAnchor="middle" dominantBaseline="central" fontSize={cagr === undefined ? 17 : 16} fontWeight={700} fill="var(--color-fg)">{`₹${formatINR(capital)}`}</text>
      {cagr !== undefined && (
        <text x={C} y={C + 13} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} fill="var(--color-fg-muted)">
          CAGR <tspan fontWeight={800} fill={cagr >= 0 ? "#4fc98a" : "#f87171"}>{fmtCagr(cagr)}</tspan>
        </text>
      )}
    </svg>
  );
}

function AllocationPie({ capital, weights, cagr, assetCagr }: {
  capital: number; weights: Weights; cagr?: number; assetCagr?: Record<string, number>;
}) {
  const slicesAll = [
    { name: "Equity (Nifty)", value: weights.equity },
    { name: "Gold", value: weights.gold },
    { name: "Bonds", value: weights.bonds },
    { name: "Midcap", value: weights.midcap },
    { name: "Smallcap", value: weights.smallcap },
    { name: "Cash", value: weights.cash },
  ];
  const slices = slicesAll.filter((s) => SHOW_MIDSMALL || (s.name !== "Midcap" && s.name !== "Smallcap"));
  return (
    <div className="mx-auto w-[300px]">
      <div>
        <RingPie slices={slices.filter((sl) => sl.value > 0)} capital={capital} cagr={cagr} assetCagr={assetCagr} />
      </div>
    </div>
  );
}

const SIDEBAR_DEFAULT = 300, SIDEBAR_MIN = 220, SIDEBAR_MAX = 560;

/** Drag handle on the sidebar's right edge: drag to make the sidebar (and so the charts) wider or
 *  narrower; double-click to go back to the default width. Arrow keys work when it has focus. */
function SidebarResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const [drag, setDrag] = useState(false);
  const clamp = (w: number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    setDrag(true);
    const move = (ev: PointerEvent) => onChange(clamp(w0 + ev.clientX - x0));
    const up = () => {
      setDrag(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={start} onDoubleClick={() => onChange(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(clamp(width - 20));
        if (e.key === "ArrowRight") onChange(clamp(width + 20));
      }}
      className="group absolute -right-3.5 top-0 hidden h-full w-3 cursor-col-resize items-center justify-center md:flex">
      <span className={`h-16 w-1 rounded-full transition-colors ${drag ? "bg-accent" : "bg-border group-hover:bg-accent group-focus-visible:bg-accent"}`} />
    </div>
  );
}

const tooltipStyle = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-grid)",
  borderRadius: 8,
  color: "var(--color-fg)",
};

/** A value for the header info bar: label above, amount, and the gain in green / red beside it. */
function InlineValue({ label, value, delta, signed, cagr }: { label: string; value: number; delta?: number; signed?: boolean; cagr?: number }) {
  const tone = (n: number) => (n >= 0 ? "text-bonds" : "text-danger");
  return (
    <div className="leading-tight">
      <div className="text-lg text-fg-muted">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-4xl font-semibold tabular-nums ${signed ? tone(value) : "text-fg"}`}>
          {signed ? (value >= 0 ? "+" : "−") : ""}₹{formatINR(Math.abs(value))}
        </span>
        {delta !== undefined && (
          <span className={`text-lg tabular-nums ${tone(delta)}`}>{delta >= 0 ? "+" : "−"}₹{formatINR(Math.abs(delta))}</span>
        )}
        {cagr !== undefined && (
          <span className="text-lg font-bold tabular-nums text-fg"><span className="text-fg-muted">CAGR</span> {cagr >= 0 ? "+" : "−"}{Math.abs(cagr).toFixed(2)}%</span>
        )}
      </div>
    </div>
  );
}

