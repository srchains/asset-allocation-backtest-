"""
Daily price series for the backtester, live from the TradeEntry API (memory only,
nothing is saved to disk). Each asset's "loader" in config/asset_allocations.json
picks the function below; a new asset needs a config entry and, if no existing
loader fits, one more entry in LOADERS.

Every loader returns a DailySeries: {date: price} plus the dates that are real
trading days of that source (the synthetic part of the Bond series is not, so it
never adds dates to the backtest calendar).

  index        an NSE index by symbol (NIFTY uses the Budget-day 1997 date fix)
  gold_india   Rs per gram, India rate: MCX Gold spot from 2005-06-06 (frozen 2020
               days replaced by the global-gold estimate); before that the global
               GOLDINR daily close x the matching factor (MCX / GOLDINR on the last
               day of 2005-06); both x 1.03 GST. Starts 1995-12-01.
  bond_chained a Bonds index (1.0 on 1995-12-29): each weekday of 1996-2014 grows
               by that year's SBI FD rate spread evenly over the year's weekdays
               (9.00% for 1996-98, the 2011 rate for 2012-14, flat in 2015 until the
               G-sec index starts); from 2015-10-13 the NIFTY Composite G-sec Index.
  fixed_rate   no prices (Cash): the engine compounds annual_return_pct daily.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache

import api_data
from asset_allocation_backtest import load_nifty_daily, load_sbi_fd_rates, mcx_gold_fixes, GOLD_GST

GOLD_START = "1995-12-01"
BOND_BASE = "1995-12-29"
GSEC_SERIES = "INDIA_GSEC_COMPOSITE"


@dataclass
class DailySeries:
    prices: dict                       # {"YYYY-MM-DD": price}
    trading_days: set = field(default_factory=set)   # dates that are real trading days of the source


@lru_cache(maxsize=None)
def load_index(symbol):
    closes = load_nifty_daily() if symbol.upper() == "NIFTY" else api_data.index_closes(symbol)
    return DailySeries(dict(closes), set(closes))


@lru_cache(maxsize=None)
def load_gold_india(_symbol=None):
    mcx = dict(api_data.mcx_gold_closes())
    goldinr = api_data.goldinr_closes()
    for d, (_stale, est) in mcx_gold_fixes(mcx, goldinr, every_day=True).items():
        mcx[d] = est
    join_m = max(d for d in mcx if d.startswith("2005-06"))
    join_g = max(d for d in goldinr if d.startswith("2005-06"))
    factor = mcx[join_m] / goldinr[join_g]
    first_mcx = min(mcx)
    prices = {}
    for d, v in goldinr.items():
        if GOLD_START <= d < first_mcx:
            prices[d] = v / 10 * factor * GOLD_GST
    for d, v in mcx.items():
        prices[d] = v / 10 * GOLD_GST
    return DailySeries(prices, set(prices))


def _weekdays(y0, m0, d0, y1, m1, d1):
    cur, end = date(y0, m0, d0), date(y1, m1, d1)
    out = []
    while cur <= end:
        if cur.weekday() < 5:
            out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


@lru_cache(maxsize=None)
def load_bond_chained(_symbol=None):
    sbi = load_sbi_fd_rates()
    gsec = api_data.economic_series(GSEC_SERIES)
    first_g = min(gsec)
    first_sbi, last_sbi = min(sbi), 2011

    def rate(y):
        if y >= 2015:
            return 0.0                       # 2015 before the G-sec index starts: flat (2015 = G-sec only)
        return sbi[min(max(y, first_sbi), last_sbi)] / 100

    prices = {BOND_BASE: 1.0}
    level = 1.0
    gy = int(first_g[:4])
    for y in range(1996, gy + 1):
        days = _weekdays(y, 1, 1, y, 12, 31)
        step = (1 + rate(y)) ** (1 / len(days))
        for d in days:
            if d >= first_g:
                break
            level *= step
            prices[d] = level
    base = gsec[first_g]
    for d in sorted(gsec):
        prices[d] = level * gsec[d] / base
    return DailySeries(prices, set(gsec))


LOADERS = {
    "index": load_index,
    "gold_india": load_gold_india,
    "bond_chained": load_bond_chained,
}


def load_asset(asset_key, asset_cfg):
    """Daily series for one priced asset (None for a fixed-rate asset such as Cash)."""
    loader = asset_cfg.get("loader", "index")
    if loader == "fixed_rate":
        return None
    if loader not in LOADERS:
        raise ValueError(f"Asset {asset_key}: unknown loader '{loader}'. Known: {', '.join(LOADERS)}, fixed_rate.")
    return LOADERS[loader](asset_cfg.get("symbol", asset_key))


def market_calendar():
    """Trading days used when an allocation holds no priced asset (Cash only): the Nifty's."""
    return load_index("NIFTY")


def clear_cache():
    for f in (load_index, load_gold_india, load_bond_chained):
        f.cache_clear()
