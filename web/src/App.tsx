import { Fragment, useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  exportYearlyExcel, exportYearlyPdf, exportTablesExcel, exportTablesPdf,
  type YearlyExport, type Table,
} from "./exportYearly";
import { fetchRange, fetchBacktest, type BacktestResult, type MonthRow } from "./api";
import BacktesterPage from "./backtester/BacktesterPage";
import SavePlan from "./backtester/SavePlan";
import SavedPlansPage from "./backtester/SavedPlansPage";

// Midcap and Smallcap are hidden everywhere in the UI. Flip to true to show them again
// (the backend and data still support both).
const SHOW_MIDSMALL = false;

function ymToParts(ym: string): [number, number] {
  const [y, m] = ym.split("-").map(Number);
  return [y, m];
}

type PageKey = "main" | "rebalance" | "backtester" | "plans";

const tabIcon = (paths: string[]) => (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => <path key={d} d={d} />)}
  </svg>
);

const PAGE_TABS: { key: PageKey; label: string; icon: React.ReactNode }[] = [
  { key: "main", label: "Asset Allocation", icon: tabIcon(["M12 3v9h9", "M21 12a9 9 0 1 1-9-9"]) },
  { key: "rebalance", label: "Rebalance", icon: tabIcon(["M12 4v16", "M5 8h14", "M5 8l-3 7h6z", "M19 8l-3 7h6z", "M8 20h8"]) },
  { key: "backtester", label: "Backtester", icon: tabIcon(["M3 3v18h18", "M7 15l4-6 3 4 5-8"]) },
  { key: "plans", label: "Saved plans", icon: tabIcon(["M6 3h12v18l-6-4-6 4z"]) },
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

const selectClass =
  "flex-1 rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg " +
  "focus:outline-none focus:ring-1 focus:ring-accent";

export default function App() {
  const [range, setRange] = useState<{ min: string; max: string } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const [capitalText, setCapitalText] = useState("200000");
  const capital = Number(capitalText) || 0;
  const [startYear, setStartYear] = useState<number | null>(null);
  const [startMonth, setStartMonth] = useState<number | null>(null);
  const [endYear, setEndYear] = useState<number | null>(null);
  const [endMonth, setEndMonth] = useState<number | null>(null);

  const [equity, setEquity] = useState(SHOW_MIDSMALL ? 30 : 50);
  const [gold, setGold] = useState(30);
  const [bonds, setBonds] = useState(15);
  const [midcap, setMidcap] = useState(SHOW_MIDSMALL ? 10 : 0);
  const [smallcap, setSmallcap] = useState(SHOW_MIDSMALL ? 10 : 0);
  const [page, setPage] = useState<PageKey>("main");
  const [btAlloc, setBtAlloc] = useState<string | undefined>(undefined);
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
        setStartYear(minY);
        setStartMonth(minM);
        setEndYear(maxY);
        setEndMonth(maxM);
      })
      .catch((e) => setRangeError(e.message));
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
        <header className="mb-6">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-fg">
            <svg className="h-6 w-6 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 15l4-6 3 4 5-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Asset Allocation Backtest
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            My Portfolio &mdash; vs Inflation
          </p>
          </div>
          <nav role="tablist" aria-label="Pages" className="mt-4 flex flex-wrap gap-1.5 border-b border-border">
            {PAGE_TABS.map((t) => {
              const on = page === t.key;
              return (
                <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setPage(t.key)}
                  className={`-mb-px flex cursor-pointer items-center gap-2 rounded-t-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
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
        </header>

        {rangeError && (
          <ErrorNotice>
            Could not reach the backend API at <code className="rounded bg-danger/20 px-1.5 py-0.5">/api/range</code>: {rangeError}.
            Make sure the FastAPI server is running (<code className="rounded bg-danger/20 px-1.5 py-0.5">uvicorn server:app --port 8000</code>).
          </ErrorNotice>
        )}

        {!range && !rangeError && <p className="py-10 text-center text-fg-muted">Loading data range from backend&hellip;</p>}

        {page === "backtester" && <BacktesterPage key={btAlloc ?? "default"} initialAllocId={btAlloc} />}

        {page === "plans" && (
          <SavedPlansPage
            onLoad={(w) => {
              setEquity(w.NIFTY ?? 0); setGold(w.GOLD ?? 0); setBonds(w.BOND ?? 0);
              setMidcap(0); setSmallcap(0); setPage("main");
            }}
            onBacktest={(id) => { setBtAlloc(id); setPage("backtester"); }} />
        )}

        {range && startYM && endYM && page === "rebalance" && (
          <RebalancePage capital={capital} weights={{ equity, gold, bonds, midcap, smallcap, cash }}
            start={startYM} end={endYM} frequency={frequency} />
        )}

        {range && page === "main" && startYear && startMonth && endYear && endMonth && (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[300px_1fr] xl:grid-cols-[320px_1fr]">
            <aside className="h-fit rounded-xl border border-border bg-panel p-4 md:sticky md:top-4 md:max-h-[calc(100vh-2rem)] md:overflow-y-auto md:overflow-x-hidden">
              <section>
                <h2 className="mb-3.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                  Capital &amp; Period
                </h2>
                <label className="mb-3.5 block text-sm text-fg-muted">
                  Capital (₹)
                  <input
                    type="number"
                    value={capitalText}
                    min={1}
                    step={1000}
                    onChange={(e) => setCapitalText(e.target.value)}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-fg
                      focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </label>

                <div className="grid grid-cols-2 gap-2.5">
                  <label className="block text-sm text-fg-muted">
                    {frequency === "monthly" ? "Start (first month of returns)" : "Start (buy at Dec of the year before)"}
                    <div className="mt-1.5 flex gap-1.5">
                      {frequency === "monthly" && (
                        <select className={selectClass} value={startMonth} onChange={(e) => setStartMonth(Number(e.target.value))}>
                          {MONTHS.map((m) => (
                            <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>
                          ))}
                        </select>
                      )}
                      <select className={selectClass} value={startYear} onChange={(e) => setStartYear(Number(e.target.value))}>
                        {years.map((y) => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                    </div>
                  </label>
                  <label className="block text-sm text-fg-muted">
                    {frequency === "monthly" ? "End" : "End (December)"}
                    <div className="mt-1.5 flex gap-1.5">
                      {frequency === "monthly" && (
                        <select className={selectClass} value={endMonth} onChange={(e) => setEndMonth(Number(e.target.value))}>
                          {MONTHS.map((m) => (
                            <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>
                          ))}
                        </select>
                      )}
                      <select className={selectClass} value={endYear} onChange={(e) => setEndYear(Number(e.target.value))}>
                        {years.map((y) => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                    </div>
                  </label>
                </div>

                <p className="mt-3.5 text-xs text-fg-muted">
                  {frequency === "monthly" ? (
                    <>
                      Bought once at the <strong className="text-fg">{startYM ? prevMonth(startYM) : ""}</strong> month-end price, held till the end (no selling).
                      The Start dropdown is the first month of returns.
                    </>
                  ) : (
                    <>
                      Bought once at the <strong className="text-fg">Dec {startYear ? startYear - 1 : ""}</strong> closing price, held till the end (no selling).
                      Everything is valued at December closes only, one step per year.
                    </>
                  )}
                </p>
              </section>

              <section className="mt-6 border-t border-border pt-5">
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
                  <strong className="w-11 text-right tabular-nums">{cash}%</strong>
                </div>

                <SavePlan weights={{ NIFTY: equity, GOLD: gold, BOND: bonds, CASH: cash }} />

                <AllocationPie capital={capital} weights={{ equity, gold, bonds, midcap, smallcap, cash }} />
              </section>
            </aside>

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
                  <ResultsView result={result} capital={capital} weights={{ equity, gold, bonds, midcap, smallcap, cash }} />
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
    <label className="mb-4.5 block">
      <div className="mb-1.5 flex items-center gap-2 text-sm text-fg">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorClass}`} />
        <span>{label}</span>
        <span className="ml-auto tabular-nums text-fg-muted">₹{formatINR((capital * value) / 100)}</span>
        <strong className="w-11 text-right tabular-nums">{value}%</strong>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Math.min(Number(e.target.value), max))}
        className="w-full"
      />
    </label>
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

function ResultsView({ result, capital, weights }: { result: BacktestResult; capital: number; weights: Weights }) {
  const { rows, clampedStart, clampedEnd, marketData, goldBuyPerGram, niftyBuyClose, midcapBuyClose, smallcapBuyClose, periodsPerYear } = result;
  const stepMonths = 12 / periodsPerYear; // months per row: 12 for the December-only data
  const buyMonth = result.buyPeriod || prevMonth(clampedStart);
  const buyLabel = `${buyMonth.slice(0, 4)} ${MONTH_NAMES[Number(buyMonth.slice(5, 7)) - 1]}`; // "1995 Dec"
  const niftyUnitsBought = (capital * weights.equity) / 100 / niftyBuyClose;
  const goldGramsBought = (capital * weights.gold) / 100 / goldBuyPerGram;
  const midcapUnitsBought = (capital * weights.midcap) / 100 / midcapBuyClose;
  const smallcapUnitsBought = (capital * weights.smallcap) / 100 / smallcapBuyClose;
  const final = rows[rows.length - 1];
  const yearsElapsed = rows.length / periodsPerYear;
  const cagrNominal = Math.pow(final.nominalValue / capital, 1 / yearsElapsed) - 1;
  const cagrReal = Math.pow(final.realValue / capital, 1 / yearsElapsed) - 1;
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
  const ddReal = drawdownOf(rows.map((r) => r.realValue));   // My Portfolio after inflation
  const drawdownData = priceSeries.map((p, i) => ({
    period: p.period, gold: ddGold[i], nifty: ddNifty[i], bonds: ddBonds[i], cash: ddCash[i],
    midcap: ddMidcap[i], smallcap: ddSmallcap[i], portfolio: ddPortfolio[i], real: ddReal[i],
  }));
  // Worst drawdown episode: peak month -> lowest month -> month it got back to the old peak.
  const worstEpisode = (vals: number[]) => {
    let peak = capital, peakIdx = -1;
    let best = { dd: 0, peakIdx: -1, troughIdx: -1, peakValue: capital };
    vals.forEach((v, i) => {
      if (v >= peak) { peak = v; peakIdx = i; }
      const dd = (v / peak - 1) * 100;
      if (dd < best.dd) best = { dd, peakIdx, troughIdx: i, peakValue: peak };
    });
    if (best.troughIdx < 0) return null;
    let recoverIdx = -1;
    for (let i = best.troughIdx + 1; i < vals.length; i++) {
      if (vals[i] >= best.peakValue) { recoverIdx = i; break; }
    }
    return { ...best, recoverIdx };
  };
  const label = (i: number) => (i < 0 ? "Start" : priceSeries[i].period);
  const episodesAll = [
    { name: "Gold", color: "#facc15", ep: worstEpisode(priceSeries.map((p) => p.gold100)) },
    { name: "Nifty", color: "#3b82f6", ep: worstEpisode(priceSeries.map((p) => p.nifty100)) },
    { name: "Bonds", color: "#22c55e", ep: worstEpisode(priceSeries.map((p) => p.bonds100)) },
    { name: "Cash", color: "#ffffff", ep: worstEpisode(priceSeries.map((p) => p.cash100)) },
    { name: "Midcap", color: "#fb923c", ep: worstEpisode(priceSeries.map((p) => p.midcap100)) },
    { name: "Smallcap", color: "#2dd4bf", ep: worstEpisode(priceSeries.map((p) => p.smallcap100)) },
    { name: "My Portfolio", color: "#f472b6", ep: worstEpisode(priceSeries.map((p) => p.portfolio)) },
    { name: "After inflation", color: "#a78bfa", ep: worstEpisode(rows.map((r) => r.realValue)) },
  ];
  const episodes = episodesAll.filter((e) => SHOW_MIDSMALL || (e.name !== "Midcap" && e.name !== "Smallcap"));
  const worst = (a: number[]) => Math.min(0, ...a);
  const ddChipsAll = [
    { name: "Gold", color: "#facc15", max: worst(ddGold) },
    { name: "Nifty", color: "#3b82f6", max: worst(ddNifty) },
    { name: "Bonds", color: "#22c55e", max: worst(ddBonds) },
    { name: "Cash", color: "#ffffff", max: worst(ddCash) },
    { name: "Midcap", color: "#fb923c", max: worst(ddMidcap) },
    { name: "Smallcap", color: "#2dd4bf", max: worst(ddSmallcap) },
    { name: "My Portfolio", color: "#f472b6", max: worst(ddPortfolio) },
    { name: "After inflation", color: "#a78bfa", max: worst(ddReal) },
  ];

  const ddChips = ddChipsAll.filter((e) => SHOW_MIDSMALL || (e.name !== "Midcap" && e.name !== "Smallcap"));

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
    portfolio: number; real: number; yearReturn: number; inflation: number; avgSoFar: number;
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
      portfolio: r.nominalValue, real: r.realValue,
      yearReturn: (r.nominalValue / prev - 1) * 100,
      inflation: marketData[i].inflationPct,
      avgSoFar: (Math.pow(r.nominalValue / capital, 12 / monthsSoFar) - 1) * 100,
    });
  });

  const cols: { h: string; kind?: "rupee" | "pct"; buy: number | null; units?: string; get: (y: (typeof yearly)[number]) => number }[] = [
    { h: "Nifty", kind: "rupee", buy: (capital * weights.equity) / 100, units: `${niftyUnitsBought.toFixed(2)} shares @ ${niftyBuyClose.toFixed(2)}`, get: (y) => y.nifty },
    { h: "Gold", kind: "rupee", buy: (capital * weights.gold) / 100, units: `${goldGramsBought.toFixed(2)} g @ Rs ${goldBuyPerGram.toFixed(2)}/g`, get: (y) => y.gold },
    { h: "Bonds", kind: "rupee", buy: (capital * weights.bonds) / 100, get: (y) => y.bonds },
    ...(SHOW_MIDSMALL ? [
      { h: "Midcap", kind: "rupee" as const, buy: (capital * weights.midcap) / 100, units: `${midcapUnitsBought.toFixed(2)} units`, get: (y: (typeof yearly)[number]) => y.midcap },
      { h: "Smallcap", kind: "rupee" as const, buy: (capital * weights.smallcap) / 100, units: `${smallcapUnitsBought.toFixed(2)} units`, get: (y: (typeof yearly)[number]) => y.smallcap },
    ] : []),
    { h: "Cash", kind: "rupee", buy: (capital * weights.cash) / 100, get: (y) => y.cash },
    { h: "Portfolio", kind: "rupee", buy: capital, get: (y) => y.portfolio },
    { h: "Return that year (%)", kind: "pct", buy: null, get: (y) => y.yearReturn },
    { h: "Inflation (%)", kind: "pct", buy: null, get: (y) => y.inflation },
    { h: "After inflation", kind: "rupee", buy: capital, get: (y) => y.real },
    { h: "Avg per year so far (%)", kind: "pct", buy: null, get: (y) => y.avgSoFar },
  ];
  const exportData: YearlyExport = {
    title: "Year by year",
    subtitle: `My Portfolio vs inflation, ${clampedStart} to ${clampedEnd}, starting capital Rs ${Math.round(capital).toLocaleString("en-IN")}`,
    headers: ["Year", ...cols.map((c) => c.h)],
    rows: [
      [`${buyLabel} close (buy)`, ...cols.map((c) => c.buy)],
      ["Shares (Nifty) / grams (Gold) bought @ close price", ...cols.map((c) => c.units ?? null)],
      ...yearly.map((y) => [y.months < 12 ? `${y.year} (${y.months} mo)` : y.year, ...cols.map((c) => c.get(y))]),
    ],
    kinds: Object.fromEntries(cols.map((c, i) => [i + 1, c.kind]).filter(([, k]) => k)) as YearlyExport["kinds"],
    fileName: `year-by-year_${clampedStart}_${clampedEnd}`,
  };

  return (
    <>
      <div className="mb-4.5 rounded-lg border border-border bg-panel px-3.5 py-2.5 text-sm text-fg-muted">
        Usable period (clamped to data availability): <strong className="text-fg">{clampedStart}</strong> to{" "}
        <strong className="text-fg">{clampedEnd}</strong> ({periodsPerYear === 1 ? `${rows.length} years, December closes only` : `${rows.length} months`})
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Portfolio value" value={`₹${formatINR(final.nominalValue)}`}
          delta={final.nominalValue - capital} />
        <Metric label="Value after inflation" value={`₹${formatINR(final.realValue)}`}
          delta={final.realValue - capital} />
        <Metric label="Growth per year" value={`${(cagrNominal * 100).toFixed(2)}%`} />
        <Metric label="Growth per year after inflation" value={`${(cagrReal * 100).toFixed(2)}%`} />
      </div>

      <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-fg">Portfolio vs 100% Gold, Nifty, Bonds, Cash and Inflation</h3>
      <p className="mb-2.5 text-xs text-fg-muted">
        Your portfolio against the same {"₹"}{formatINR(capital)} put 100% into one asset at {buyMonth} and held till {clampedEnd}. Inflation = what it needs to grow to just keep up with prices.
      </p>
      <div className="relative">
      <LineKey />
      <ResponsiveContainer width="100%" height={340}>
        <LineChart data={priceSeries} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
          <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} />
          <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={64} tickFormatter={(v) => formatLakh(Number(v))} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`₹${formatINR(Number(v))}`, name]} />
          <Line type="monotone" dataKey="gold100" name="100% Gold" stroke="#facc15" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="nifty100" name="100% Nifty" stroke="#3b82f6" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="bonds100" name="100% Bonds" stroke="#22c55e" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="cash100" name="100% Cash" stroke="#ffffff" dot={false} strokeWidth={2} />
          {SHOW_MIDSMALL && <Line type="monotone" dataKey="midcap100" name="100% Midcap" stroke="#fb923c" dot={false} strokeWidth={2} />}
          {SHOW_MIDSMALL && <Line type="monotone" dataKey="smallcap100" name="100% Smallcap" stroke="#2dd4bf" dot={false} strokeWidth={2} />}
          <Line type="monotone" dataKey="inflation" name="Inflation" stroke="#a78bfa" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="portfolio" name="My Portfolio" stroke="#f472b6"
            dot={false} strokeWidth={5} />
        </LineChart>
      </ResponsiveContainer>
      </div>
      </section>

      <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-fg">Drawdown: fall from the previous peak</h3>
      <p className="mb-2.5 text-xs text-fg-muted">
        How far each line was below its highest earlier value, year by year (December closes; 0% = at a new high). Purple = My Portfolio after inflation.
      </p>
      <div className="relative">
      <DrawdownKey />
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={drawdownData} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-grid)" />
          <XAxis dataKey="period" interval="preserveStartEnd" minTickGap={40} stroke="var(--color-fg-muted)" fontSize={12} />
          <YAxis stroke="var(--color-fg-muted)" fontSize={12} width={52} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [`${Number(v).toFixed(2)}%`, name]} />
          <Line type="monotone" dataKey="gold" name="Gold" stroke="#facc15" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="nifty" name="Nifty" stroke="#3b82f6" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="bonds" name="Bonds" stroke="#22c55e" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="cash" name="Cash" stroke="#ffffff" dot={false} strokeWidth={2} />
          {SHOW_MIDSMALL && <Line type="monotone" dataKey="midcap" name="Midcap" stroke="#fb923c" dot={false} strokeWidth={2} />}
          {SHOW_MIDSMALL && <Line type="monotone" dataKey="smallcap" name="Smallcap" stroke="#2dd4bf" dot={false} strokeWidth={2} />}
          <Line type="monotone" dataKey="real" name="My Portfolio after inflation" stroke="#a78bfa" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="portfolio" name="My Portfolio" stroke="#f472b6"
            dot={false} strokeWidth={5} />
        </LineChart>
      </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {ddChips.map((c) => (
          <div key={c.name} className="rounded-lg border border-border bg-bg px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <span
                className="inline-block h-3 w-5 shrink-0 rounded-[2px]"
                style={{ background: c.color }}
              />
              {c.name}
            </div>
            <div className={`mt-1 text-sm font-semibold tabular-nums ${c.max < -0.005 ? "text-danger" : "text-fg"}`}>
              {c.max < -0.005 ? `${c.max.toFixed(2)}%` : "0.00%"}
            </div>
            <div className="text-[10px] text-fg-muted">worst fall</div>
          </div>
        ))}
      </div>
      <h4 className="mb-1.5 mt-4 text-sm font-semibold text-fg">Worst fall: when it happened</h4>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[480px] border-collapse text-xs">
          <thead>
            <tr className="bg-bg uppercase tracking-wide text-fg-muted">
              <th className="whitespace-nowrap px-2 py-2 text-left font-semibold">Asset</th>
              {["Worst fall", "From peak", "Lowest", "Recovered", "Fall took", "Recovery took"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-2 text-right font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {episodes.map((e) => (
              <tr key={e.name} className="border-t border-border">
                <td className="whitespace-nowrap px-2 py-1.5 text-fg">
                  <span
                    className="mr-2 inline-block h-3 w-5 rounded-[2px] align-middle"
                    style={{ background: e.color }}
                  />
                  {e.name}
                </td>
                {e.ep ? (
                  <>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-danger">{e.ep.dd.toFixed(2)}%</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{label(e.ep.peakIdx)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{label(e.ep.troughIdx)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {e.ep.recoverIdx >= 0 ? label(e.ep.recoverIdx) : <span className="text-fg-muted">not yet</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{e.ep.troughIdx - e.ep.peakIdx} mo</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {e.ep.recoverIdx >= 0 ? `${e.ep.recoverIdx - e.ep.troughIdx} mo` : "—"}
                    </td>
                  </>
                ) : (
                  <td colSpan={6} className="px-2 py-1.5 text-right text-fg-muted">never fell below its previous high</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>

      <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <h3 className="mb-1 text-base font-semibold text-fg">Your allocation vs 100% in each asset</h3>
      <p className="mb-1 text-xs text-fg-muted">
        Bought once at {buyMonth} and held (never sold) till {clampedEnd}
      </p>
      <CompareTable capital={capital} months={rows.length * stepMonths} weights={weights} final={final}
        last={priceSeries[priceSeries.length - 1]} />
      </section>

      <section className="mt-5 rounded-xl border border-border bg-panel p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-fg">Year by year</h3>
        <DownloadMenu onExcel={() => exportYearlyExcel(exportData)} onPdf={() => exportYearlyPdf(exportData)} />
      </div>
      <p className="mb-2.5 text-xs text-fg-muted">
        First row = the amounts, and the units/grams you bought at the {buyLabel} closing price (never sold) &mdash; Nifty in shares, Gold in grams. Then the value at each year end (December close). Avg per year so far = average yearly growth from {buyLabel} up to that year.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr className="bg-bg text-left text-xs uppercase tracking-wide text-fg-muted">
              {["Year", "Nifty", "Gold", "Bonds", "Midcap", "Smallcap", "Cash", "Portfolio", "Return that year", "Inflation", "After inflation", "Avg per year so far"]
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
                <td className="px-3 py-1.5 text-right tabular-nums">₹{formatINR(y.real)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{y.avgSoFar.toFixed(2)}%</td>
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
  real: number;
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
      real: r.realValue,
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
  const nCols = assets.length + 6;
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
              {["Year", ...assets.map((a) => ASSET_LABEL[a]), "Portfolio", "Return that year", "Inflation", "After inflation", "Avg per year so far"]
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
                  <td className="px-4 py-2.5 text-right tabular-nums">₹{formatINR(y.real)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{(y.avg * 100).toFixed(2)}%</td>
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

function RebalancePage({ capital, weights, start, end, frequency }: {
  capital: number; weights: Weights; start: string; end: string; frequency: "yearly" | "monthly";
}) {
  const [tolerance, setTolerance] = useState(5);
  const [data, setData] = useState<{ rb: BacktestResult; bh: BacktestResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { equity, gold, bonds, midcap, smallcap } = weights;

  useEffect(() => {
    const controller = new AbortController();
    const base = { capital, equity, gold, bonds, midcap, smallcap, start, end, tolerance, frequency };
    setError(null);
    Promise.all([
      fetchBacktest({ ...base, rebalance: true }, controller.signal),
      fetchBacktest({ ...base, rebalance: false }, controller.signal),
    ])
      .then(([rb, bh]) => setData({ rb, bh }))
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [capital, equity, gold, bonds, midcap, smallcap, start, end, tolerance, frequency]);

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!data) return <p className="py-10 text-center text-fg-muted">Loading rebalance calculation&hellip;</p>;

  const { rb, bh } = data;
  const events = rb.rebalanceEvents;
  const done = events.filter((e) => e.rebalanced).length;
  const rbFinal = rb.rows[rb.rows.length - 1];
  const bhFinal = bh.rows[bh.rows.length - 1];
  const latest = events.length ? events[events.length - 1] : null;
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
  ybyKinds[kcol] = "rupee"; ybyKinds[kcol + 2] = "pct"; ybyKinds[kcol + 3] = "pct2";
  ybyKinds[kcol + 4] = "rupee"; ybyKinds[kcol + 5] = "pct2";
  const ybyTable: Table = {
    headers: ["Year",
      ...ybyAssets.flatMap((a) => {
        const n = ASSET_LABEL[a];
        const u = a === "equity" ? "shares" : a === "gold" ? "grams" : null;
        if (a === "bonds") return [`${n} Rs (Dec close)`, `${n} buy/sell Rs`, `${n} return that year %`];
        return u ? [`${n} Rs (Dec close)`, `${n} buy/sell Rs`, `${n} ${u} bought/sold`, `${n} ${u} after`]
                 : [`${n} Rs (Dec close)`, `${n} buy/sell Rs`];
      }),
      "Portfolio Rs", "Rebalanced", "Return that year %", "Inflation %", "After inflation Rs", "Avg per year so far %"],
    rows: [
      [`${rb.buyPeriod} (buy)`,
        ...ybyAssets.flatMap((a) => {
          const amt = (capital * (wmap[a] ?? 0)) / 100;
          const u = unitsFor(a, amt, { equity: rb.niftyBuyClose, gold: rb.goldBuyPerGram });
          if (a === "bonds") return [amt, null, null];
          return u !== null ? [amt, null, null, u] : [amt, null];
        }),
        capital, "Start", null, null, capital, null],
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
        y.total, y.partial ? "no December yet" : y.rebalanced ? "Yes" : "No", y.ret * 100, y.inflation, y.real, y.avg * 100]),
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

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="With rebalance" value={`₹${formatINR(rbFinal.nominalValue)}`} delta={rbFinal.nominalValue - capital} />
        <Metric label="Without rebalance (buy & hold)" value={`₹${formatINR(bhFinal.nominalValue)}`} delta={bhFinal.nominalValue - capital} />
        <Metric label="Rebalance gain" value={`₹${formatINR(rbFinal.nominalValue - bhFinal.nominalValue)}`}
          delta={rbFinal.nominalValue - bhFinal.nominalValue} />
        <Metric label="Rebalances done" value={`${done} of ${events.length} reviews`} />
      </div>

      {latest && (
        <section className="mb-5 rounded-xl border border-accent/50 bg-panel p-4">
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
        </section>
      )}

      <RebalanceYearByYear rb={rb} capital={capital} weights={weights} tolerance={tolerance} action={
        <DownloadMenu
          onExcel={() => exportTablesExcel(`${rbFile}_year-by-year`, [{ name: "Year by year (rebalanced)", table: ybyTable }])}
          onPdf={() => exportTablesPdf(`${rbFile}_year-by-year`, rbTitle, rbSub,
            [{ heading: "Year by year with rebalancing (amount at the Dec close, buy / sell, after)", table: ybyTable }])}
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

function CompareTable({ capital, months, weights, final, last }: {
  capital: number; months: number; weights: Weights; final: MonthRow;
  last: { gold100: number; nifty100: number; bonds100: number; cash100: number; midcap100: number; smallcap100: number };
}) {
  const cagr = (v: number) => (Math.pow(v / capital, 12 / months) - 1) * 100;
  const assetsAll = [
    { name: "Nifty (Equity)", color: "#3b82f6", pct: weights.equity, now: final.equityValue, all: last.nifty100 },
    { name: "Gold", color: "#facc15", pct: weights.gold, now: final.goldValue, all: last.gold100 },
    { name: "Bonds", color: "#22c55e", pct: weights.bonds, now: final.bondsValue, all: last.bonds100 },
    { name: "Midcap", color: "#fb923c", pct: weights.midcap, now: final.midcapValue, all: last.midcap100 },
    { name: "Smallcap", color: "#2dd4bf", pct: weights.smallcap, now: final.smallcapValue, all: last.smallcap100 },
    { name: "Cash", color: "#ffffff", pct: weights.cash, now: final.cashValue, all: last.cash100 },
  ];
  const assets = assetsAll.filter((x) => SHOW_MIDSMALL || (x.name !== "Midcap" && x.name !== "Smallcap"));
  const portfolio = final.nominalValue;
  const th = "whitespace-nowrap px-2 py-2 text-right font-semibold";
  const td = "px-2 py-1.5 text-right tabular-nums";
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        <thead>
          <tr className="bg-bg text-xs uppercase tracking-wide text-fg-muted">
            <th className="whitespace-nowrap px-2 py-2 text-left font-semibold">Asset</th>
            <th className={th}>Share</th>
            <th className={th}>Invested</th>
            <th className={th}>Value now</th>
            <th className={th}>If 100%</th>
            <th className={th}>Per yr</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((r) => (
            <tr key={r.name} className="border-t border-border">
              <td className="whitespace-nowrap px-2 py-1.5 text-fg">
                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: r.color }} />
                {r.name}
              </td>
              <td className={td}>{r.pct}%</td>
              <td className={td}>₹{formatINR((capital * r.pct) / 100)}</td>
              <td className={`${td} font-semibold`}>₹{formatINR(r.now)}</td>
              <td className={td}>₹{formatINR(r.all)}</td>
              <td className={`${td} text-fg-muted`}>{cagr(r.all).toFixed(2)}%</td>
            </tr>
          ))}
          <tr className="border-t border-border bg-accent/10">
            <td className="whitespace-nowrap px-2 py-1.5 font-semibold text-fg">
              <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: "#67e8f9" }} />
              Total (yours)
            </td>
            <td className={`${td} font-semibold`}>100%</td>
            <td className={`${td} font-semibold`}>₹{formatINR(capital)}</td>
            <td className={`${td} font-semibold`}>₹{formatINR(portfolio)}</td>
            <td className={td}>—</td>
            <td className={`${td} font-semibold`}>{cagr(portfolio).toFixed(2)}%</td>
          </tr>
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border bg-bg px-3 py-2 text-xs sm:grid-cols-4">
        {assets.map((r) => {
          const diff = portfolio - r.all;
          return (
            <div key={r.name} className="flex items-center justify-between gap-2">
              <span className="text-fg-muted">Yours vs 100% {r.name.split(" ")[0]}</span>
              <span className={`font-semibold tabular-nums ${diff >= 0 ? "text-bonds" : "text-danger"}`}>
                {diff >= 0 ? "+" : "−"}₹{formatINR(Math.abs(diff))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const LINE_KEY_ALL = [
  { name: "100% Gold", color: "#facc15" },
  { name: "100% Nifty", color: "#3b82f6" },
  { name: "100% Bonds", color: "#22c55e" },
  { name: "100% Cash", color: "#ffffff" },
  { name: "100% Midcap", color: "#fb923c" },
  { name: "100% Smallcap", color: "#2dd4bf" },
  { name: "Inflation", color: "#a78bfa" },
  { name: "My Portfolio", color: "#f472b6" },
];

const LINE_KEY = LINE_KEY_ALL.filter((k) => SHOW_MIDSMALL || (k.name !== "100% Midcap" && k.name !== "100% Smallcap"));

function DrawdownKey() {
  const items = LINE_KEY.map((k) => ({ ...k, name: k.name === "Inflation" ? "My Portfolio after inflation" : k.name.replace("100% ", "") }));
  return (
    <div className="pointer-events-none absolute left-[60px] bottom-9 z-10 rounded-md border border-border bg-bg/90 px-2.5 py-2 text-xs text-fg">
      {items.map((e) => (
        <div key={e.name} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-3 w-5 shrink-0 rounded-[2px]" style={{ background: e.color }} />
          <span className="whitespace-nowrap">{e.name}</span>
        </div>
      ))}
    </div>
  );
}

function LineKey() {
  return (
    <div className="pointer-events-none absolute left-[84px] top-2 z-10 rounded-md border border-border bg-bg/90 px-2.5 py-2 text-xs text-fg">
      {LINE_KEY.map((e) => (
        <div key={e.name} className="flex items-center gap-2 py-0.5">
          <span
            className="inline-block h-3 w-5 shrink-0 rounded-[2px]"
            style={{ background: e.color }}
          />
          <span className="whitespace-nowrap">{e.name}</span>
        </div>
      ))}
    </div>
  );
}

function AllocationPie({ capital, weights }: { capital: number; weights: Weights }) {
  const slicesAll = [
    { name: "Equity (Nifty)", value: weights.equity, color: "var(--color-equity)" },
    { name: "Gold", value: weights.gold, color: "var(--color-gold)" },
    { name: "Bonds", value: weights.bonds, color: "var(--color-bonds)" },
    { name: "Midcap", value: weights.midcap, color: "var(--color-midcap)" },
    { name: "Smallcap", value: weights.smallcap, color: "var(--color-smallcap)" },
    { name: "Cash", value: weights.cash, color: "var(--color-cash)" },
  ];
  const slices = slicesAll.filter((s) => SHOW_MIDSMALL || (s.name !== "Midcap" && s.name !== "Smallcap"));
  return (
    <div className="mt-4 rounded-lg border border-border bg-bg p-3">
      <div className="relative">
        <ResponsiveContainer width="100%" height={170}>
          <PieChart>
            <Pie data={slices.filter((sl) => sl.value > 0)} dataKey="value" nameKey="name" cx="50%" cy="50%"
              innerRadius={52} outerRadius={78} paddingAngle={2} cornerRadius={3}
              stroke="none" isAnimationActive={false}>
              {slices.filter((sl) => sl.value > 0).map((sl) => <Cell key={sl.name} fill={sl.color} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle}
              formatter={(v, name) => [`${v}% · ₹${formatINR((capital * Number(v)) / 100)}`, name]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide text-fg-muted">Total</span>
          <span className="text-sm font-semibold tabular-nums text-fg">₹{formatINR(capital)}</span>
        </div>
      </div>
      <ul className="mt-2 space-y-1.5 text-xs">
        {slices.map((sl) => (
          <li key={sl.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: sl.color }} />
            <span className="text-fg">{sl.name}</span>
            <span className="ml-auto tabular-nums text-fg-muted">₹{formatINR((capital * sl.value) / 100)}</span>
            <span className="w-9 text-right font-semibold tabular-nums text-fg">{sl.value}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const tooltipStyle = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-grid)",
  borderRadius: 8,
  color: "var(--color-fg)",
};

function Metric({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div className="rounded-xl border border-border bg-panel px-4 py-3.5">
      <div className="mb-1.5 text-xs text-fg-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-fg">{value}</div>
      {delta !== undefined && (
        <div className={`mt-1 text-xs tabular-nums ${delta >= 0 ? "text-bonds" : "text-danger"}`}>
          {delta >= 0 ? "+" : ""}₹{formatINR(delta)}
        </div>
      )}
    </div>
  );
}
