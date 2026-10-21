"""
Daily backtest engine shared by the Buy & Hold and Rebalancing pages.

    run_backtest(allocation, start_date, end_date, initial_amount, rebalance)
        rebalance: "none" | "monthly" | "quarterly" | "halfyearly" | "yearly"

Day 1 splits initial_amount by the weights and buys fractional units at that day's
close. Every day the value is sum(units x price) plus the cash balance, which grows
at annual_return_pct compounded over 252 trading days. When rebalancing, on the
first trading day of each new month / quarter (Jan, Apr, Jul, Oct) / half year (Jan, Jul) / year every
holding is reset to its target weight at that day's prices. Transaction costs are
a hook (cost_pct of the traded value, default 0).

Prices come from daily_data.py (live API) unless a `prices` dict is passed in
(the tests use that).
"""

import bisect
import math
import statistics
from datetime import date

TRADING_DAYS = 252
MAX_FILL_DAYS = 5
REBALANCE_CHOICES = ("none", "monthly", "quarterly", "halfyearly", "yearly")


class BacktestError(ValueError):
    """Bad input or no data for the request; the message is shown to the user."""


def _d(s):
    return date.fromisoformat(s)


def _period_key(d, rebalance):
    y, m = int(d[:4]), int(d[5:7])
    if rebalance == "monthly":
        return (y, m)
    if rebalance == "quarterly":
        return (y, (m - 1) // 3)
    if rebalance == "halfyearly":
        return (y, (m - 1) // 6)
    return (y,)


def align_prices(series, start_date, end_date, calendar=None, max_fill_days=MAX_FILL_DAYS):
    """Common dates for the assets in `series` ({asset: DailySeries-like with .prices and
    .trading_days}). The calendar is the union of the assets' real trading days (weekdays only)
    inside [start, end]; a missing price is carried forward for at most `max_fill_days` calendar
    days, otherwise the date is dropped and logged.
    Returns (dates, {asset: [price per date]}, log)."""
    real = set()
    for s in series.values():
        real |= {d for d in s.trading_days if start_date <= d <= end_date}
    if not real and calendar is not None:
        real = {d for d in calendar if start_date <= d <= end_date}
    if not real:                                   # only synthetic prices (e.g. Bonds before 2015)
        for s in series.values():
            real |= {d for d in s.prices if start_date <= d <= end_date}
    days = sorted(d for d in real if _d(d).weekday() < 5)
    keys = {a: sorted(s.prices) for a, s in series.items()}
    out = {a: [] for a in series}
    kept, log, filled = [], [], 0
    for d in days:
        row, ok, why = {}, True, ""
        for a, s in series.items():
            p = s.prices.get(d)
            if p is None:
                i = bisect.bisect_right(keys[a], d) - 1
                if i < 0:
                    ok, why = False, f"{a} has no data yet"
                    break
                prev = keys[a][i]
                gap = (_d(d) - _d(prev)).days
                if gap > max_fill_days:
                    ok, why = False, f"{a} has no price for {gap} days (last {prev})"
                    break
                p = s.prices[prev]
                filled += 1
            row[a] = p
        if ok:
            kept.append(d)
            for a in series:
                out[a].append(row[a])
        else:
            log.append({"date": d, "reason": why})
    return kept, out, {"excluded": log, "forward_filled": filled}


def run_backtest(allocation, start_date, end_date, initial_amount=100000.0, rebalance="none",
                 cost_pct=0.0, assets=None, prices=None, calendar=None):
    """allocation: {"weights": {...}} (an allocation from the store) or a plain weights dict.
    assets: the asset config (from the store); prices: optional {asset: DailySeries} for tests."""
    if rebalance not in REBALANCE_CHOICES:
        raise BacktestError(f"rebalance must be one of {', '.join(REBALANCE_CHOICES)}.")
    weights = allocation.get("weights", allocation) if isinstance(allocation, dict) else None
    if not weights:
        raise BacktestError("The allocation has no weights.")
    weights = {k: float(v) for k, v in weights.items() if float(v) > 0}
    if abs(sum(weights.values()) - 100) > 0.01:
        raise BacktestError(f"Weights must add up to 100 (now {sum(weights.values()):g}).")
    if not initial_amount or initial_amount <= 0:
        raise BacktestError("Initial amount must be more than 0.")
    try:
        _d(start_date), _d(end_date)
    except (TypeError, ValueError):
        raise BacktestError("Dates must be YYYY-MM-DD.")
    if start_date > end_date:
        raise BacktestError("Start date must be before the end date.")
    assets = assets or {}

    # ---- prices
    fixed = {a for a in weights if (assets.get(a) or {}).get("loader") == "fixed_rate"}
    priced = [a for a in weights if a not in fixed]
    if prices is None:
        import daily_data
        prices = {}
        for a in priced:
            if a not in assets:
                raise BacktestError(f"Unknown asset '{a}'.")
            prices[a] = daily_data.load_asset(a, assets[a])
        if calendar is None and not priced:
            calendar = daily_data.market_calendar().trading_days
    missing = [a for a in priced if a not in prices or prices[a] is None]
    if missing:
        raise BacktestError(f"No price data for {', '.join(missing)}.")
    series = {a: prices[a] for a in priced}
    # earliest date every priced asset has data
    if series:
        earliest = max(min(s.prices) for s in series.values())
        latest = min(max(s.prices) for s in series.values())
        late = [a for a in priced if min(series[a].prices) > start_date and
                (_d(min(series[a].prices)) - _d(start_date)).days > MAX_FILL_DAYS]
        if late:
            raise BacktestError(f"No data for {', '.join(late)} on {start_date}. "
                                f"The earliest date with data for all assets is {earliest}.")
        if start_date > latest:
            raise BacktestError(f"No data after {latest} for this allocation.")
    days, px, align_log = align_prices(series, start_date, end_date, calendar=calendar)
    if not days:
        raise BacktestError("No trading days with data for all assets in this period.")

    # ---- simulation
    cash_rate = {a: (1 + float((assets.get(a) or {}).get("annual_return_pct", 0)) / 100) ** (1 / TRADING_DAYS) - 1
                 for a in fixed}
    units = {a: initial_amount * weights[a] / 100 / px[a][0] for a in priced}
    cash = {a: initial_amount * weights[a] / 100 for a in fixed}
    pnl = {a: 0.0 for a in weights}
    start_value = {a: initial_amount * weights[a] / 100 for a in weights}
    equity, rebal_log, total_cost = [], [], 0.0
    prev_key = _period_key(days[0], rebalance) if rebalance != "none" else None

    for i, d in enumerate(days):
        if i > 0:
            for a in priced:
                pnl[a] += units[a] * (px[a][i] - px[a][i - 1])
            for a in fixed:
                interest = cash[a] * cash_rate[a]
                cash[a] += interest
                pnl[a] += interest
            if rebalance != "none":
                key = _period_key(d, rebalance)
                if key != prev_key:                       # first trading day of a new period
                    prev_key = key
                    values = {a: units[a] * px[a][i] for a in priced} | dict(cash)
                    total = sum(values.values())
                    targets = {a: total * weights[a] / 100 for a in weights}
                    traded = sum(abs(targets[a] - values[a]) for a in weights)
                    cost = traded * cost_pct / 100
                    total_cost += cost
                    if cost:
                        targets = {a: (total - cost) * weights[a] / 100 for a in weights}
                    entry = {"date": d, "total_before": total, "cost": cost, "assets": {}}
                    for a in weights:
                        before_u = units.get(a)
                        after_u = targets[a] / px[a][i] if a in priced else None
                        entry["assets"][a] = {
                            "weight_before": values[a] / total * 100, "weight_after": weights[a],
                            "value_before": values[a], "value_after": targets[a],
                            "traded_value": targets[a] - values[a],
                            "price": px[a][i] if a in priced else None,
                            "units_before": before_u, "units_after": after_u,
                            "units_traded": (after_u - before_u) if a in priced else None,
                        }
                    rebal_log.append(entry)
                    for a in priced:
                        units[a] = targets[a] / px[a][i]
                    for a in fixed:
                        cash[a] = targets[a]
        vals = {a: units[a] * px[a][i] for a in priced} | dict(cash)
        equity.append({"date": d, "total": sum(vals.values()), "values": vals})

    # ---- metrics
    final = equity[-1]["total"]
    n_days = max((_d(days[-1]) - _d(days[0])).days, 1)
    cagr = (final / initial_amount) ** (365 / n_days) - 1 if final > 0 else -1.0
    rets = [equity[k]["total"] / equity[k - 1]["total"] - 1 for k in range(1, len(equity))]
    vol = statistics.stdev(rets) * math.sqrt(TRADING_DAYS) if len(rets) > 1 else 0.0
    peak_v, peak_d, mdd, mdd_peak, mdd_trough = equity[0]["total"], days[0], 0.0, days[0], days[0]
    for p in equity:
        if p["total"] > peak_v:
            peak_v, peak_d = p["total"], p["date"]
        dd = p["total"] / peak_v - 1
        if dd < mdd:
            mdd, mdd_peak, mdd_trough = dd, peak_d, p["date"]
    recovered = None
    if mdd < 0:
        peak_at = next(p["total"] for p in equity if p["date"] == mdd_peak)
        recovered = next((p["date"] for p in equity if p["date"] > mdd_trough and p["total"] >= peak_at), None)

    years = []
    prev_end = initial_amount
    for k, p in enumerate(equity):
        last_of_year = k == len(equity) - 1 or equity[k + 1]["date"][:4] != p["date"][:4]
        if last_of_year:
            first_of_year = next(q["date"] for q in equity if q["date"][:4] == p["date"][:4])
            years.append({"year": int(p["date"][:4]), "start_value": prev_end, "end_value": p["total"],
                          "return_pct": (p["total"] / prev_end - 1) * 100,
                          "partial": first_of_year[5:] > "01-07" or (k == len(equity) - 1 and p["date"][5:] < "12-24"),
                          "from": first_of_year, "to": p["date"]})
            prev_end = p["total"]
    full = [y for y in years if not y["partial"]] or years
    best = max(full, key=lambda y: y["return_pct"])
    worst = min(full, key=lambda y: y["return_pct"])

    asset_rows = []
    for a in weights:
        asset_rows.append({
            "asset": a, "weight": weights[a], "start_value": start_value[a],
            "end_value": equity[-1]["values"][a],
            "pnl": pnl[a], "contribution_pct": pnl[a] / initial_amount * 100,
            "units_start": initial_amount * weights[a] / 100 / px[a][0] if a in priced else None,
            "units_end": units[a] if a in priced else None,
        })

    return {
        "weights": weights, "rebalance": rebalance, "initial_amount": initial_amount,
        "start_date": days[0], "end_date": days[-1], "requested_start": start_date, "requested_end": end_date,
        "trading_days": len(days),
        "equity": equity,
        "final_value": final,
        "total_return_pct": (final / initial_amount - 1) * 100,
        "cagr_pct": cagr * 100,
        "volatility_pct": vol * 100,
        "max_drawdown_pct": mdd * 100, "max_drawdown_peak": mdd_peak, "max_drawdown_trough": mdd_trough,
        "max_drawdown_recovered": recovered,
        "calendar_years": years, "best_year": best, "worst_year": worst,
        "assets": asset_rows,
        "rebalance_count": len(rebal_log), "rebalance_log": rebal_log, "total_cost": total_cost,
        "data_log": align_log,
    }
