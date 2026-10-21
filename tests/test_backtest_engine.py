"""Tests for backtest_engine.py (synthetic prices) and daily_data.py (live API, needs the token)."""
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from _helpers import weekdays

from backtest_engine import run_backtest, align_prices, BacktestError, TRADING_DAYS
from daily_data import DailySeries

ASSETS = {
    "NIFTY": {"loader": "index"}, "GOLD": {"loader": "gold_india"}, "BOND": {"loader": "bond_chained"},
    "CASH": {"loader": "fixed_rate", "annual_return_pct": 0},
}


def series(days, start_price=100.0, daily=0.0005, wiggle=0.0):
    p, prices = start_price, {}
    for k, d in enumerate(days):
        prices[d] = p
        p *= 1 + daily + (wiggle if k % 2 else -wiggle)
    return DailySeries(prices, set(days))


@pytest.fixture
def market():
    days = weekdays("2019-12-02", "2022-12-30", skip={"2020-01-01", "2021-01-01", "2020-04-01", "2021-10-01"})
    return days, {"NIFTY": series(days, 100, 0.0006, 0.01), "GOLD": series(days, 50, 0.0003, 0.004),
                  "BOND": series(days, 10, 0.0002)}


def run(market, weights, rebalance="none", start="2020-01-01", end="2022-12-31", assets=ASSETS, amount=100000.0, **kw):
    return run_backtest({"weights": weights}, start, end, amount, rebalance, assets=assets, prices=market[1], **kw)


class TestEngine:
    def test_single_asset_buy_and_hold_equals_asset_return(self, market):
        r = run(market, {"NIFTY": 100})
        p = market[1]["NIFTY"].prices
        first, last = r["start_date"], r["end_date"]
        assert r["final_value"] == pytest.approx(100000 * p[last] / p[first])
        assert r["total_return_pct"] == pytest.approx((p[last] / p[first] - 1) * 100)

    def test_single_asset_rebalancing_equals_buy_and_hold(self, market):
        bh = run(market, {"GOLD": 100})
        for freq in ("monthly", "quarterly", "yearly"):
            rb = run(market, {"GOLD": 100}, freq)
            assert rb["final_value"] == pytest.approx(bh["final_value"])
            assert [e["total"] for e in rb["equity"]] == pytest.approx([e["total"] for e in bh["equity"]])

    def test_day_one_split_and_units(self, market):
        r = run(market, {"NIFTY": 60, "BOND": 40})
        first = r["start_date"]
        assert first == "2020-01-02"                          # 2020-01-01 is a holiday in this calendar
        assert r["equity"][0]["values"]["NIFTY"] == pytest.approx(60000)
        assert r["assets"][0]["units_start"] == pytest.approx(60000 / market[1]["NIFTY"].prices[first])

    @pytest.mark.parametrize("freq,expected_first", [
        ("monthly", ["2020-02-03", "2020-03-02", "2020-04-02", "2020-05-01"]),     # 2020-04-01 is a holiday
        ("quarterly", ["2020-04-02", "2020-07-01", "2020-10-01", "2021-01-04"]),   # 2021-01-01 holiday, 02-03 weekend
        ("halfyearly", ["2020-07-01", "2021-01-04", "2021-07-01", "2022-01-03"]),  # first trading day of Jan / Jul
        ("yearly", ["2021-01-04", "2022-01-03"]),
    ])
    def test_rebalance_on_first_trading_day_of_each_period(self, market, freq, expected_first):
        r = run(market, {"NIFTY": 50, "GOLD": 30, "BOND": 20}, freq)
        dates = [e["date"] for e in r["rebalance_log"]]
        assert dates[:len(expected_first)] == expected_first
        trading = set(market[0])
        for d in dates:
            prev = [x for x in market[0] if x < d][-1]
            assert d in trading and prev[:7] != d[:7]                 # first trading day of a new month
        assert r["rebalance_count"] == len(dates)
        assert {"monthly": 35, "quarterly": 11, "halfyearly": 5, "yearly": 2}[freq] == len(dates)

    def test_rebalance_resets_weights_and_logs_units(self, market):
        r = run(market, {"NIFTY": 50, "GOLD": 50}, "yearly")
        e = r["rebalance_log"][0]
        n = e["assets"]["NIFTY"]
        assert n["weight_after"] == 50 and n["weight_before"] != pytest.approx(50)
        assert n["units_traded"] == pytest.approx(n["units_after"] - n["units_before"])
        assert e["assets"]["NIFTY"]["value_after"] + e["assets"]["GOLD"]["value_after"] == pytest.approx(e["total_before"])
        assert sum(a["traded_value"] for a in e["assets"].values()) == pytest.approx(0, abs=1e-6)

    def test_cash_zero_percent_stays_flat(self, market):
        r = run(market, {"NIFTY": 80, "CASH": 20})
        assert all(p["values"]["CASH"] == pytest.approx(20000) for p in r["equity"])

    def test_cash_rate_matches_compound_formula(self, market):
        assets = {**ASSETS, "CASH": {"loader": "fixed_rate", "annual_return_pct": 6}}
        r = run(market, {"CASH": 100}, assets=assets, calendar=market[0])
        n = r["trading_days"] - 1
        assert r["final_value"] == pytest.approx(100000 * (1.06 ** (1 / TRADING_DAYS)) ** n)
        assert r["volatility_pct"] == pytest.approx(0, abs=1e-9)

    def test_costs_hook(self, market):
        free = run(market, {"NIFTY": 50, "GOLD": 50}, "monthly")
        paid = run(market, {"NIFTY": 50, "GOLD": 50}, "monthly", cost_pct=0.1)
        assert paid["total_cost"] > 0 and paid["final_value"] < free["final_value"]

    def test_metrics(self, market):
        r = run(market, {"NIFTY": 100})
        days = (date.fromisoformat(r["end_date"]) - date.fromisoformat(r["start_date"])).days
        assert r["cagr_pct"] == pytest.approx(((r["final_value"] / 100000) ** (365 / days) - 1) * 100)
        assert r["max_drawdown_pct"] < 0 and r["max_drawdown_peak"] <= r["max_drawdown_trough"]
        assert [y["year"] for y in r["calendar_years"]] == [2020, 2021, 2022]
        prod = 1.0
        for y in r["calendar_years"]:
            prod *= 1 + y["return_pct"] / 100
        assert prod * 100000 == pytest.approx(r["final_value"])
        assert r["best_year"]["return_pct"] >= r["worst_year"]["return_pct"]
        assert sum(a["pnl"] for a in r["assets"]) == pytest.approx(r["final_value"] - 100000)

    def test_contributions_add_up_with_rebalancing(self, market):
        r = run(market, {"NIFTY": 40, "GOLD": 30, "BOND": 20, "CASH": 10}, "quarterly")
        assert sum(a["pnl"] for a in r["assets"]) == pytest.approx(r["final_value"] - 100000)
        assert sum(a["contribution_pct"] for a in r["assets"]) == pytest.approx(r["total_return_pct"])


class TestAlignmentAndErrors:
    def test_forward_fill_up_to_five_days_then_exclude(self):
        days = weekdays("2021-03-01", "2021-03-31")
        a = DailySeries({d: 100.0 + k for k, d in enumerate(days)}, set(days))
        gap = [d for d in days if not ("2021-03-10" <= d <= "2021-03-22")]       # B misses 9 weekdays
        b = DailySeries({d: 50.0 for d in gap}, set(gap))
        kept, out, log = align_prices({"A": a, "B": b}, "2021-03-01", "2021-03-31")
        # B's last price is 03-09: 03-10..03-12 are 1-3 days later (carried forward), 03-15 is 6 days later (dropped)
        assert {"2021-03-10", "2021-03-11", "2021-03-12"} <= set(kept)
        assert "2021-03-15" not in kept and "2021-03-22" not in kept and "2021-03-23" in kept
        assert {x["date"] for x in log["excluded"]} == {"2021-03-15", "2021-03-16", "2021-03-17", "2021-03-18", "2021-03-19", "2021-03-22"}
        assert out["B"][kept.index("2021-03-12")] == 50.0
        assert log["forward_filled"] > 0

    def test_error_when_asset_has_no_data_at_start(self, market):
        late = {**market[1], "GOLD": series(weekdays("2021-06-01", "2022-12-30"), 50)}
        with pytest.raises(BacktestError, match="earliest date with data for all assets is 2021-06-01"):
            run_backtest({"weights": {"NIFTY": 50, "GOLD": 50}}, "2020-01-01", "2022-12-31", 100000, "none",
                         assets=ASSETS, prices=late)

    @pytest.mark.parametrize("weights,msg", [({"NIFTY": 60}, "add up to 100"), ({}, "no weights")])
    def test_bad_weights(self, market, weights, msg):
        with pytest.raises(BacktestError, match=msg):
            run(market, weights)

    def test_bad_rebalance_and_dates(self, market):
        with pytest.raises(BacktestError, match="rebalance must be"):
            run(market, {"NIFTY": 100}, "weekly")
        with pytest.raises(BacktestError, match="before the end date"):
            run(market, {"NIFTY": 100}, start="2022-01-01", end="2021-01-01")


# ---------- real data (live TradeEntry API) ----------

needs_api = pytest.mark.skipif(not os.environ.get("TRADEENTRY_TOKEN"), reason="live TradeEntry data: set TRADEENTRY_TOKEN")


@needs_api
class TestRealData:
    def test_daily_series_match_the_monthly_app_at_year_ends(self):
        import daily_data
        from allocation_store import DEFAULT_ASSETS
        from asset_allocation_backtest import load_all_data
        d = load_all_data()
        gold = daily_data.load_asset("GOLD", DEFAULT_ASSETS["GOLD"]).prices
        nifty = daily_data.load_asset("NIFTY", DEFAULT_ASSETS["NIFTY"]).prices
        bond = daily_data.load_asset("BOND", DEFAULT_ASSETS["BOND"]).prices
        last = lambda s, ym: s[max(k for k in s if k.startswith(ym))]
        for y in (1994, 1995, 2000, 2004, 2010, 2020, 2025):
            assert last(gold, f"{y}-12") == pytest.approx(d["gold_level"][(y, 12)])
            assert last(nifty, f"{y}-12") == pytest.approx(d["nifty_level"][(y, 12)])
        bx = 1.0
        for y in range(1995, 2026):
            for m in range(1, 13):
                bx *= 1 + d["bonds_ret"][(y, m)]
            assert last(bond, f"{y}-12") == pytest.approx(bx, rel=1e-9)

    def test_real_backtest_runs(self):
        from allocation_store import DEFAULT_ASSETS
        r = run_backtest({"weights": {"NIFTY": 50, "GOLD": 20, "BOND": 20, "CASH": 10}}, "2005-01-01", "2025-12-31",
                         100000, "quarterly", assets=DEFAULT_ASSETS)
        assert r["start_date"].startswith("2005-01") and r["rebalance_count"] > 70
        assert 5 < r["cagr_pct"] < 20 and r["max_drawdown_pct"] < -10
