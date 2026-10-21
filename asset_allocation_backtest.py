"""
Asset allocation backtest: Nifty / Gold / Bonds / Midcap / Smallcap /
Cash (hand cash, 0% return) vs Inflation.

Data sources: everything comes live from the TradeEntry API (api_data.py, token in
the TRADEENTRY_TOKEN environment variable); nothing is read from or saved to disk:
  - Nifty 50, NIFTY Midcap 150, NIFTY Smallcap 250 : daily closes
  - MCX Gold spot (INR per 10g, 2005-06 on) and GOLDINR month-end closes (1994-12 to 2005-05), x1.03 GST
  - SBI 1-2yr FD year-end rate (Bonds 1995-2014, each year's own rate)
  - NIFTY Composite G-sec Index (Bonds from 2015)
  - India CPI inflation (annual %, 1996-2025; 1995 repeats 1996, 2026 repeats 2025)

The app (server.py, web/) works month by month: the money goes in at the month-end
close before the Start month and every month-end is one step. This CLI values
everything at December closes only (to_annual()): one step per year, Dec -> Dec.
--start/--end take "YYYY" (or "YYYY-MM"); the money is put in at the December before
the first year that falls in the range.

Bonds: until 2014 a year earns its own SBI FD year-end rate; from 2015 the year's return is the move of the NIFTY Composite
G-sec Index. Inflation is the year's annual CPI rate. Nifty and Gold use their
own real December closes, so their yearly returns are the actual Dec-to-Dec moves.

Known data gaps (see notes printed at runtime):
  - The backtest range is clamped to the months every series covers: money goes in at the Dec-1994
    close and the returns run from 1995-01 to the last complete month (inflation for 2026 repeats the 2025 rate).
    Midcap/Smallcap only start in 2005-04 and are held flat (0%) before that.
  - Any remaining N/A years in the rate tables are filled by linear
    interpolation between the nearest known years.

Usage:
  python asset_allocation_backtest.py --capital 100000 --nifty 32 --gold 32 --bonds 34 \
      --start 1996 --end 2025 --rebalance
"""

import argparse
import csv
import re

import api_data



# ---------- helpers ----------

def interpolate_gaps(series):
    """Fill None values in a {year: rate} dict via linear interpolation
    between the nearest known neighbours. Edge gaps take the nearest known value."""
    years = sorted(series)
    known = [y for y in years if series[y] is not None]
    if not known:
        raise ValueError("No known values to interpolate from")
    for y in years:
        if series[y] is not None:
            continue
        lower = max([k for k in known if k < y], default=None)
        upper = min([k for k in known if k > y], default=None)
        if lower is None:
            series[y] = series[upper]
        elif upper is None:
            series[y] = series[lower]
        else:
            frac = (y - lower) / (upper - lower)
            series[y] = series[lower] + frac * (series[upper] - series[lower])
    return series


def parse_period(s, end_of_period):
    """'2015-06' -> (2015, 6). '2015' -> (2015, 12) if end_of_period else (2015, 1)."""
    s = s.strip()
    m = re.match(r"^(\d{4})(?:-(\d{1,2}))?$", s)
    if not m:
        raise SystemExit(f"Invalid period '{s}', expected YYYY or YYYY-MM")
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else (12 if end_of_period else 1)
    if not 1 <= month <= 12:
        raise SystemExit(f"Invalid month in period '{s}'")
    return year, month


def month_range(start_ym, end_ym):
    """Inclusive list of (year, month) tuples from start_ym to end_ym."""
    (sy, sm), (ey, em) = start_ym, end_ym
    out = []
    y, m = sy, sm
    while (y, m) <= (ey, em):
        out.append((y, m))
        m += 1
        if m == 13:
            m = 1
            y += 1
    return out


# ---------- loaders ----------

def load_inflation():
    """Annual CPI inflation %, only from the TradeEntry API series
    CPI_India_Annual (1996-2025; 1995 repeats 1996). {year: rate %}. The API has no 2026 value, so 2026
    repeats the 2025 rate (carried forward)."""
    from datetime import date
    rates = {int(d[:4]): v for d, v in api_data.economic_series("CPI_India_Annual").items()}
    # The API has no value for the current year yet: the latest year's rate is carried
    # forward (at least one year, and up to the current year). Only the Monthly view
    # uses it (the December-only view needs a finished year).
    # The API starts in 1996, so 1995 (the first year of returns) repeats the 1996 rate.
    rates[min(rates) - 1] = rates[min(rates)]
    latest = max(rates)
    for y in range(latest + 1, max(latest + 1, date.today().year) + 1):
        rates[y] = rates[latest]
    return rates


def load_fd_rates():
    """Annual FD rate used for the Sharpe risk-free rate: the SBI 1-2yr year-end
    rate from the TradeEntry API (every year 1994-2025; a gap would be filled by
    linear interpolation, and years after the last value take it). {year: rate %}"""
    from datetime import date
    sbi = load_sbi_fd_rates()
    last = max(max(sbi) + 1, date.today().year)      # years after the last value take that value
    return interpolate_gaps({y: sbi.get(y) for y in range(min(sbi), last + 1)} | {y: None for y in range(1996, min(sbi))})


# Market data comes live from the TradeEntry API (see api_data.py): nothing is
# read from or saved to ./data for these series.

def load_nifty_daily():
    """Daily Nifty 50 closes from the TradeEntry API. {'YYYY-MM-DD': close}

    One known date error in the API is corrected: on Budget day 1997 (Fri 28 Feb)
    the API holds a stray 998.65 under 1997-02-28 and the real Budget-day close
    (1053.55, +6.1% on 992.75) under 1997-03-01. Nifty 500 and the Nifty50 USD
    index show the same ~6% jump on 28 Feb, so the close labelled 1997-03-01 is used
    for 1997-02-28. Nothing changes if the API stops showing the stray value."""
    closes = dict(api_data.index_closes("NIFTY"))
    real, labelled, before = "1997-02-28", "1997-03-01", "1997-02-27"
    if all(d in closes for d in (real, labelled, before)) and closes[real] < closes[before] * 1.03 < closes[labelled]:
        closes[real] = closes[labelled]
    return closes


def load_nifty_monthly():
    """Month-end Nifty close (last trading day of each month). {(year, month): close}"""
    return api_data.month_end_levels(load_nifty_daily())


def load_midcap_monthly():
    """Month-end NIFTY Midcap 150 level (last trading day's close in each
    month) from the TradeEntry API. {(year, month): month_end_close}"""
    return api_data.month_end_levels(api_data.index_closes("NIFTY MIDCAP 150"))


def load_smallcap_monthly():
    """Month-end NIFTY Smallcap 250 level (last trading day's close in each
    month) from the TradeEntry API. {(year, month): month_end_close}"""
    return api_data.month_end_levels(api_data.index_closes("NIFTY SMALLCAP 250"))


def load_sbi_fd_rates():
    """SBI 1yr-<2yr retail FD rate, year-end value per year (1999+), from the
    TradeEntry API series 'in_fixed_deposit_rate'. {year: rate %}"""
    return {int(d[:4]): v for d, v in api_data.economic_series("in_fixed_deposit_rate").items()}


def by_year_close(series, y, m):
    """Close of the last date in month m of year y in a {'YYYY-MM-DD': value} series."""
    return series[max(d for d in series if d.startswith(f"{y}-{m:02d}"))]


LAST_FD_YEAR = 2014      # the SBI FD rate up to here, the G-sec index from the next year


def load_bonds_monthly_returns():
    """Monthly Bonds returns {(year, month): return}, all from the TradeEntry API
    (see bonds_monthly_returns())."""
    return bonds_monthly_returns(load_sbi_fd_rates(), api_data.economic_series("INDIA_GSEC_COMPOSITE"))


def last_complete_month(series):
    """(year, month) of the last complete month in a {'YYYY-MM-DD': value} series: the
    latest date's month if that date is the calendar month-end, else the month before."""
    import calendar
    latest = max(series)
    y, m, d = int(latest[:4]), int(latest[5:7]), int(latest[8:10])
    return (y, m) if d == calendar.monthrange(y, m)[1] else previous_month((y, m))


def bonds_monthly_returns(sbi, gsec):
    """Monthly Bonds returns {(year, month): return} from the SBI FD rates {year: %}
    and the NIFTY Composite G-sec Index {'YYYY-MM-DD': close}.

    Bonds earn their return once a year: the whole year's return is booked in
    December and the other months are 0% (the value stays flat during the year).
      1995-2014: that year's SBI 1-2yr FD year-end rate (the API series starts at the end of 1994).
      2015 on:   the G-sec index: December close over the previous December close.
                 The index starts on 2015-10-13, so 2015 runs from that first close
                 to the December close. The current, unfinished year is booked in the
                 last complete month (from the last December close to that month)."""
    last = last_complete_month(gsec)
    rets = {}

    def book(year, months, annual):
        for m in range(1, months + 1):
            rets[(year, m)] = annual if m == months else 0.0

    for y in range(1995, LAST_FD_YEAR + 1):
        book(y, 12, sbi[y] / 100)

    by_year = {}
    for date in sorted(gsec):
        by_year.setdefault(int(date[:4]), []).append(gsec[date])
    prev = by_year[2015][0]
    y = 2015
    while (y, 12) <= last:                     # every finished year
        dec = by_year[y][-1]
        book(y, 12, dec / prev - 1)
        prev = dec
        y += 1
    if last[0] == y and last[1] >= 1:          # the current, unfinished year
        book(y, last[1], by_year_close(gsec, y, last[1]) / prev - 1)
    return rets


# India gold rate = MCX price + 3% GST. A constant factor, so it does not change
# any return; it only makes the Rs-per-gram prices (and grams bought) the India rate.
GOLD_GST = 1.03

# The API's MCX gold spot sometimes stops updating and repeats one price for weeks
# (2020-03-20 to 2020-06-02: 49 days at 40,989). Such a frozen price is replaced at
# month-end only when it is more than FROZEN_MIN_GAP away from an estimate: the
# global GOLDINR close x the MCX/GOLDINR premium, interpolated by date between the
# last good day before the freeze and the first good day after it.
FROZEN_RUN_DAYS = 10
FROZEN_MIN_GAP = 0.05


def mcx_gold_fixes(mcx, goldinr, every_day=False):
    """{date: (frozen close, estimate)} for MCX closes that sit inside a frozen run
    (FROZEN_RUN_DAYS identical closes in a row) and are more than FROZEN_MIN_GAP away from
    the global-gold estimate. Only month-end closes are checked unless every_day=True (the
    daily backtester). Nothing is returned for clean data."""
    import bisect
    from datetime import date
    days = sorted(mcx)
    gdays = sorted(goldinr)

    def global_at(d):
        i = bisect.bisect_right(gdays, d) - 1
        return goldinr[gdays[i]] if i >= 0 else None

    month_end = {}
    for d in days:
        month_end[d[:7]] = d
    fixes = {}
    i = 0
    while i < len(days):
        j = i
        while j + 1 < len(days) and mcx[days[j + 1]] == mcx[days[i]]:
            j += 1
        if j - i + 1 >= FROZEN_RUN_DAYS and i > 0 and j + 1 < len(days):
            before, after = days[i - 1], days[j + 1]
            gb, ga = global_at(before), global_at(after)
            if gb and ga:
                p0, p1 = mcx[before] / gb, mcx[after] / ga
                span = (date.fromisoformat(after) - date.fromisoformat(before)).days
                check = days[i:j + 1] if every_day else [x for x in month_end.values() if days[i] <= x <= days[j]]
                for d in check:
                    g = global_at(d)
                    if not g:
                        continue
                    t = (date.fromisoformat(d) - date.fromisoformat(before)).days / span
                    est = g * (p0 + (p1 - p0) * t)
                    if abs(mcx[d] / est - 1) > FROZEN_MIN_GAP:
                        fixes[d] = (mcx[d], est)
        i = j + 1
    return fixes


def load_mcx_daily():
    """Daily MCX gold closes (INR per 10g) from the API, with frozen month-end prices
    replaced by the estimate described above. {'YYYY-MM-DD': close}"""
    mcx = dict(api_data.mcx_gold_closes())
    for d, (_stale, est) in mcx_gold_fixes(mcx, api_data.goldinr_closes()).items():
        mcx[d] = est
    return mcx


def load_gold_monthly():
    """Month-end gold price, INR per gram, India rate: the price below x 1.03 (GST).
    {(year, month): price}, all from the
    TradeEntry API:
      - 2005-06 onward: MCX Gold spot month-end close / 10 (INR per 10g -> per gram).
      - 1994-12 .. 2005-05: the month-end close of the global GOLDINR series
        (1994-12 is where the money goes in), multiplied by a matching factor
        (MCX / GOLDINR on the last trading day of 2005-06) so the series joins
        MCX with no jump."""
    mcx = load_mcx_daily()
    goldinr = api_data.goldinr_closes()
    mcx_levels = api_data.month_end_levels(mcx)
    join = (2005, 6)
    join_date = max(d for d in mcx if d[:7] == "2005-06")
    factor = mcx[join_date] / goldinr[max(d for d in goldinr if d[:7] == "2005-06")]

    levels = {ym: close / 10.0 * factor
              for ym, close in api_data.month_end_levels(goldinr).items() if (1994, 12) <= ym < join}
    for ym, price in mcx_levels.items():
        if ym >= join:
            levels[ym] = price / 10.0
    return {ym: price * GOLD_GST for ym, price in levels.items()}


# ---------- backtest ----------

def monthly_returns_from_levels(levels):
    keys = sorted(levels)
    returns = {}
    for prev, cur in zip(keys, keys[1:]):
        returns[cur] = (levels[cur] / levels[prev]) - 1.0
    return returns


def monthly_returns_adjacent_only(levels):
    """Like monthly_returns_from_levels(), but only pairs consecutive
    calendar months -- if a source has an internal gap (e.g. Midcap's
    2021-01 -> 2024-07, no data in between), the first month back after
    the gap gets NO return recorded here (simulate() then holds that
    balance flat for it) instead of one huge fake jump compressing years
    of missing data into a single month."""
    keys = sorted(levels)
    returns = {}
    for prev, cur in zip(keys, keys[1:]):
        py, pm = prev
        expected_next = (py, pm + 1) if pm < 12 else (py + 1, 1)
        if cur != expected_next:
            continue
        returns[cur] = (levels[cur] / levels[prev]) - 1.0
    return returns


def monthly_rate_from_annual(annual_pct):
    return (1 + annual_pct / 100) ** (1 / 12) - 1


def load_all_data():
    """Load and pre-process every data source once. Pass the result into
    simulate() as many times as needed (e.g. for benchmark comparisons)
    without re-parsing the CSVs on every call."""
    # The backtest starts in 1995: money goes in at the Dec-1994 month-end close.
    nifty_level = {k: v for k, v in load_nifty_monthly().items() if k >= (1994, 12)}
    gold_level = {k: v for k, v in load_gold_monthly().items() if k >= (1994, 12)}
    midcap_level = load_midcap_monthly()
    smallcap_level = load_smallcap_monthly()
    return {
        "inflation": load_inflation(),
        "fd": load_fd_rates(),
        "nifty_level": nifty_level,
        "gold_level": gold_level,
        "midcap_level": midcap_level,
        "smallcap_level": smallcap_level,
        "nifty_ret": monthly_returns_from_levels(nifty_level),
        "gold_ret": monthly_returns_from_levels(gold_level),
        "midcap_ret": monthly_returns_adjacent_only(midcap_level),
        "smallcap_ret": monthly_returns_adjacent_only(smallcap_level),
        "bonds_ret": load_bonds_monthly_returns(),
    }


def to_annual(data):
    """December-close version of the data, used by the app: every asset is
    valued only at each December month-end, one step per year (Dec -> Dec).

    The result has the same keys as load_all_data(), but every (year, month)
    key is (year, 12): levels are the December closes, returns are Dec/Dec,
    Bonds is the year's compounded monthly returns (a year needs all 12
    months), Midcap/Smallcap have a return only when both Decembers exist
    (flat before the index starts), inflation stays the annual rate."""
    def decs(levels):
        return {(y, 12): v for (y, m), v in levels.items() if m == 12}

    def rets(levels):
        return {(y, 12): levels[(y, 12)] / levels[(y - 1, 12)] - 1
                for (y, _m) in levels if (y - 1, 12) in levels}

    nifty, gold = decs(data["nifty_level"]), decs(data["gold_level"])
    midcap, smallcap = decs(data["midcap_level"]), decs(data["smallcap_level"])
    bonds = {}
    for y in sorted({y for (y, _m) in data["bonds_ret"]}):
        if all((y, m) in data["bonds_ret"] for m in range(1, 13)):
            g = 1.0
            for m in range(1, 13):
                g *= 1 + data["bonds_ret"][(y, m)]
            bonds[(y, 12)] = g - 1
    return {
        "inflation": data["inflation"], "fd": data["fd"],
        "nifty_level": nifty, "gold_level": gold,
        "midcap_level": midcap, "smallcap_level": smallcap,
        "nifty_ret": rets(nifty), "gold_ret": rets(gold),
        "midcap_ret": rets(midcap), "smallcap_ret": rets(smallcap),
        "bonds_ret": bonds,
    }


def previous_period(ym, periods_per_year=12):
    """The period one step before ym: previous month, or previous December
    when the data is yearly (periods_per_year == 1)."""
    y, m = ym
    return (y - 1, m) if periods_per_year == 1 else previous_month(ym)


def previous_month(ym):
    """(2005, 7) -> (2005, 6); (2006, 1) -> (2005, 12)."""
    y, m = ym
    return (y, m - 1) if m > 1 else (y - 1, 12)


def usable_months(data, start_s, end_s):
    """The (year, month) tuples in [start_s, end_s] where every data source
    has a value, in chronological order. Empty if there's no overlap."""
    start_ym = parse_period(start_s, end_of_period=False)
    end_ym = parse_period(end_s, end_of_period=True)
    requested = month_range(start_ym, end_ym)
    nifty_ret, gold_ret = data["nifty_ret"], data["gold_ret"]
    fd, inflation = data["fd"], data["inflation"]
    # Midcap is NOT required here: its source has an internal gap
    # (2021-01 -> 2024-07, no data in between -- see monthly_returns_adjacent_only()).
    # Requiring it would silently skip 3+ years of real Nifty/Gold/FD months too;
    # instead simulate() holds the Midcap balance flat during its own gap.
    return [
        (y, m) for (y, m) in requested
        if (y, m) in nifty_ret and (y, m) in gold_ret and (y, m) in data["bonds_ret"]
        and y in fd and y in inflation
    ]


ASSET_KEYS = ("equity", "gold", "bonds", "midcap", "smallcap", "cash")


def simulate(data, capital, weights, months, rebalance=False, tolerance=5.0, events=None, periods_per_year=12):
    """Core month-by-month compounding, independent of CLI/API row formatting.

    weights: dict with keys 'equity', 'gold', 'bonds', 'midcap', 'smallcap',
    'cash' (percentages summing to 100, one bucket per asset -> 'equity'
    tracks Nifty, 'bonds' follows the chained FD-Index/G-sec Bonds index
    (SBI FD rate to 2011, then the G-sec index) -- 'midcap'/'smallcap'
    track the Nifty Midcap/Smallcap month-end level, 'cash' is hand
    cash and earns nothing).
    months: chronological (year, month) tuples to simulate (see usable_months()).
    rebalance: if True, the portfolio is reviewed at every December month-end
    and reset to target weights if any asset's actual % has drifted from its
    target by more than `tolerance` percentage points (tolerance=None or 0
    means always reset at the December review).
    periods_per_year: 12 for monthly data, 1 for the December-only data of
    to_annual() (inflation is then applied as the year's own rate).
    events: optional list; one dict per December review is appended with
    period, total, rebalanced and per-asset target/actual %, drift, values
    and the buy(+)/reduce(-) trade amount.

    Returns a list of dicts: period, nominal_value, real_value, equity_value,
    gold_value, bonds_value, cash_value, inflation_annual_pct,
    cum_inflation_pct. When rebalance=True, the *_value fields for a month
    already reflect the post-rebalance weights set up for the following
    month (i.e. they show where next month starts from) when a rebalance
    happened that month.

    cum_inflation_pct is cumulative price growth since the start month (0 at
    the first row), i.e. what nominal_value is being divided by (as a
    growth-factor-minus-one, in percent) to get real_value.
    """
    nifty_ret, gold_ret = data["nifty_ret"], data["gold_ret"]
    midcap_ret, smallcap_ret = data["midcap_ret"], data["smallcap_ret"]
    bonds_ret_by_month = data["bonds_ret"]
    inflation = data["inflation"]

    bal = {k: capital * weights[k] / 100 for k in ("equity", "gold", "bonds", "midcap", "smallcap", "cash")}
    cum_inflation = 1.0
    rows = []

    for (y, m) in months:
        # Bonds: SBI FD rate to 2011, then the G-sec index (see
        # load_bonds_monthly_returns()).
        bonds_ret = bonds_ret_by_month[(y, m)]
        r = {
            "equity": nifty_ret[(y, m)],
            "gold": gold_ret[(y, m)],
            "bonds": bonds_ret,
            "midcap": midcap_ret.get((y, m), 0.0),
            "smallcap": smallcap_ret.get((y, m), 0.0),
            "cash": 0.0,
        }
        r_infl = inflation[y] / 100 if periods_per_year == 1 else monthly_rate_from_annual(inflation[y])

        bal = {k: bal[k] * (1 + r[k]) for k in bal}
        total = sum(bal.values())
        cum_inflation *= (1 + r_infl)
        real_total = total / cum_inflation

        if rebalance and m == 12:
            items = {}
            for k in ASSET_KEYS:
                actual_pct = bal[k] / total * 100 if total else 0.0
                target_value = total * weights[k] / 100
                items[k] = {
                    "target_pct": weights[k], "actual_pct": actual_pct,
                    "drift_pct": actual_pct - weights[k],
                    "actual_value": bal[k], "target_value": target_value,
                    "trade": target_value - bal[k],
                }
            do_rebalance = (not tolerance) or any(abs(i["drift_pct"]) > tolerance for i in items.values())
            if events is not None:
                events.append({"period": f"{y}-{m:02d}", "total": total,
                               "rebalanced": do_rebalance, "items": items})
            if do_rebalance:
                bal = {k: total * weights[k] / 100 for k in bal}

        rows.append({
            "period": f"{y}-{m:02d}",
            "nominal_value": total,
            "real_value": real_total,
            "equity_value": bal["equity"],
            "gold_value": bal["gold"],
            "bonds_value": bal["bonds"],
            "midcap_value": bal["midcap"],
            "smallcap_value": bal["smallcap"],
            "cash_value": bal["cash"],
            "inflation_annual_pct": inflation[y],
            "cum_inflation_pct": (cum_inflation - 1) * 100,
        })

    return rows


def level_at_or_first(levels, ym):
    """Level for ym; before the first known month use the first level, inside
    a data gap use the latest earlier level."""
    if ym in levels:
        return levels[ym]
    earlier = [k for k in levels if k < ym]
    return levels[max(earlier)] if earlier else levels[min(levels)]


def market_data(data, months):
    """The actual source values for each month (live from the API): Nifty
    month-end index level, Gold month-end INR/gram, the monthly Bonds
    return (from the Bonds index -- see simulate()), and that year's
    CPI inflation rate (%). Returns a list of dicts: period, nifty_close,
    gold_per_gram, bonds_ret_pct (return of that period), inflation_pct.
    """
    midcap_level = data["midcap_level"]
    smallcap_level = data["smallcap_level"]
    rows = []
    # Before an index exists (both start 2005-04) the displayed level is held
    # at its first value, matching the flat 0% return simulate() uses.
    last_midcap = midcap_level[min(midcap_level)]
    last_smallcap = smallcap_level[min(smallcap_level)]
    for (y, m) in months:
        # Forward-fill through Midcap's/Smallcap's internal data gaps (see
        # monthly_returns_adjacent_only()): holds the displayed level flat
        # rather than erroring, matching the flat 0% return simulate() uses.
        level = midcap_level.get((y, m))
        if level is not None:
            last_midcap = level
        slevel = smallcap_level.get((y, m))
        if slevel is not None:
            last_smallcap = slevel
        bonds_ret = data["bonds_ret"][(y, m)]
        rows.append({
            "period": f"{y}-{m:02d}",
            "nifty_close": data["nifty_level"][(y, m)],
            "gold_per_gram": data["gold_level"][(y, m)],
            "bonds_ret_pct": bonds_ret * 100,
            "inflation_pct": data["inflation"][y],
            "midcap_close": last_midcap,
            "smallcap_close": last_smallcap,
        })
    return rows


def weighted_average_rate(rate_dict, months):
    """Average of rate_dict[year] over `months` ((year, month) tuples),
    weighted by how many of those months fall in each year."""
    from collections import Counter
    counts = Counter(y for (y, _m) in months)
    total = sum(counts.values())
    return sum(rate_dict[y] * c for y, c in counts.items()) / total


def compute_risk_metrics(nominal_values, risk_free_annual_pct, periods_per_year=12):
    """nominal_values: chronological nominal portfolio values, one per period
    (month, or year when periods_per_year == 1).

    Returns dict with:
      volatility_pct    - annualized standard deviation of monthly returns (%)
      max_drawdown_pct  - largest peak-to-trough decline in the period (%, <= 0)
      sharpe_ratio      - (nominal CAGR - risk-free rate) / annualized volatility,
                          or None if volatility is 0 (e.g. a single-asset,
                          zero-variance run) or fewer than 2 months are given.
    """
    if len(nominal_values) < 2:
        return {"volatility_pct": 0.0, "max_drawdown_pct": 0.0, "sharpe_ratio": None}

    monthly_returns = [nominal_values[i] / nominal_values[i - 1] - 1 for i in range(1, len(nominal_values))]
    n = len(monthly_returns)
    mean = sum(monthly_returns) / n
    variance = sum((r - mean) ** 2 for r in monthly_returns) / n
    annual_vol = (variance ** 0.5) * (periods_per_year ** 0.5)

    peak = nominal_values[0]
    max_dd = 0.0
    for v in nominal_values:
        peak = max(peak, v)
        max_dd = min(max_dd, (v - peak) / peak)

    years = (len(nominal_values) - 1) / periods_per_year  # N values span N-1 periods
    cagr = (nominal_values[-1] / nominal_values[0]) ** (1 / years) - 1
    # Guard against floating-point noise: a mathematically-constant return
    # series can yield a tiny nonzero variance (e.g. 1e-16) instead of an
    # exact 0, which would otherwise blow up into a meaningless, huge Sharpe
    # ratio rather than the "undefined" None a truly flat series should give.
    sharpe = ((cagr - risk_free_annual_pct / 100) / annual_vol) if annual_vol > 1e-9 else None

    return {
        "volatility_pct": annual_vol * 100,
        "max_drawdown_pct": max_dd * 100,
        "sharpe_ratio": sharpe,
    }


def run_backtest(capital, w_nifty, w_gold, w_bonds, w_midcap, w_smallcap, start_s, end_s, rebalance):
    data = to_annual(load_all_data())
    w_cash = round(100 - w_nifty - w_gold - w_bonds - w_midcap - w_smallcap, 4)
    if min(w_nifty, w_gold, w_bonds, w_midcap, w_smallcap) < 0:
        raise SystemExit("Weights cannot be negative.")
    if w_cash < 0:
        raise SystemExit(f"Weights exceed 100% (nifty+gold+bonds+midcap+smallcap="
                          f"{w_nifty+w_gold+w_bonds+w_midcap+w_smallcap})")

    start_ym = parse_period(start_s, end_of_period=False)
    end_ym = parse_period(end_s, end_of_period=True)
    months = usable_months(data, start_s, end_s)
    if not months:
        raise SystemExit("No overlapping months across all data sources in the requested range.")

    clamped_start, clamped_end = months[0], months[-1]
    print(f"Requested period: {start_ym[0]}-{start_ym[1]:02d} to {end_ym[0]}-{end_ym[1]:02d}")
    print(f"Usable period (December closes, limited by data availability): "
          f"{clamped_start[0]}-{clamped_start[1]:02d} to {clamped_end[0]}-{clamped_end[1]:02d}\n")

    weights = {"equity": w_nifty, "gold": w_gold, "bonds": w_bonds, "midcap": w_midcap,
               "smallcap": w_smallcap, "cash": w_cash}
    sim_rows = simulate(data, capital, weights, months, rebalance=rebalance, periods_per_year=1)
    rows = [
        {
            "period": r["period"],
            "nifty_ret_%": round(data["nifty_ret"][(y, m)] * 100, 2),
            "gold_ret_%": round(data["gold_ret"][(y, m)] * 100, 2),
            "bonds_ret_%(index)": round(data["bonds_ret"][(y, m)] * 100, 2),
            "midcap_ret_%": round(data["midcap_ret"].get((y, m), 0.0) * 100, 2),
            "smallcap_ret_%": round(data["smallcap_ret"].get((y, m), 0.0) * 100, 2),
            "inflation_%(ann)": round(data["inflation"][y], 2),
            "portfolio_value": round(r["nominal_value"], 2),
            "real_value_(today's_rupees)": round(r["real_value"], 2),
        }
        for r, (y, m) in zip(sim_rows, months)
    ]

    return rows, w_cash


def print_table(rows, limit=None):
    display_rows = rows if limit is None else rows[-limit:]
    headers = list(rows[0].keys())
    widths = [max(len(h), max(len(str(r[h])) for r in rows)) for h in headers]
    print(" | ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("-+-".join("-" * w for w in widths))
    for r in display_rows:
        print(" | ".join(str(r[h]).ljust(w) for h, w in zip(headers, widths)))


def summarize(rows, capital):
    final = rows[-1]
    total_years = len(rows)          # one row per December
    years_elapsed = total_years
    nominal_final = final["portfolio_value"]
    real_final = final["real_value_(today's_rupees)"]
    cagr_nominal = (nominal_final / capital) ** (1 / years_elapsed) - 1
    cagr_real = (real_final / capital) ** (1 / years_elapsed) - 1
    print(f"\nStarting capital : Rs {capital:,.2f}")
    print(f"Period simulated : {total_years} years, December closes "
          f"({rows[0]['period']} to {rows[-1]['period']})")
    print(f"Final nominal value : Rs {nominal_final:,.2f}  (P/L: Rs {nominal_final - capital:,.2f})")
    print(f"Final real value (inflation-adjusted): Rs {real_final:,.2f}  "
          f"(P/L: Rs {real_final - capital:,.2f})")
    print(f"Nominal CAGR : {cagr_nominal*100:.2f}%")
    print(f"Real CAGR    : {cagr_real*100:.2f}%")


def main():
    p = argparse.ArgumentParser(description="Backtest a Nifty/Gold/FD/Cash allocation against inflation.")
    p.add_argument("--capital", type=float, default=100000)
    p.add_argument("--nifty", type=float, default=32)
    p.add_argument("--gold", type=float, default=32)
    p.add_argument("--bonds", type=float, default=34,
                    help="Bonds allocation %% -- follows the chained FD-Index/G-sec Bonds index "
                         "(SBI FD rate to 2011, then the NIFTY Composite G-sec Index)")
    p.add_argument("--midcap", type=float, default=0,
                    help="Nifty Midcap allocation %% (NIFTY Midcap 150 month-end level, live from the TradeEntry API)")
    p.add_argument("--smallcap", type=float, default=0,
                    help="Nifty Smallcap allocation %% (NIFTY Smallcap 250 month-end level, live from the TradeEntry API)")
    p.add_argument("--start", type=str, default="1995",
                    help="Start period, 'YYYY' or 'YYYY-MM' (default 1995; data begins 1995-01)")
    p.add_argument("--end", type=str, default="2025",
                    help="End period, 'YYYY' or 'YYYY-MM' (e.g. 2025-07)")
    p.add_argument("--rebalance", action="store_true",
                    help="Review each December; reset to target weights if any asset drifted more than 5 points.")
    p.add_argument("--csv-out", type=str, default=None,
                    help="Optional path to write the month-by-month results as CSV.")
    p.add_argument("--show-all-rows", action="store_true",
                    help="Print every year in the console table (default: last 24 rows only).")
    args = p.parse_args()

    rows, w_cash = run_backtest(
        args.capital, args.nifty, args.gold, args.bonds, args.midcap, args.smallcap,
        args.start, args.end, args.rebalance
    )
    print(f"Allocation: Nifty {args.nifty}% / Gold {args.gold}% / Bonds {args.bonds}% / "
          f"Midcap {args.midcap}% / Smallcap {args.smallcap}% / Cash {w_cash}%")
    print(f"Rebalance (annual, December, +-5% band): {args.rebalance}\n")

    limit = None if args.show_all_rows else 24
    print_table(rows, limit=limit)
    if limit and len(rows) > limit:
        print(f"\n(showing last {limit} of {len(rows)} years; use --show-all-rows or --csv-out for the full series)")
    summarize(rows, args.capital)

    if args.csv_out:
        with open(args.csv_out, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nSaved month-by-month results to {args.csv_out}")


if __name__ == "__main__":
    main()
