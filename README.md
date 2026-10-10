# Asset Allocation Backtest

Backtests a Nifty (equity) / Gold / Bonds / Midcap / Smallcap / Cash portfolio
allocation against real historical Indian market data, and compares nominal
vs. inflation-adjusted returns over any month-to-month period you pick (money in at the Dec 1995 close, returns from 1996-01 up to the last complete month, currently 2026-09).

A FastAPI backend runs the calculation over live data from the TradeEntry API; a React +
TypeScript + Tailwind frontend in `./web` lets you tune the allocation with
sliders and see results update live.

## Project structure

```
new-aaset/
├── api_data.py                    Live TradeEntry API client (Nifty, Midcap, Smallcap, Gold), memory only
├── scripts/nse_index_history.py   Stand-alone tool to download NSE index history to CSV files (not used by the app)
├── tests/                         pytest suite (calculation, data loaders, API)
├── docs/                          Project detail document (.docx)
├── asset_allocation_backtest.py   CLI tool + shared parsing/backtest logic
├── server.py                      FastAPI backend (imports the CLI module's functions)
├── allocation_store.py            Backtester: AllocationStore (allocations + asset config, JSON file, swappable)
├── daily_data.py                  Backtester: daily price series per asset (live API, memory only)
├── backtest_engine.py             Backtester: run_backtest() shared by the Buy & Hold and Rebalancing pages
├── config/asset_allocations.json  Backtester: asset config + 10 predefined and your custom allocations
├── requirements.txt                Backend Python deps
├── package.json                   Root scripts: `npm run dev` starts backend + frontend together
├── calculation.xlsx               Excel workbook mirroring the app's exact math with live formulas
└── web/                           React + TypeScript + Tailwind frontend
    ├── src/App.tsx                 Main UI: allocation sliders, period picker, charts, Rebalance page
    ├── src/exportYearly.ts         Excel / PDF download helpers
    ├── src/api.ts                  Fetches /api/range and /api/backtest from the backend
    ├── src/backtester/             Backtester pages: Buy & Hold, Rebalancing, Manage allocations (modal)
    └── vite.config.ts              Dev server + proxies /api/* to the backend on :8000
```

## Data sources

### Live from the TradeEntry API (nothing saved to disk)

Market data is fetched when the server (or the CLI) starts, by `api_data.py`,
and kept in memory only. The API token is read from the `TRADEENTRY_TOKEN`
environment variable and is never written to any file. If the variable is
missing or the site is unreachable, the backend answers 503 with a clear
message and the UI shows it.

| Series | API endpoint | Used for |
|---|---|---|
| Nifty 50 (`NIFTY`), 1991 → | `/chart-data` | Nifty month-end close |
| `NIFTY MIDCAP 150`, 2005-04 → | `/chart-data` | Midcap (hidden in the UI) |
| `NIFTY SMALLCAP 250`, 2005-04 → | `/chart-data` | Smallcap (hidden in the UI) |
| MCX Gold spot, INR/10g, 2005-06 → | `/mcx-chart/spot-chart` (masid 2) | Gold from 2005-06, × 1.03 GST = India rate |
| GOLDINR (global gold in INR/10g) | `/global-chart/chart` (masid 6) | its **month-end closes 1995-12 to 2005-05** (Dec 1995 is where the money goes in), multiplied by MCX/GOLDINR on the last trading day of 2005-06 (about 1.028) so it joins MCX with no jump |
| SBI 1yr–<2yr FD rate, year-end, 1999 → | `/economic-data/series/in_fixed_deposit_rate` | **Bonds 1996–2011** (that year's rate, added once in December; 9.00% applied to 1996–98, 9.25% (2011) to 2012–14) and the Sharpe risk-free rate (gaps interpolated) |
| India CPI inflation, annual % (`CPI_India_Annual`), 1996 → 2025 | `/economic-data/series/CPI_India_Annual` | **Inflation**, from the API (the API has no 2026 value: **2026 repeats the 2025 rate**; the latest rate is always carried forward to the current year) |
| NIFTY Composite G-sec Index (`INDIA_GSEC_COMPOSITE`), 2015-10 → | `/economic-data/series/INDIA_GSEC_COMPOSITE` | **Bonds from 2015**: December close ÷ previous December close − 1 (2015 runs from the index's first close, 2015-10-13, to December; the current year runs from the last December close to the last complete month) |

Month-end value = the close of the last trading day in the month.

There is no `data/` folder any more: the app reads nothing from disk and saves nothing.

**Known gaps**, handled explicitly rather than silently:
- Backtests run **1996-01 to the last complete month** (currently 2026-09); money goes in at the **Dec-1995 close**. Before 2005-06 Gold uses the chained
  GOLDINR month-end closes; Bonds earn one return per year (Jan–Dec), added in December: the FD rate
  until 2011 (the SBI year-end rate from the API for 1999–2011; its first
  value, 9.00%, is applied to 1996–1998), use the 2011 rate (9.25%) for 2012–2014
  (no data) and follow the G-sec index from 2015; Midcap/Smallcap did not
  exist yet, so they hold flat (0%) until 2005-04.
- The API's Midcap/Smallcap series are continuous;
  `monthly_returns_adjacent_only()` still guards against any future gap.
- The usable range is where every series has data: 1996-01 to the last complete month; the current, incomplete month is not used.
- The FD rate used for the Sharpe risk-free rate is the SBI series with the
  missing years (2012–2018, 2020–2022) filled by linear interpolation.

## How the calculation works

**The UI shows monthly data** (every month-end from 1996-01 up to the last complete month,
currently 2026-09; money goes in at the Dec-1995 close). Money is put in at the month-end before the first month and held; each
month is one step. The API can also value everything at December closes only
(`frequency: "yearly"`, `to_annual()` in `asset_allocation_backtest.py`; one step per year,
Dec to Dec, 1996-2025, buying at the Dec-1995 close). With the same buy date and no rebalancing the two
give identical values at every December (checked by a test). The December-only option was removed from the UI.

- Nifty, Gold (and Midcap/Smallcap): the return of a month = month-end close / previous month-end close - 1.
- Bonds: one return per year, Jan to Dec, added once in December; the other months are 0% (SBI FD rate to 2011,
  the G-sec index move from 2015; 2026 runs from the 2025 December close to the last complete month and is added in that month).
  December values are the same as with an equal monthly rate; months inside a year show Bonds flat.
- Inflation: the year's annual CPI rate converted to an equal monthly rate `(1 + annual)^(1/12) - 1`.
  The API has no 2026 value, so **2026 repeats the 2025 rate (2.40%)**.
- Rebalancing (optional) is checked at every December.
- Drawdown and volatility are measured on the monthly values.

- **Nifty, Gold, Midcap, Smallcap**: the real month-end close
  (one API date error is corrected: on Budget day 1997 the API shows a stray 998.65 under 1997-02-28 and the
  real close, 1053.55 (+6.1%), under 1997-03-01, so **Feb 1997 uses 1053.55**; Nifty 500 and the Nifty50 USD
  index show the same jump. Only the Feb 1997 month changes, no December value; 1995 to Apr 1996 Nifty closes are
  whole numbers in the API.)
  The API's MCX gold price is also frozen at 40,989 from 2020-03-20 to 2020-06-02 (49 days); the Mar / Apr / May 2020
  month-ends (the only ones more than 5% off) use an estimate instead: the global GOLDINR close x the MCX premium
  interpolated between 2020-03-19 and 2020-06-03 (₹4,471 / 4,768 / 4,962 per gram incl. GST instead of 4,222).
  Only those three months change; no December value, no final value, and the maximum drawdown stay the same.
  (Gold from the daily MCX series, converted from ₹/10g to ₹/gram and × 1.03 GST).
- **Bonds**: until 2011 a year earns the SBI year-end FD rate from the API
  (its first value, 9.00%, is applied to 1996–98); 2012–2014 use the 2011 rate
  (9.25%) because there is no data; from 2015 the year's return is the move of the
  NIFTY Composite G-sec Index (December close ÷ previous December close − 1; the
  index starts on 2015-10-13, so the 2015 return is only about 0.6%).
- **Cash**: hand cash — no interest, so it stays at the amount you put in.
- **Inflation**: the year's annual CPI rate from the API, as an equal monthly rate (2026 carried forward from 2025).
- **Allocation**: Equity / Gold / Bonds / Midcap / Smallcap are independent,
  Cash is always the remainder (`100 - equity - gold - bonds - midcap - smallcap`),
  so all six always sum to 100%.
- **Rebalancing** (optional): the main page is always buy-and-hold (weights
  drift with returns). Click **Rebalance →** in the header to open a separate
  Rebalance page for the same capital, dates and weights. It applies an
  annual review: every December close each asset's actual % is compared
  with its target; if any asset has drifted more than the tolerance (±5
  points by default; choose 0 = always, ±5 or ±10 on that page) the
  portfolio is reset to target weights, otherwise nothing is traded. The page
  shows value with vs without rebalancing, the latest review's buy/reduce
  amounts, and a **Year by year (with rebalancing)**
  table laid out like the main page's Year by year: the 1995 Dec buy row, then
  every December the amount in each asset at the close (Nifty shares / gold grams
  held @ that close), what is sold (red) or bought (green) with the shares / grams,
  the amount and shares after (→), the portfolio, return, inflation, after
  inflation and the average per year. Shares and grams change only in a December
  when the portfolio is rebalanced. The Excel sheet `Rebalance year by year`
  is the same table with live formulas; the buy & hold vs with-rebalance comparison
  per December is in the Excel sheet `Year-end comparison` (not on the page).
- **Real value** = nominal portfolio value divided by cumulative inflation
  since the buy December, i.e. value in today's rupees.

## Where the computing happens

All calculation runs locally on your machine; nothing is sent anywhere except the data requests to the
TradeEntry API.

- **Backend (Python / FastAPI):** `simulate()` does the month-by-month (or December-only) growth of
  Nifty, Gold, Bonds and Cash, inflation, drawdown, volatility, Sharpe and the rebalancing; a full run
  over 369 months takes a few milliseconds. The data is fetched at the first request (about 5–10 seconds)
  and kept in memory; when a new calendar month starts it is fetched again, so the last complete month
  moves on without restarting the server (if that fetch fails, the old data is kept).
- **Frontend (React):** charts, tables, CAGR, drawdown episodes, and the Excel / PDF downloads are built in the browser.
- **Excel:** the same math as live formulas.
- There is no cloud compute, GPU, machine learning or database.

## Running it

Code: https://github.com/srchains/asset-allocation-backtest- (private).

### 0. First time only: install the packages

```bash
pip install -r requirements.txt
cd web; npm install
```

### 1. Set your TradeEntry API token (every new terminal)

```bash
export TRADEENTRY_TOKEN=tat_xxxxxxxx                        # bash
$env:TRADEENTRY_TOKEN = Read-Host "TradeEntry token"        # PowerShell (asks for it, paste + Enter)
```

The token is only read from the environment; do not put it in a file (the repo is on GitHub).
Closing the terminal forgets it, so set it again in every new window.

### 2. Everything at once (recommended)

```bash
npm run dev
```

Starts the FastAPI backend on `:8000` and the Vite dev server together
(labeled `[api]` / `[web]` output). Run this from the **project root**
(`new-aaset`), not from `web/`.

### Backend and frontend separately

PowerShell window 1 (API), from the project root, after step 1:

```bash
python -m uvicorn server:app --port 8000
```

PowerShell window 2 (app), then open http://localhost:5173:

```bash
cd web; npm run dev
```

The frontend's Vite dev server proxies `/api/*` to `http://127.0.0.1:8000`
(see `web/vite.config.ts`), so no CORS setup is needed in dev.

### Command-line backtest (no UI)

```bash
python asset_allocation_backtest.py --capital 200000 --nifty 30 --gold 10 --bonds 15 \
    --midcap 20 --smallcap 20 --start 1996 --end 2026-09 --csv-out backtest_results.csv
```

(needs `TRADEENTRY_TOKEN` set, like the server)

`--start`/`--end` accept `YYYY` or `YYYY-MM`. The CLI values December closes only (one row per year, 1996–2025), like the API's `frequency: "yearly"`. Run `python asset_allocation_backtest.py --help`
for all options.

## Backend API

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/range` | GET | — | `{min, max, yearly_max}` — the first and last month all data sources cover (`1996-01`, last complete month), and the last December (`yearly_max`) |
| `/api/backtest` | POST | `{capital, equity, gold, bonds, midcap, smallcap, start, end, rebalance, tolerance, frequency}` | One `row` per December (`periods_per_year` = 1) or per month (12), `buy_period` = the period the money goes in, `clamped_start`/`clamped_end`, `cash_pct` |

`equity`, `gold`, `bonds`, `midcap`, `smallcap` are percentages (0–100);
`cash_pct` is computed server-side as the remainder. See `server.py` for the
Pydantic schemas.

## Frontend

- **Stack**: Vite + React + TypeScript + Tailwind CSS v4, charts via `recharts`.
- **Theme**: dark navy background with a cyan accent (`web/src/index.css`,
  `@theme` block), matching the TradeEntry app's color scheme.
- **Live updates**: every slider drag, period change, or capital edit
  triggers a debounced (200ms) call to `/api/backtest`, with in-flight
  request cancellation so a fast drag doesn't race stale responses.
- **Tabs** (card tabs with icons): Asset Allocation, Rebalance, Backtester, Saved plans.
- **Charts** (all use the same line model): a key box at the top-left, one line per asset for
  100% in that asset, a purple **Inflation** line (what the money needs to grow to just keep up
  with prices) and a thick pink **My Portfolio** line. Every drawdown chart also has a purple
  **My Portfolio after inflation** line with its worst fall.
- **Save as plan** (under the sliders) stores the current weights as a custom allocation; the
  **Saved plans** tab lists them with *Load in Asset Allocation*, *Open in Backtester* and *Delete*.
- **Allocation sliders**: Equity/Gold/Bonds/Midcap/Smallcap auto-constrain
  each other so their sum never exceeds 100%; Cash is shown as a read-only
  computed field.
- **Download buttons** (Excel `.xlsx` or PDF, from a "Download" dropdown on the
  section header; generated in the browser with `write-excel-file`, `jspdf` and
  `jspdf-autotable`, code in `web/src/exportYearly.ts`):
  - *Year by year* (main page): the "1995 Dec close (buy)" row (amounts, Nifty shares / gold grams bought and the
    closing price they were bought at: Nifty 909.00, Gold ₹462.42/g), and every
    year-end row; file `year-by-year_<start>_<end>`.
  - *Year by year (with rebalancing)* (Rebalance page): per year and asset the amount at
    the December close, buy / sell Rs, Nifty shares / gold grams bought or sold and held
    after, plus the portfolio, return, inflation, after inflation and average per year;
    file `..._year-by-year`.
  Rupee values have no decimals; the PDF writes `Rs` instead of the rupee
  sign because the standard PDF fonts have no rupee glyph.

## Backtester (Buy & Hold + Rebalancing)

A separate section of the app (header button **Backtester →**) that works on **daily**
closes and named allocations. The Asset Allocation page, the Rebalance page and
`calculation.xlsx` are unchanged and keep their monthly / December rules.

- **Allocations** live in `config/asset_allocations.json` (assets + allocations, weights only).
  10 predefined allocations (read-only) plus your own custom ones. Every page and endpoint
  goes through `AllocationStore` (`allocation_store.py`), never the file directly, so the
  store can later move to a database by changing only that module. Writes go to a temp file
  and are atomically renamed; a missing file is recreated with the predefined allocations.
  Validation: weights add up to 100 (±0.01), no negatives, zero weights removed, known assets
  only, at least one asset, name required, at most 50 characters and unique (any case).
- **Assets** (config `loader`, see `daily_data.py`):
  NIFTY = `NIFTY` price index (1991 →, Budget-day 1997 fix);
  GOLD = ₹/gram India rate: MCX Gold spot from 2005-06-06 (the frozen 2020 days replaced by the
  global-gold estimate) and before that GOLDINR × the matching factor, from 1995-12-01, × 1.03 GST;
  BOND = NIFTY Composite G-sec Index from 2015-10-13 and, before that, the SBI FD rate spread over
  each year's weekdays (9.00% for 1996–98, the 2011 rate for 2012–14, flat in 2015 until the index
  starts), from 1995-12-29; CASH = `annual_return_pct` (default 0) compounded over 252 trading days.
  A new asset = a config entry (and a loader in `LOADERS` if none fits).
- **Engine** (`backtest_engine.run_backtest(allocation, start, end, amount, rebalance)`,
  rebalance `none` / `monthly` / `quarterly` / `yearly`): dates are the union of the assets'
  trading days (weekdays); a missing price is carried forward for at most 5 days, otherwise the
  date is left out and logged; an asset with no data at the start gives an error with the earliest
  common date. Day 1 buys fractional units; when rebalancing, every holding is reset to its target
  on the first trading day of each new month / quarter (Jan, Apr, Jul, Oct) / year. Cost hook
  `cost_pct` (default 0). Output: daily equity curve and value per asset, final value, total return,
  CAGR = (final / initial)^(365 / days) − 1, max drawdown with its peak / trough / recovery dates,
  volatility = stdev of daily returns × √252, calendar-year returns with the best and worst year,
  each asset's start / end value and contribution, and the rebalance log (weights before → after,
  amounts and Nifty shares / gold grams bought or sold).
- **Pages**: *Buy & Hold* (allocation dropdown grouped Predefined / Custom, dates, amount; summary
  cards, one value chart (100% in each asset, Inflation, My Portfolio) with the drawdown chart
  below it (each asset, My Portfolio after inflation, My Portfolio), calendar-year table, asset
  contribution) and
  *Rebalancing* (the same plus frequency, number of rebalances, a paginated rebalance log and a
  comparison with buy & hold: side-by-side metrics and both equity curves). *Manage allocations*:
  new (live total, red unless 100), duplicate any, edit / delete custom ones (delete asks first),
  Export JSON and Import JSON (each entry validated, duplicates skipped, a summary shown).
- **Endpoints**: `GET /api/allocations`, `GET /api/allocations/{id}`, `POST /api/allocations`,
  `PUT /api/allocations/{id}`, `DELETE /api/allocations/{id}`, `POST /api/allocations/{id}/duplicate`,
  `GET /api/allocations/export`, `POST /api/allocations/import`, `GET /api/assets`,
  `GET /api/assets/ranges`, `POST /api/portfolio-backtest` (its `series` also carries `inflation`:
  the starting amount grown by the API's annual CPI rate, compounded over the calendar days)
  (`{allocation_id | weights, start_date, end_date, initial_amount, rebalance, compare}`;
  `compare: true` also returns the buy & hold run). The old `/api/backtest` is unchanged.
- Example (Balanced 4-Asset: Nifty 50 / Gold 20 / Bond 20 / Cash 10, ₹1,00,000, 29 Dec 1995 to
  30 Sep 2026): buy & hold ₹20,88,936 (CAGR 10.38%, max drawdown −44.30%, volatility 13.69%);
  quarterly rebalancing ₹20,15,744 (10.25%, −32.36%, 11.29%, 123 rebalances).
- Tests: `tests/test_allocation_store.py` (validation, read-only predefined, file recreated,
  import / export), `tests/test_backtest_engine.py` (single asset = its own return, rebalance dates
  on the first trading day, cash 0% flat and X% = compound formula, one asset: buy & hold =
  rebalancing, forward-fill limit, errors; with the token also that the daily series equal the
  monthly app's year-end values) and `tests/test_backtester_api.py` (endpoints, no token needed).

## calculation.xlsx

An Excel workbook that mirrors the app (monthly view) with live formulas: change the
yellow cells and everything recalculates. It runs month by month from 1996-01 to the last
complete month (2026-09; money goes in at the December 1995 close).

| Sheet | What it has |
|---|---|
| How it works | The steps in plain language, sheets, data sources |
| Calculator | Inputs (capital, Nifty %, Gold %, Bonds %, Cash auto, month to show), the results at that month, and what you bought at the start (Nifty shares, gold grams, Bonds and Cash money) |
| Monthly | The main calculation, one row per month: growth x, Rs values, portfolio, after inflation, drawdown, the 100%-in-one-asset lines |
| Year by year | First row **1995 Dec** = what you bought at the Dec 1995 close; then the December value of each year 1996-2026 (2026: the last month), return, inflation, average per year |
| Asset tracker | First row **1995 Dec** = the Dec 1995 closing price, shares / grams bought and value; then per year (1996 Dec ... 2026 Sep) and asset (Nifty, Gold, Bonds, Cash): price, shares / grams bought, value, target value, buy / sell, annual return, peak, drawdown, CAGR; plus the portfolio totals |
| Rebalance year by year | The app's Rebalance page table with live formulas. Tolerance cell B2 (default 5 points, same as the app; 0 = every year). Rows: 1995 Dec close (buy), every December 1996-2025, 2026 Sep. Per asset: Rs at the December close, Nifty shares / gold grams held, the price, shares / grams bought (+) / sold (-) at that price, buy / sell Rs, Rs after and shares / grams after (Bonds and Cash: Rs, buy / sell, after); then the portfolio, rebalanced yes/no, return, inflation, after inflation, average per year, the value without rebalancing and the difference; a summary below (final values, years rebalanced, shares / grams held, bought and sold) |
| Year-end comparison | Every December (and the last complete month): value with buy & hold, value with rebalancing, the difference and the action (Rebalanced / Within band); follows the tolerance in `Rebalance year by year`!B2 |
| Bonds calculation | The Bonds return of each year worked out step by step, the month it is added in (December; 2026: the last complete month), Bonds x, value for 100% Bonds and for your Bonds % |
| Gold 1995-2005 | The GOLDINR month-end closes x matching factor (MCX / GOLDINR on 2005-06-30) for every month 1995-12 to 2005-05 |
| Data | Every month's Nifty close, MCX gold close, gold Rs per gram (x 1.03 GST, cell `P1`), inflation and the Bonds return (the year's return in December, 0% in other months), with the dates used |

Rupee values have no decimals, other numbers 2 decimals. Midcap/Smallcap are hidden in the
app and are not in the workbook. 2026 inflation repeats the 2025 rate (the API has no
2026 value yet). The workbook is built by a script kept in the session scratchpad (not in
the repo) and cross-checked against the Python output with the `formulas` library. Last
check (money in at the Dec 1995 close, returns 1996-01 to 2026-09, ₹2,00,000): Nifty 50 / Gold 30 /
Bonds 15 / Cash 5 gives ₹47,36,913.19 (after inflation ₹7,53,117.99) and ₹57,09,137.63 with
rebalancing (15 December reviews); Nifty 40 / Gold 30 / Bonds 20 / Cash 10 gives ₹43,37,761.75
(after inflation ₹6,89,657.22) and ₹46,49,259.76 with rebalancing (15). Excel and Python agree to
the paisa in both cases; the first allocation buys 110.01 Nifty shares and 129.75 g of gold at the
Dec 1995 close; 100% in Bonds ends at ₹17,70,965. 2026 inflation repeats the 2025 rate.
The *Rebalance year by year* sheet (50/30/15/5) ends at ₹57,09,137.63 with tolerance 5 (15 rebalances; Nifty
112.73 shares and 129.36 g of gold at the end) and at ₹55,46,603.21 when all 30 Decembers are rebalanced
(tolerance 0); Python agrees to the paisa; without rebalancing it is ₹47,36,913.19.

## Requirements

- Python 3.11+ with `fastapi`, `uvicorn`, `requests` (see `requirements.txt`)
- A TradeEntry API token in `TRADEENTRY_TOKEN`
- Tests that use live data are skipped when `TRADEENTRY_TOKEN` is not set
- Node.js with npm (for the frontend and the root `concurrently` dev script)

```bash
pip install -r requirements.txt
npm install --prefix web
```

## Midcap / Smallcap hidden

Midcap and Smallcap are hidden in the UI (sliders, charts, tables, pie, Rebalance page) and in the Excel workbook
(their rows/columns/sheets are hidden, weights 0%). The default allocation is Nifty 50 / Gold 30 / Bonds 15 /
Cash 5 (₹2,00,000 from the Dec 1995 close to 2026-09 gives ₹47,36,913, after inflation ₹7,53,118; ₹57,09,138 with December rebalancing, 15 reviews). The backend and API fields still support them; set `SHOW_MIDSMALL = true` at the top of
`web/src/App.tsx` (and unhide them in Excel) to bring them back.

## Gold price

Gold is the **India rate in rupees per gram including 3% GST**: MCX spot (which already carries the import duty) ÷ 10 × 1.03 from 2005, and before 2005-06 the global GOLDINR month-end close ÷ 10 × a matching factor (MCX ÷ GOLDINR on 2005-06-30, about 1.028) × 1.03. `GOLD_GST` in `asset_allocation_backtest.py` (and cell `Data!P4` in the Excel) holds the 1.03; it is the same for every year, so it changes no return, only the Rs-per-gram prices and the grams bought.
