"""
Tests for the FastAPI endpoints in server.py.

Run from the project root:
    python -m pytest tests/ -v
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

from server import app

client = TestClient(app)

needs_api = pytest.mark.skipif(
    not os.environ.get("TRADEENTRY_TOKEN"),
    reason="live TradeEntry data: set TRADEENTRY_TOKEN to run",
)


@needs_api
def test_range_endpoint_returns_min_max():
    res = client.get("/api/range")
    assert res.status_code == 200
    body = res.json()
    assert "min" in body and "max" in body
    assert body["min"] < body["max"]


@needs_api
def test_backtest_happy_path():
    res = client.post("/api/backtest", json={
        "capital": 100000, "equity": 32, "gold": 32, "bonds": 34,
        "start": "2005-07", "end": "2026", "rebalance": False,
    })
    assert res.status_code == 200
    body = res.json()
    assert len(body["rows"]) > 0
    assert body["cash_pct"] == pytest.approx(2.0)
    assert body["rows"][-1]["nominal_value"] == pytest.approx(1232817.42, rel=1e-4)
    assert "risk" in body and "sharpe_ratio" in body["risk"]
    assert "risk_free_pct" in body
    md = body["market_data"]
    assert len(md) == len(body["rows"])
    assert md[0]["period"] == "2005-12" and md[-1]["period"] == "2025-12"  # December closes only
    assert md[-1]["gold_per_gram"] == pytest.approx(13264.0 * 1.03, rel=1e-6)
    assert body["periods_per_year"] == 1 and body["buy_period"] == "2004-12"
    assert body["gold_buy_per_gram"] == pytest.approx(626.56 * 1.03, rel=1e-4)  # Dec 2004 close
    assert body["nifty_buy_close"] == pytest.approx(2080.5, rel=1e-4)  # Dec 2004 close
    assert len(body["rows"]) == 21 and all(r["period"].endswith("-12") for r in body["rows"])


@needs_api
def test_monthly_frequency_matches_yearly_at_every_december():
    base = {"capital": 100000, "equity": 32, "gold": 32, "bonds": 34, "rebalance": False,
            "start": "1996-01", "end": "2025-12"}
    monthly = client.post("/api/backtest", json={**base, "frequency": "monthly"}).json()
    yearly = client.post("/api/backtest", json={**base, "frequency": "yearly"}).json()
    assert monthly["periods_per_year"] == 12 and yearly["periods_per_year"] == 1
    assert monthly["buy_period"] == yearly["buy_period"] == "1995-12"
    assert len(monthly["rows"]) == 360 and len(yearly["rows"]) == 30
    by = {r["period"]: r for r in monthly["rows"]}
    for r in yearly["rows"]:  # same buy date, no rebalancing: identical December values
        assert r["nominal_value"] == pytest.approx(by[r["period"]]["nominal_value"], rel=1e-9)
        assert r["real_value"] == pytest.approx(by[r["period"]]["real_value"], rel=1e-9)


def test_backtest_rejects_overallocated_weights():
    res = client.post("/api/backtest", json={
        "capital": 100000, "equity": 60, "gold": 30, "bonds": 30,
        "start": "2005", "end": "2026", "rebalance": False,
    })
    assert res.status_code == 400
    assert "Weights exceed 100%" in res.json()["detail"]


def test_backtest_rejects_invalid_period():
    res = client.post("/api/backtest", json={
        "capital": 100000, "equity": 32, "gold": 32, "bonds": 34,
        "start": "not-a-date", "end": "2026-07", "rebalance": False,
    })
    assert res.status_code == 400


@needs_api
def test_backtest_risk_free_rate_matches_period_average_fd():
    """risk_free_pct should be the FD-rate average over the requested
    period, not a fixed constant -- changing the period should change it."""
    res_short = client.post("/api/backtest", json={
        "capital": 100000, "equity": 32, "gold": 32, "bonds": 34,
        "start": "2005", "end": "2007-12", "rebalance": False,
    })
    res_long = client.post("/api/backtest", json={
        "capital": 100000, "equity": 32, "gold": 32, "bonds": 34,
        "start": "2005", "end": "2026", "rebalance": False,
    })
    assert res_short.json()["risk_free_pct"] != pytest.approx(res_long.json()["risk_free_pct"])


@pytest.mark.parametrize("capital", [0, -1000])
def test_backtest_rejects_non_positive_capital(capital):
    res = client.post("/api/backtest", json={
        "capital": capital, "equity": 50, "gold": 30, "bonds": 15,
        "start": "2005", "end": "2026",
    })
    assert res.status_code == 422  # validation error, not a 500 crash


def test_backtest_rejects_start_after_end():
    res = client.post("/api/backtest", json={
        "capital": 200000, "equity": 50, "gold": 30, "bonds": 15,
        "start": "2020-06", "end": "2010-01",
    })
    assert res.status_code == 400
    assert "before" in res.json()["detail"]


@pytest.mark.parametrize("override", [
    {"equity": -10, "gold": 60, "bonds": 50},   # negative weight
    {"midcap": -5},
    {"rebalance": True, "tolerance": -5},        # negative band
    {"capital": 0},
])
def test_backtest_rejects_invalid_inputs(override):
    body = {"capital": 100000, "equity": 40, "gold": 30, "bonds": 20,
            "start": "2005-07", "end": "2026", "rebalance": False}
    body.update(override)
    assert client.post("/api/backtest", json=body).status_code == 422
