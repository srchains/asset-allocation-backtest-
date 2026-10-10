"""API tests for the backtester endpoints (allocations + portfolio backtest).
The store points at a temp file and the daily prices are synthetic, so no API token is needed."""
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

import server
import daily_data
from allocation_store import AllocationStore, PREDEFINED
from daily_data import DailySeries


def _weekdays(start, end):
    d, out = date.fromisoformat(start), []
    while d <= date.fromisoformat(end):
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "STORE", AllocationStore(tmp_path / "asset_allocations.json"))
    days = _weekdays("2010-01-01", "2012-12-31")
    fake = {
        "NIFTY": DailySeries({d: 100 * 1.0004 ** k for k, d in enumerate(days)}, set(days)),
        "GOLD": DailySeries({d: 50 * 1.0002 ** k for k, d in enumerate(days)}, set(days)),
        "BOND": DailySeries({d: 10 * 1.0003 ** k for k, d in enumerate(days)}, set(days)),
    }
    monkeypatch.setattr(daily_data, "load_asset", lambda key, cfg: None if cfg.get("loader") == "fixed_rate" else fake[key])
    monkeypatch.setattr(daily_data, "market_calendar", lambda: fake["NIFTY"])
    return TestClient(server.app)


def test_list_has_predefined_first(client):
    body = client.get("/api/allocations").json()
    assert [a["id"] for a in body["allocations"]] == [p[0] for p in PREDEFINED]
    assert set(body["assets"]) == {"NIFTY", "GOLD", "BOND", "CASH"}


def test_crud_flow(client):
    r = client.post("/api/allocations", json={"name": "My mix", "weights": {"NIFTY": 70, "GOLD": 30}})
    assert r.status_code == 201 and r.json()["id"] == "my_mix"
    assert client.get("/api/allocations/my_mix").json()["weights"] == {"NIFTY": 70, "GOLD": 30}
    r = client.put("/api/allocations/my_mix", json={"weights": {"NIFTY": 60, "GOLD": 40}})
    assert r.status_code == 200 and r.json()["weights"] == {"NIFTY": 60, "GOLD": 40}
    r = client.post("/api/allocations/classic_60_40/duplicate", json={"name": "My 60/40"})
    assert r.status_code == 201 and r.json()["type"] == "custom"
    assert client.delete("/api/allocations/my_mix").status_code == 200
    assert client.get("/api/allocations/my_mix").status_code == 404


def test_validation_errors_are_listed(client):
    r = client.post("/api/allocations", json={"name": "Bad", "weights": {"NIFTY": 70, "SILVER": 10}})
    assert r.status_code == 422
    assert any("SILVER" in e for e in r.json()["detail"]["errors"])


def test_predefined_is_read_only(client):
    assert client.put("/api/allocations/classic_60_40", json={"name": "x"}).status_code == 403
    assert client.delete("/api/allocations/classic_60_40").status_code == 403


def test_export_import(client):
    client.post("/api/allocations", json={"name": "Mine", "weights": {"BOND": 100}})
    doc = client.get("/api/allocations/export").json()
    client.delete("/api/allocations/mine")
    s = client.post("/api/allocations/import", json=doc).json()
    assert [a["name"] for a in s["imported"]] == ["Mine"] and len(s["skipped"]) == len(PREDEFINED)


def test_backtest_by_id_and_compare(client):
    r = client.post("/api/portfolio-backtest", json={"allocation_id": "balanced_4_asset", "start_date": "2010-01-01",
                                                      "end_date": "2012-12-31", "initial_amount": 100000,
                                                      "rebalance": "quarterly", "compare": True})
    assert r.status_code == 200, r.text
    body = r.json()
    res, bh = body["result"], body["buy_and_hold"]
    assert body["allocation"]["name"] == "Balanced 4-Asset"
    assert res["rebalance_count"] == 11 and bh["rebalance_count"] == 0
    assert len(res["series"]["dates"]) == len(res["series"]["total"]) == res["trading_days"]
    assert set(res["series"]["values"]) == {"NIFTY", "GOLD", "BOND", "CASH"}
    # Inflation line: the starting amount grown by the API's annual CPI rates (2010-2012 ~ 9-12% a year).
    infl = res["series"]["inflation"]
    assert len(infl) == len(res["series"]["dates"]) and infl[0] == 100000
    assert all(b >= a for a, b in zip(infl, infl[1:])) and 1.25 < infl[-1] / infl[0] < 1.45


def test_backtest_with_weights_and_errors(client):
    ok = client.post("/api/portfolio-backtest", json={"weights": {"NIFTY": 100}, "start_date": "2010-01-01", "end_date": "2011-12-31"})
    assert ok.status_code == 200 and ok.json()["result"]["final_value"] > 100000
    bad = client.post("/api/portfolio-backtest", json={"weights": {"NIFTY": 100}, "start_date": "2005-01-01", "end_date": "2011-12-31"})
    assert bad.status_code == 400 and "earliest date" in bad.json()["detail"]["message"]
    bad = client.post("/api/portfolio-backtest", json={"weights": {"NIFTY": 50}, "start_date": "2010-01-01", "end_date": "2011-12-31"})
    assert bad.status_code == 422
    bad = client.post("/api/portfolio-backtest", json={"allocation_id": "nope", "start_date": "2010-01-01", "end_date": "2011-12-31"})
    assert bad.status_code == 404


def test_cash_only_uses_market_calendar(client):
    r = client.post("/api/portfolio-backtest", json={"weights": {"CASH": 100}, "start_date": "2010-01-01", "end_date": "2010-12-31"})
    assert r.status_code == 200 and r.json()["result"]["final_value"] == pytest.approx(100000)
