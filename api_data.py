"""
Live market data from the TradeEntry API (https://www.tradeentry.in).

Nothing is saved to disk: every series is fetched when the process starts
and kept in memory only (see lru_cache). The API token is read from the
TRADEENTRY_TOKEN environment variable and is never written to any file.

    set TRADEENTRY_TOKEN=tat_...      (Windows cmd)
    $env:TRADEENTRY_TOKEN="tat_..."   (PowerShell)
    export TRADEENTRY_TOKEN=tat_...   (bash)

Endpoints used (all read-only GET, Bearer auth):
  /chart-data?symbol=NIFTY | NIFTY MIDCAP 150 | NIFTY SMALLCAP 250   daily index closes
  /mcx-chart/spot-chart?masid=2                                       MCX Gold spot, INR/10g
  /global-chart/chart?masid=6                                         GOLDINR (global gold in INR/10g)
  /economic-data/series/in_fixed_deposit_rate                         SBI 1-2yr FD rate, year-end (Bonds 1995-2011, Sharpe)
  /economic-data/series/INDIA_GSEC_COMPOSITE                          NIFTY Composite G-sec Index (Bonds 2015-2025)
  /economic-data/series/CPI_India_Annual                              India CPI inflation, annual %
"""

import os
import time
from functools import lru_cache

import requests

BASE_URL = os.environ.get("TRADEENTRY_API_BASE", "https://www.tradeentry.in/api")
TOKEN_ENV = "TRADEENTRY_TOKEN"
FIRST_DATE = "1970-01-01"
LAST_DATE = "2100-12-31"
MCX_GOLD_MASID = 2
GOLDINR_MASID = 6


class DataSourceError(RuntimeError):
    """The TradeEntry API could not supply the data (no token, network, or bad reply)."""


def _get(path, retries=3, **params):
    token = os.environ.get(TOKEN_ENV)
    if not token:
        raise DataSourceError(
            f"Set the {TOKEN_ENV} environment variable to your TradeEntry API token "
            "(it is read from the environment only and never stored in a file)."
        )
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(BASE_URL + path, params=params,
                             headers={"Authorization": f"Bearer {token}"}, timeout=120)
            if r.status_code in (401, 403):
                raise DataSourceError("TradeEntry rejected the API token (revoked or wrong).")
            r.raise_for_status()
            body = r.json()
            if body.get("success") is False:
                raise DataSourceError(f"TradeEntry error for {path}: {body}")
            return body
        except DataSourceError:
            raise
        except (requests.RequestException, ValueError) as e:
            last = e
            time.sleep(2 * attempt)
    raise DataSourceError(f"Could not reach TradeEntry for {path}: {last}")


def _closes(rows):
    """{ 'YYYY-MM-DD': close } from API rows [{time, close, ...}]."""
    return {r["time"][:10]: float(r["close"]) for r in rows if r.get("close") is not None}


@lru_cache(maxsize=None)
def index_closes(symbol):
    """Daily closes of an NSE index/symbol (price series)."""
    d = _get("/chart-data", symbol=symbol, timeframe="1D",
             from_date=FIRST_DATE, to_date=LAST_DATE, adjust="price")
    out = _closes(d["data"])
    if not out:
        raise DataSourceError(f"TradeEntry returned no data for symbol '{symbol}'.")
    return out


@lru_cache(maxsize=None)
def mcx_gold_closes():
    d = _get("/mcx-chart/spot-chart", masid=MCX_GOLD_MASID, from_date=FIRST_DATE,
             to_date=LAST_DATE, timeframe="1D")
    out = _closes(d["data"])
    if not out:
        raise DataSourceError("TradeEntry returned no MCX gold data.")
    return out


@lru_cache(maxsize=None)
def goldinr_closes():
    d = _get("/global-chart/chart", masid=GOLDINR_MASID, from_date=FIRST_DATE,
             to_date=LAST_DATE, timeframe="1D")
    out = _closes(d["data"])
    if not out:
        raise DataSourceError("TradeEntry returned no GOLDINR data.")
    return out


@lru_cache(maxsize=None)
def economic_series(code):
    """{ 'YYYY-MM-DD': value } for an economic-data series code."""
    d = _get(f"/economic-data/series/{code}")
    out = {r["time"][:10]: float(r["value"]) for r in d["data"] if r.get("value") is not None}
    if not out:
        raise DataSourceError(f"TradeEntry returned no data for series '{code}'.")
    return out


def clear_cache():
    """Forget every fetched series, so the next call pulls fresh data from the API."""
    for f in (index_closes, mcx_gold_closes, goldinr_closes, economic_series):
        f.cache_clear()


def month_end_levels(closes):
    """{(year, month): close of the last trading day in that month}."""
    levels = {}
    for date in sorted(closes):
        levels[(int(date[:4]), int(date[5:7]))] = closes[date]
    return levels
