"""
FastAPI backend for the asset-allocation backtest UI.

Serves the same calculation as asset_allocation_backtest.py over HTTP so the React
frontend in ./web can call it. The UI asks for frequency "monthly" (every month-end
is one step); "yearly" (December closes only, one step per year) is the API default
and is kept for the CLI and tests. Reuses that module's simulate() /
compute_risk_metrics() directly rather than re-implementing the loop, so the
CLI, this API, and the test suite all share one calculation core.

Run with:
    uvicorn server:app --reload --port 8000
"""

import threading
from datetime import date
from typing import Literal

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import api_data
from api_data import DataSourceError
from asset_allocation_backtest import (
    load_all_data, usable_months, simulate, compute_risk_metrics,
    weighted_average_rate, parse_period, market_data, previous_period, level_at_or_first, to_annual,
    load_inflation,
)

app = FastAPI(title="Asset Allocation Backtest API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local dev tool, no sensitive data
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- data, loaded once on first use (live API, memory only) ----------

_STATE = {}
_LOCK = threading.Lock()   # the Rebalance page sends two requests at once: load the data only once


def get_data():
    """Load every series (live from the TradeEntry API, memory only). The data is
    loaded again when a new calendar month starts, so the last complete month moves
    on without restarting the server; if that reload fails the old data is kept."""
    month = date.today().strftime("%Y-%m")
    with _LOCK:
        if _STATE.get("loaded_month") != month:
            try:
                if "data" in _STATE:
                    api_data.clear_cache()
                data = load_all_data()
            except DataSourceError as e:
                if "data" not in _STATE:
                    raise HTTPException(503, str(e))
            else:
                annual = to_annual(data)  # December-only data (frequency "yearly")
                steps = usable_months(annual, "1900", "2100")
                months = usable_months(data, "1900", "2100")
                _STATE.update(
                    monthly=data,
                    data=annual,
                    loaded_month=month,
                    min=f"{months[0][0]}-{months[0][1]:02d}",
                    max=f"{months[-1][0]}-{months[-1][1]:02d}",  # last complete month
                    yearly_max=f"{steps[-1][0]}-12",              # last December
                )
    return _STATE["data"]


# ---------- schemas ----------

class BacktestRequest(BaseModel):
    capital: float = Field(gt=0)
    equity: float = Field(ge=0, le=100)
    gold: float = Field(ge=0, le=100)
    bonds: float = Field(ge=0, le=100)
    midcap: float = Field(default=0, ge=0, le=100)
    smallcap: float = Field(default=0, ge=0, le=100)
    start: str  # "YYYY" or "YYYY-MM"
    end: str
    # "yearly" = December closes only (default); "monthly" = every month-end, for manual checking
    frequency: Literal["yearly", "monthly"] = "yearly"
    rebalance: bool = False  # annual December review
    tolerance: float = Field(default=5.0, ge=0, le=100)  # percentage-point drift band; 0 = always reset


class MonthRow(BaseModel):
    period: str
    nominal_value: float
    real_value: float
    equity_value: float
    gold_value: float
    bonds_value: float
    midcap_value: float
    smallcap_value: float
    cash_value: float


class RiskMetrics(BaseModel):
    volatility_pct: float
    max_drawdown_pct: float
    sharpe_ratio: float | None


class MarketDataRow(BaseModel):
    period: str
    nifty_close: float
    gold_per_gram: float
    bonds_ret_pct: float  # Bonds return of that period (a year)
    inflation_pct: float
    midcap_close: float
    smallcap_close: float


class RebalanceItem(BaseModel):
    asset: str
    target_pct: float
    actual_pct: float
    drift_pct: float
    actual_value: float
    target_value: float
    trade: float  # + buy, - reduce


class RebalanceEvent(BaseModel):
    period: str
    total: float
    rebalanced: bool
    items: list[RebalanceItem]


class BacktestResponse(BaseModel):
    rebalance_events: list[RebalanceEvent] = []
    rows: list[MonthRow]
    clamped_start: str
    clamped_end: str
    cash_pct: float
    risk: RiskMetrics
    risk_free_pct: float
    market_data: list[MarketDataRow]
    periods_per_year: int = 1  # 1: every row is a December close, 12: every row is a month
    buy_period: str = ""  # the December the money is put in (before the first row)
    gold_buy_per_gram: float  # December gold price at the buy period
    nifty_buy_close: float  # December Nifty close at the buy period
    midcap_buy_close: float  # December midcap level at the buy period
    smallcap_buy_close: float  # December smallcap level at the buy period


# ---------- routes ----------

@app.get("/api/range")
def get_range():
    get_data()
    return {"min": _STATE["min"], "max": _STATE["max"], "yearly_max": _STATE["yearly_max"]}


@app.post("/api/backtest", response_model=BacktestResponse)
def backtest(req: BacktestRequest):
    cash_pct = round(100 - req.equity - req.gold - req.bonds - req.midcap - req.smallcap, 4)
    if cash_pct < 0:
        raise HTTPException(400, f"Weights exceed 100% (equity+gold+bonds+midcap+smallcap="
                                  f"{req.equity + req.gold + req.bonds + req.midcap + req.smallcap})")

    try:
        start_ym = parse_period(req.start, end_of_period=False)
        end_ym = parse_period(req.end, end_of_period=True)
    except SystemExit as e:
        raise HTTPException(400, str(e))
    if start_ym > end_ym:
        raise HTTPException(400, "Start date must be before the end date.")

    get_data()
    ppy = 1 if req.frequency == "yearly" else 12
    DATA = _STATE["data"] if ppy == 1 else _STATE["monthly"]
    months = usable_months(DATA, req.start, req.end)
    if not months:
        raise HTTPException(400, "No overlapping months across all data sources in the requested range.")

    weights = {"equity": req.equity, "gold": req.gold, "bonds": req.bonds, "midcap": req.midcap,
               "smallcap": req.smallcap, "cash": cash_pct}
    events = []
    sim_rows = simulate(DATA, req.capital, weights, months, rebalance=req.rebalance,
                        tolerance=req.tolerance, events=events, periods_per_year=ppy)

    nominal_values = [r["nominal_value"] for r in sim_rows]
    risk_free = weighted_average_rate(DATA["fd"], months)
    buy = previous_period(months[0], ppy)
    # the capital is the starting value, so the first year's return counts too
    risk = compute_risk_metrics([req.capital] + nominal_values, risk_free, periods_per_year=ppy)

    return BacktestResponse(
        rows=[MonthRow(
            period=r["period"], nominal_value=r["nominal_value"], real_value=r["real_value"],
            equity_value=r["equity_value"], gold_value=r["gold_value"],
            bonds_value=r["bonds_value"], midcap_value=r["midcap_value"],
            smallcap_value=r["smallcap_value"], cash_value=r["cash_value"],
        ) for r in sim_rows],
        clamped_start=f"{months[0][0]}-{months[0][1]:02d}",
        clamped_end=f"{months[-1][0]}-{months[-1][1]:02d}",
        cash_pct=cash_pct,
        periods_per_year=ppy,
        buy_period=f"{buy[0]}-{buy[1]:02d}",
        rebalance_events=[RebalanceEvent(period=e["period"], total=e["total"], rebalanced=e["rebalanced"],
                                         items=[RebalanceItem(asset=k, **v) for k, v in e["items"].items()])
                          for e in events],
        risk=RiskMetrics(**risk),
        risk_free_pct=risk_free,
        market_data=[MarketDataRow(**r) for r in market_data(DATA, months)],
        gold_buy_per_gram=DATA["gold_level"][buy],
        nifty_buy_close=DATA["nifty_level"][buy],
        midcap_buy_close=level_at_or_first(DATA["midcap_level"], buy),
        smallcap_buy_close=level_at_or_first(DATA["smallcap_level"], buy),
    )


# =====================================================================
# Backtester: allocations (stored only through AllocationStore) and the
# daily backtest engine shared by the Buy & Hold and Rebalancing pages.
# =====================================================================

from typing import Any, Optional

from allocation_store import AllocationStore, AllocationError
from backtest_engine import run_backtest, BacktestError
import daily_data

STORE = AllocationStore()
_DAILY = {"month": None}


def _store(fn, *args):
    try:
        return fn(*args)
    except AllocationError as e:
        raise HTTPException(e.status, {"message": str(e), "errors": e.errors})


def _daily_refresh():
    """Fetch the daily series again once a new calendar month starts (like get_data())."""
    month = date.today().strftime("%Y-%m")
    if _DAILY["month"] != month:
        if _DAILY["month"] is not None:
            daily_data.clear_cache()
        _DAILY["month"] = month


class AllocationIn(BaseModel):
    name: Optional[str] = None
    weights: Optional[dict[str, float]] = None


class DuplicateIn(BaseModel):
    name: str


class PortfolioBacktestRequest(BaseModel):
    allocation_id: Optional[str] = None
    weights: Optional[dict[str, float]] = None
    start_date: str
    end_date: str
    initial_amount: float = Field(default=100000, gt=0)
    rebalance: Literal["none", "monthly", "quarterly", "yearly"] = "none"
    compare: bool = False          # also run the same allocation with rebalance = "none"
    cost_pct: float = Field(default=0, ge=0, le=10)


@app.get("/api/assets")
def list_assets():
    return _store(STORE.get_assets)


@app.get("/api/assets/ranges")
def asset_ranges():
    """First and last date with daily data for every priced asset."""
    _daily_refresh()
    out = {}
    for key, cfg in _store(STORE.get_assets).items():
        try:
            s = daily_data.load_asset(key, cfg)
        except DataSourceError as e:
            raise HTTPException(503, str(e))
        out[key] = None if s is None else {"first": min(s.prices), "last": max(s.prices)}
    return out


@app.get("/api/allocations")
def list_allocations():
    return {"assets": _store(STORE.get_assets), "allocations": _store(STORE.list_allocations)}


@app.get("/api/allocations/export")
def export_allocations():
    return _store(STORE.export_document)


@app.post("/api/allocations/import")
def import_allocations(payload: Any = Body(...)):
    return _store(STORE.import_allocations, payload)


@app.get("/api/allocations/{alloc_id}")
def get_allocation(alloc_id: str):
    return _store(STORE.get_allocation, alloc_id)


@app.post("/api/allocations", status_code=201)
def create_allocation(body: AllocationIn):
    return _store(STORE.create_allocation, body.model_dump())


@app.put("/api/allocations/{alloc_id}")
def update_allocation(alloc_id: str, body: AllocationIn):
    return _store(STORE.update_allocation, alloc_id, body.model_dump(exclude_none=True))


@app.delete("/api/allocations/{alloc_id}")
def delete_allocation(alloc_id: str):
    return _store(STORE.delete_allocation, alloc_id)


@app.post("/api/allocations/{alloc_id}/duplicate", status_code=201)
def duplicate_allocation(alloc_id: str, body: DuplicateIn):
    return _store(STORE.duplicate_allocation, alloc_id, body.name)


def _inflation_line(dates, amount):
    """What `amount` needs to grow to just keep up with prices on each date: the year's annual
    CPI rate (API, CPI_India_Annual; a year past the data repeats the latest rate) compounded
    over the calendar days between two dates, the same rates the Asset Allocation page uses."""
    from datetime import date as _d
    rates = load_inflation()
    first, last = min(rates), max(rates)
    out, value, prev = [], float(amount), None
    for ds in dates:
        cur = _d.fromisoformat(ds)
        if prev is not None:
            rate = rates[min(max(cur.year, first), last)] / 100
            value *= (1 + rate) ** ((cur - prev).days / 365)
        out.append(round(value, 2))
        prev = cur
    return out


def _pack(result):
    """Equity curve as parallel arrays (much smaller JSON than one object per day), plus the
    inflation line for the same dates."""
    eq = result.pop("equity")
    assets = list(result["weights"])
    dates = [p["date"] for p in eq]
    result["series"] = {
        "dates": dates,
        "total": [round(p["total"], 2) for p in eq],
        "values": {a: [round(p["values"][a], 2) for p in eq] for a in assets},
        "inflation": _inflation_line(dates, result["initial_amount"]),
    }
    return result


@app.post("/api/portfolio-backtest")
def portfolio_backtest(req: PortfolioBacktestRequest):
    _daily_refresh()
    assets = _store(STORE.get_assets)
    if req.allocation_id:
        alloc = _store(STORE.get_allocation, req.allocation_id)
    elif req.weights:
        from allocation_store import clean_weights
        alloc = {"id": None, "name": "Custom weights", "type": "adhoc", "weights": _store(clean_weights, req.weights, assets)}
    else:
        raise HTTPException(422, {"message": "Send allocation_id or weights.", "errors": ["Send allocation_id or weights."]})

    def run(rebalance):
        try:
            return _pack(run_backtest(alloc, req.start_date, req.end_date, req.initial_amount, rebalance,
                                      cost_pct=req.cost_pct, assets=assets))
        except BacktestError as e:
            raise HTTPException(400, {"message": str(e), "errors": [str(e)]})
        except DataSourceError as e:
            raise HTTPException(503, {"message": str(e), "errors": [str(e)]})

    out = {"allocation": {k: alloc.get(k) for k in ("id", "name", "type", "weights")}, "result": run(req.rebalance)}
    if req.compare and req.rebalance != "none":
        out["buy_and_hold"] = run("none")
    return out
