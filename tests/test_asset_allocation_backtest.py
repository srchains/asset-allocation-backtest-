"""
Tests for asset_allocation_backtest.py.

Run from the project root:
    python -m pytest tests/ -v

The parsing tests below are regression tests for two real bugs caught during
development: first_number() originally matched embedded years ("Mar-2013",
"~6.80% (2026)") and tenures ("1-yr") as if they were rate values. Keep these
even if the CSVs change, since they test the parser's robustness against the
*shape* of the messy input, not specific numbers.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from asset_allocation_backtest import (
    first_number, year_key, interpolate_gaps, parse_period, month_range,
    monthly_returns_from_levels, monthly_rate_from_annual,
    simulate, compute_risk_metrics, weighted_average_rate,
    load_all_data, usable_months, market_data, previous_month, to_annual, previous_period,
    mcx_gold_fixes, bonds_monthly_returns, last_complete_month,
)


# ---------- first_number() ----------

class TestFirstNumber:
    def test_none_input(self):
        assert first_number(None) is None

    def test_plain_na(self):
        assert first_number("N/A") is None

    def test_simple_decimal(self):
        assert first_number("6.70") == 6.70

    def test_avg_pattern_preferred(self):
        assert first_number("8.5 - 10.5 (avg. 9.5)") == 9.5

    def test_range_with_tenure_and_date_not_mistaken_for_rate(self):
        # Bug: "1-yr" and "10-Oct-2019" contain digits that could be
        # mistaken for the rate if the parser doesn't prefer decimals.
        assert first_number("~6.70-6.80 (1 yr-<2 yrs, cut 10-Oct-2019)") == 6.70

    def test_embedded_year_not_mistaken_for_rate(self):
        # Bug: "2013" and "2026" are 4-digit numbers that look like values
        # but are actually years/dates embedded in descriptive text.
        assert first_number("N/A (WADTDR series begins Mar-2013)") is None
        result = first_number("N/A - RBI's latest 2026 figure not retrieved; SBI's rate is ~6.80%")
        assert result == 6.80

    def test_out_of_bounds_rejected(self):
        # A bare 4-digit year with no valid decimal rate anywhere in the
        # string should not fall back to returning the year itself.
        assert first_number("As of Mar-2013") is None

    def test_multiple_dated_rates_picks_first(self):
        text = "5.90 (Jan-2023) -> 6.28 (Apr-2023) -> 6.78 (Nov-2023)"
        assert first_number(text) == 5.90


# ---------- year_key() ----------

class TestYearKey:
    def test_plain_year(self):
        assert year_key("2011") == 2011

    def test_year_with_suffix(self):
        assert year_key("2011 (as of Mar-2011)") == 2011
        assert year_key("2026 (YTD, as of latest available)") == 2026

    def test_no_leading_year(self):
        assert year_key("Methodology & Notes") is None


# ---------- interpolate_gaps() ----------

class TestInterpolateGaps:
    def test_interior_gap_linear(self):
        series = {2010: 8.0, 2011: None, 2012: None, 2013: 5.0}
        result = interpolate_gaps(dict(series))
        assert result[2011] == pytest.approx(8.0 - (8.0 - 5.0) / 3)
        assert result[2012] == pytest.approx(8.0 - 2 * (8.0 - 5.0) / 3)

    def test_leading_gap_uses_nearest_known(self):
        series = {2010: None, 2011: 6.0, 2012: 7.0}
        result = interpolate_gaps(dict(series))
        assert result[2010] == 6.0

    def test_trailing_gap_uses_nearest_known(self):
        series = {2010: 6.0, 2011: 7.0, 2012: None}
        result = interpolate_gaps(dict(series))
        assert result[2012] == 7.0

    def test_no_gaps_unchanged(self):
        series = {2010: 6.0, 2011: 7.0}
        assert interpolate_gaps(dict(series)) == series


# ---------- parse_period() ----------

class TestParsePeriod:
    def test_year_only_start_defaults_january(self):
        assert parse_period("2015", end_of_period=False) == (2015, 1)

    def test_year_only_end_defaults_december(self):
        assert parse_period("2015", end_of_period=True) == (2015, 12)

    def test_year_month(self):
        assert parse_period("2015-06", end_of_period=False) == (2015, 6)
        assert parse_period("2015-06", end_of_period=True) == (2015, 6)

    def test_invalid_format_raises(self):
        with pytest.raises(SystemExit):
            parse_period("not-a-period", end_of_period=False)

    def test_invalid_month_raises(self):
        with pytest.raises(SystemExit):
            parse_period("2015-13", end_of_period=False)


# ---------- month_range() ----------

class TestMonthRange:
    def test_within_one_year(self):
        assert month_range((2020, 1), (2020, 3)) == [(2020, 1), (2020, 2), (2020, 3)]

    def test_crosses_year_boundary(self):
        assert month_range((2020, 11), (2021, 2)) == [
            (2020, 11), (2020, 12), (2021, 1), (2021, 2),
        ]

    def test_single_month(self):
        assert month_range((2020, 5), (2020, 5)) == [(2020, 5)]


# ---------- monthly_returns_from_levels() / monthly_rate_from_annual() ----------

class TestReturnMath:
    def test_monthly_returns_from_levels(self):
        levels = {(2020, 1): 100.0, (2020, 2): 110.0, (2020, 3): 99.0}
        returns = monthly_returns_from_levels(levels)
        assert returns[(2020, 2)] == pytest.approx(0.10)
        assert returns[(2020, 3)] == pytest.approx(-0.10)
        assert (2020, 1) not in returns  # no prior month to compare against

    def test_monthly_rate_from_annual_compounds_to_annual(self):
        annual = 12.0
        monthly = monthly_rate_from_annual(annual)
        compounded = (1 + monthly) ** 12 - 1
        assert compounded * 100 == pytest.approx(annual)

    def test_zero_annual_rate_gives_zero_monthly(self):
        assert monthly_rate_from_annual(0.0) == pytest.approx(0.0)


# ---------- simulate() on synthetic data (deterministic, no CSVs involved) ----------

@pytest.fixture
def synthetic_data():
    # Two months of hand-picked returns/rates so the expected result can be
    # computed by hand and checked exactly.
    return {
        "nifty_ret": {(2020, 1): 0.10, (2020, 2): -0.05},
        "gold_ret": {(2020, 1): 0.02, (2020, 2): 0.03},
        "midcap_ret": {(2020, 1): 0.15, (2020, 2): -0.08},
        "smallcap_ret": {(2020, 1): 0.18, (2020, 2): -0.10},
        "bonds_ret": {(2020, 1): 0.005, (2020, 2): 0.004},
        "fd": {2020: 6.0},       # annual %
        "inflation": {2020: 5.0},  # annual %
    }


class TestSimulate:
    def test_no_rebalance_each_asset_compounds_independently(self, synthetic_data):
        weights = {"equity": 50, "gold": 20, "bonds": 20, "midcap": 0, "smallcap": 0, "cash": 10}
        months = [(2020, 1), (2020, 2)]
        rows = simulate(synthetic_data, 100000, weights, months, rebalance=False)

        assert len(rows) == 2
        # Month 1: equity 50000*1.10, gold 20000*1.02, bonds/cash compound at their monthly rate.
        m1 = rows[0]
        assert m1["equity_value"] == pytest.approx(50000 * 1.10)
        assert m1["gold_value"] == pytest.approx(20000 * 1.02)
        assert m1["nominal_value"] == pytest.approx(
            m1["equity_value"] + m1["gold_value"] + m1["bonds_value"]
            + m1["midcap_value"] + m1["smallcap_value"] + m1["cash_value"]
        )

        # Month 2: equity continues compounding from month 1's value (no rebalance).
        m2 = rows[1]
        assert m2["equity_value"] == pytest.approx(m1["equity_value"] * 0.95)
        assert m2["gold_value"] == pytest.approx(m1["gold_value"] * 1.03)

    @pytest.fixture
    def dec_data(self):
        return {
            "nifty_ret": {(2020, 11): 0.30, (2020, 12): 0.10},
            "gold_ret": {(2020, 11): 0.0, (2020, 12): 0.0},
            "midcap_ret": {}, "smallcap_ret": {},
            "bonds_ret": {(2020, 11): 0.0, (2020, 12): 0.0},
            "fd": {2020: 6.0}, "inflation": {2020: 5.0},
        }

    def test_rebalance_only_at_december_and_resets_weights(self, dec_data):
        weights = {"equity": 50, "gold": 30, "bonds": 15, "midcap": 0, "smallcap": 0, "cash": 5}
        months = [(2020, 11), (2020, 12)]
        events = []
        rows = simulate(dec_data, 100000, weights, months, rebalance=True, events=events)
        # November: no review, equity just compounds.
        assert rows[0]["equity_value"] == pytest.approx(50000 * 1.30)
        # December: drifted well past 5 points -> reset to target.
        total = rows[1]["nominal_value"]
        assert rows[1]["equity_value"] == pytest.approx(total * 0.50)
        assert rows[1]["gold_value"] == pytest.approx(total * 0.30)
        assert len(events) == 1 and events[0]["rebalanced"]
        trades = sum(i["trade"] for i in events[0]["items"].values())
        assert trades == pytest.approx(0, abs=1e-6)
        assert events[0]["items"]["equity"]["trade"] < 0

    def test_rebalance_skipped_inside_tolerance_band(self, dec_data):
        dec_data["nifty_ret"] = {(2020, 11): 0.01, (2020, 12): 0.01}
        weights = {"equity": 50, "gold": 30, "bonds": 15, "midcap": 0, "smallcap": 0, "cash": 5}
        events = []
        rows = simulate(dec_data, 100000, weights, [(2020, 11), (2020, 12)],
                        rebalance=True, events=events)
        assert events[0]["rebalanced"] is False
        assert rows[1]["equity_value"] == pytest.approx(50000 * 1.01 * 1.01)

    def test_rebalance_and_no_rebalance_diverge_when_drift_is_large(self, dec_data):
        weights = {"equity": 50, "gold": 30, "bonds": 15, "midcap": 0, "smallcap": 0, "cash": 5}
        months = [(2020, 11), (2020, 12)]
        # Equity already drifted past the band by December, so the reset
        # shows up in the December row's per-asset split.
        no_rb = simulate(dec_data, 100000, weights, months, rebalance=False)
        rb = simulate(dec_data, 100000, weights, months, rebalance=True)
        assert no_rb[-1]["equity_value"] != pytest.approx(rb[-1]["equity_value"])

    def test_real_value_divides_out_inflation(self, synthetic_data):
        weights = {"equity": 100, "gold": 0, "bonds": 0, "midcap": 0, "smallcap": 0, "cash": 0}
        months = [(2020, 1)]
        rows = simulate(synthetic_data, 100000, weights, months, rebalance=False)
        monthly_infl = monthly_rate_from_annual(5.0)
        expected_real = rows[0]["nominal_value"] / (1 + monthly_infl)
        assert rows[0]["real_value"] == pytest.approx(expected_real)

    def test_single_asset_100pct_matches_raw_return(self, synthetic_data):
        weights = {"equity": 100, "gold": 0, "bonds": 0, "midcap": 0, "smallcap": 0, "cash": 0}
        months = [(2020, 1), (2020, 2)]
        rows = simulate(synthetic_data, 100000, weights, months, rebalance=False)
        assert rows[-1]["nominal_value"] == pytest.approx(100000 * 1.10 * 0.95)


# ---------- previous_month() ----------

def test_previous_month_wraps_year():
    assert previous_month((2005, 7)) == (2005, 6)
    assert previous_month((2006, 1)) == (2005, 12)


# ---------- market_data() ----------

class TestMarketData:
    def test_returns_raw_source_values_per_month(self):
        data = {
            "nifty_level": {(2020, 1): 12000.0, (2020, 2): 11200.0},
            "gold_level": {(2020, 1): 4000.0, (2020, 2): 4200.0},
            "midcap_level": {(2020, 1): 18000.0, (2020, 2): 17500.0},
            "smallcap_level": {(2020, 1): 9000.0, (2020, 2): 8700.0},
            "bonds_ret": {(2020, 1): 0.005, (2020, 2): 0.004},
            "fd": {2020: 6.0},
            "inflation": {2020: 5.0},
        }
        rows = market_data(data, [(2020, 1), (2020, 2)])
        bonds_m1 = 0.5
        bonds_m2 = 0.4
        assert rows == [
            {"period": "2020-01", "nifty_close": 12000.0, "gold_per_gram": 4000.0,
             "bonds_ret_pct": pytest.approx(bonds_m1), "inflation_pct": 5.0,
             "midcap_close": 18000.0, "smallcap_close": 9000.0},
            {"period": "2020-02", "nifty_close": 11200.0, "gold_per_gram": 4200.0,
             "bonds_ret_pct": pytest.approx(bonds_m2), "inflation_pct": 5.0,
             "midcap_close": 17500.0, "smallcap_close": 8700.0},
        ]


# ---------- compute_risk_metrics() ----------

class TestAnnualData:
    @pytest.fixture
    def monthly(self):
        # 24 months, Dec-2019 .. Nov-2021 style: only the Decembers matter for levels.
        levels_n, levels_g = {}, {}
        n, g = 100.0, 50.0
        for y in (2019, 2020, 2021):
            for m in range(1, 13):
                n *= 1.01; g *= 1.005
                levels_n[(y, m)] = n; levels_g[(y, m)] = g
        return {
            "nifty_level": levels_n, "gold_level": levels_g,
            "midcap_level": {(2021, 12): 10.0}, "smallcap_level": {},
            "bonds_ret": {(y, m): 0.01 for y in (2020, 2021) for m in range(1, 13)},
            "inflation": {2020: 5.0, 2021: 6.0}, "fd": {2020: 6.0, 2021: 6.0},
        }

    def test_returns_are_december_to_december(self, monthly):
        a = to_annual(monthly)
        assert set(a["nifty_ret"]) == {(2020, 12), (2021, 12)}
        assert a["nifty_ret"][(2021, 12)] == pytest.approx(1.01 ** 12 - 1)
        assert a["gold_ret"][(2020, 12)] == pytest.approx(1.005 ** 12 - 1)

    def test_bonds_year_is_the_compounded_months(self, monthly):
        a = to_annual(monthly)
        assert a["bonds_ret"][(2020, 12)] == pytest.approx(1.01 ** 12 - 1)

    def test_bonds_needs_a_full_year(self, monthly):
        del monthly["bonds_ret"][(2021, 12)]
        assert (2021, 12) not in to_annual(monthly)["bonds_ret"]

    def test_midcap_flat_without_two_decembers(self, monthly):
        assert to_annual(monthly)["midcap_ret"] == {}

    def test_usable_months_are_only_decembers(self, monthly):
        a = to_annual(monthly)
        assert usable_months(a, "2019", "2022") == [(2020, 12), (2021, 12)]
        assert previous_period((2020, 12), 1) == (2019, 12)

    def test_yearly_simulation_uses_the_annual_inflation_rate(self, monthly):
        a = to_annual(monthly)
        w = {"equity": 100, "gold": 0, "bonds": 0, "midcap": 0, "smallcap": 0, "cash": 0}
        rows = simulate(a, 1000, w, [(2020, 12), (2021, 12)], periods_per_year=1)
        assert rows[0]["nominal_value"] == pytest.approx(1000 * (1.01 ** 12))
        assert rows[0]["real_value"] == pytest.approx(rows[0]["nominal_value"] / 1.05)
        assert rows[1]["real_value"] == pytest.approx(rows[1]["nominal_value"] / (1.05 * 1.06))

    def test_yearly_risk_metrics_use_one_period_per_year(self):
        out = compute_risk_metrics([100, 110, 99], 0.0, periods_per_year=1)
        rets = [0.10, -0.10]
        mean = sum(rets) / 2
        vol = (sum((r - mean) ** 2 for r in rets) / 2) ** 0.5
        assert out["volatility_pct"] == pytest.approx(vol * 100)


class TestComputeRiskMetrics:
    def test_constant_growth_has_zero_volatility(self):
        # 1% every month for 12 months -> constant monthly return -> 0 volatility.
        values = [100 * (1.01 ** i) for i in range(13)]
        metrics = compute_risk_metrics(values, risk_free_annual_pct=0.0)
        assert metrics["volatility_pct"] == pytest.approx(0.0, abs=1e-9)
        assert metrics["max_drawdown_pct"] == pytest.approx(0.0)
        # CAGR > risk-free(0), zero volatility -> Sharpe undefined (avoid div by zero).
        assert metrics["sharpe_ratio"] is None

    def test_drawdown_detects_peak_to_trough_decline(self):
        values = [100, 120, 60, 90]  # peak 120 -> trough 60 = -50%
        metrics = compute_risk_metrics(values, risk_free_annual_pct=0.0)
        assert metrics["max_drawdown_pct"] == pytest.approx(-50.0)

    def test_monotonic_increase_has_zero_drawdown(self):
        values = [100, 110, 120, 130]
        metrics = compute_risk_metrics(values, risk_free_annual_pct=0.0)
        assert metrics["max_drawdown_pct"] == pytest.approx(0.0)

    def test_cagr_uses_the_number_of_periods_between_values(self):
        # 3 yearly values = 2 yearly steps (+10% each): Sharpe numerator is the 10% CAGR.
        out = compute_risk_metrics([100, 110, 121], 0.0, periods_per_year=1)
        assert out["sharpe_ratio"] is None  # constant growth -> zero volatility, so undefined
        out2 = compute_risk_metrics([100, 120, 121.0], 0.0, periods_per_year=1)
        cagr = (121.0 / 100) ** (1 / 2) - 1
        rets = [0.20, 121 / 120 - 1]; mean = sum(rets) / 2
        vol = (sum((r - mean) ** 2 for r in rets) / 2) ** 0.5
        assert out2["sharpe_ratio"] == pytest.approx(cagr / vol)

    def test_too_few_points_returns_zeros(self):
        metrics = compute_risk_metrics([100], risk_free_annual_pct=0.0)
        assert metrics == {"volatility_pct": 0.0, "max_drawdown_pct": 0.0, "sharpe_ratio": None}

    def test_sharpe_positive_when_cagr_beats_risk_free(self):
        # Volatile but clearly-positive-trending series so Sharpe is well-defined.
        values = [100, 105, 102, 112, 108, 120]
        metrics = compute_risk_metrics(values, risk_free_annual_pct=2.0)
        assert metrics["sharpe_ratio"] is not None
        assert metrics["sharpe_ratio"] > 0


# ---------- weighted_average_rate() ----------

class TestWeightedAverageRate:
    def test_single_year(self):
        rates = {2020: 6.0}
        months = [(2020, 1), (2020, 2), (2020, 3)]
        assert weighted_average_rate(rates, months) == 6.0

    def test_weighted_across_years(self):
        rates = {2020: 6.0, 2021: 8.0}
        # 2 months at 6%, 1 month at 8% -> weighted average = (6+6+8)/3
        months = [(2020, 11), (2020, 12), (2021, 1)]
        assert weighted_average_rate(rates, months) == pytest.approx((6.0 + 6.0 + 8.0) / 3)


# ---------- frozen MCX gold prices ----------

class TestFrozenGoldFix:
    @staticmethod
    def _series(frozen_value):
        """30 daily MCX closes with a 14-day frozen run (days 8..21) and a matching GOLDINR series
        whose price keeps rising, so the true price at the month-end inside the run is higher."""
        import datetime as dt
        start = dt.date(2020, 3, 10)
        mcx, gin = {}, {}
        for k in range(30):
            d = (start + dt.timedelta(days=k)).isoformat()
            gin[d] = 40000.0 * (1 + 0.01 * k)
            mcx[d] = gin[d] * 1.10
        for k in range(8, 22):
            mcx[(start + dt.timedelta(days=k)).isoformat()] = frozen_value
        return mcx, gin

    def test_frozen_month_end_far_from_global_gold_is_replaced(self):
        mcx, gin = self._series(41000.0)               # 2020-03-31 is day 21, inside the run
        fixes = mcx_gold_fixes(mcx, gin)
        assert list(fixes) == ["2020-03-31"]
        stale, est = fixes["2020-03-31"]
        assert stale == 41000.0
        assert est == pytest.approx(gin["2020-03-31"] * 1.10)   # premium is flat 1.10, so the estimate is exact

    def test_frozen_month_end_close_to_estimate_is_kept(self):
        _, gin = self._series(0.0)
        mcx, gin = self._series(gin["2020-03-31"] * 1.10 * 1.02)   # frozen price only 2% above the estimate
        assert mcx_gold_fixes(mcx, gin) == {}

    def test_short_flat_spell_is_not_a_freeze(self):
        mcx, gin = self._series(41000.0)
        import datetime as dt
        start = dt.date(2020, 3, 10)
        for k in range(8, 22):                          # restore real prices, then make a 5-day flat spell
            d = (start + dt.timedelta(days=k)).isoformat()
            mcx[d] = gin[d] * 1.10
        for k in range(16, 21):
            mcx[(start + dt.timedelta(days=k)).isoformat()] = 41000.0
        assert mcx_gold_fixes(mcx, gin) == {}


# ---------- Bonds returns across a year change ----------

class TestBondsAcrossYears:
    SBI = {y: 9.0 if y == 1999 else 8.0 for y in range(1999, 2012)} | {2019: 6.8, 2025: 6.25}

    @staticmethod
    def _gsec(last_date, last_value):
        """G-sec closes: first close 2015-10-13, a December close every year 2015-2026, then extra dates."""
        g = {"2015-10-13": 1000.0}
        for k, y in enumerate(range(2015, 2027)):
            g[f"{y}-12-31"] = 1000.0 * 1.05 ** (k + 1)
        g["2027-01-29"] = g["2026-12-31"] * 1.01
        g[last_date] = last_value
        return g

    def test_last_complete_month(self):
        assert last_complete_month({"2026-10-01": 1.0, "2026-09-30": 1.0}) == (2026, 9)
        assert last_complete_month({"2026-09-30": 1.0}) == (2026, 9)
        assert last_complete_month({"2027-02-26": 1.0}) == (2027, 1)     # Feb 26 is not the month-end yet

    def test_next_year_keeps_working(self):
        # In 2027 the finished year 2026 is Dec to Dec and 2027 runs to the last complete month (January).
        g = self._gsec("2027-02-26", 2000.0)
        r = bonds_monthly_returns(self.SBI, g)
        assert r[(2026, 6)] == 0.0 and r[(2026, 12)] == pytest.approx(0.05)     # booked once, in December
        assert r[(2027, 1)] == pytest.approx(0.01)                      # Dec 2026 close -> Jan 2027 close
        assert (2027, 2) not in r                                       # February is not complete
        assert r[(1997, 5)] == 0.0 and r[(1997, 12)] == pytest.approx(0.09)    # first SBI value before 1999
        assert r[(2013, 12)] == pytest.approx(0.08)                             # 2011 rate for 2012-2014


# ---------- Integration: real data, regression guard ----------

needs_api = pytest.mark.skipif(
    not os.environ.get("TRADEENTRY_TOKEN"),
    reason="live TradeEntry data: set TRADEENTRY_TOKEN to run",
)


@needs_api
class TestRealDataIntegration:
    """These use the live TradeEntry API data plus the local CSVs in ./data. They exist specifically to catch
    parsing regressions (like the first_number() bugs above) that only show
    up once real messy rows are involved -- unit tests on first_number()
    alone wouldn't have caught the original bug's effect on the final
    simulated numbers."""

    @pytest.fixture(scope="class")
    @classmethod
    def data(cls):
        return load_all_data()

    def test_known_result_unrebalanced(self, data):
        # Matches the CLI's verified output for this exact command:
        # python asset_allocation_backtest.py --capital 100000 --nifty 32 \
        #     --gold 32 --bonds 34 --start 2005 --end 2026
        # Bonds earn one percentage per year (Jan-Dec), booked in December, so the
        # Jul-Dec 2005 start gets no part-year bonds return. Start pinned at 2005-07
        # so the value does not depend on the data added before that month.
        months = usable_months(data, "2005-07", "2025-12")
        weights = {"equity": 32, "gold": 32, "bonds": 34, "midcap": 0, "smallcap": 0, "cash": 2}
        rows = simulate(data, 100000, weights, months, rebalance=False)
        assert rows[-1]["nominal_value"] == pytest.approx(1210237.61, rel=1e-4)
        # Uses World Bank CPI inflation.
        assert rows[-1]["real_value"] == pytest.approx(335697.85, rel=1e-4)

    def test_budget_day_1997_close_is_corrected(self, data):
        # The API labels the real 28 Feb 1997 close (1053.55, +6% on Budget day) as 1997-03-01
        # and holds a stray 998.65 under 1997-02-28; the loader fixes that one date.
        import asset_allocation_backtest as aab
        daily = aab.load_nifty_daily()
        assert daily["1997-02-28"] == pytest.approx(1053.55)
        assert daily["1997-02-28"] / daily["1997-02-27"] - 1 > 0.05
        assert data["nifty_level"][(1997, 2)] == pytest.approx(1053.55)
        assert data["nifty_level"][(1997, 3)] / data["nifty_level"][(1997, 2)] - 1 < 0.05  # no phantom double jump

    def test_frozen_mcx_gold_2020_is_corrected(self, data):
        # The API's MCX gold is frozen at 40,989 from 2020-03-20 to 2020-06-02; Mar/Apr/May 2020
        # month-ends use an estimate, so gold no longer shows 0.0% / 0.0% then +17.9% in Jun 2020.
        gold = data["gold_ret"]
        assert gold[(2020, 4)] > 0.03 and gold[(2020, 5)] > 0.02
        assert gold[(2020, 6)] < 0.08
        from asset_allocation_backtest import mcx_gold_fixes
        import api_data
        fixes = mcx_gold_fixes(api_data.mcx_gold_closes(), api_data.goldinr_closes())
        assert sorted(fixes) == ["2020-03-31", "2020-04-30", "2020-05-29"]

    def test_all_fd_rates_are_plausible_percentages(self, data):
        # Regression guard: every parsed FD rate must be a plausible rate,
        # not an accidentally-matched year/day-of-month/tenure number.
        for year, rate in data["fd"].items():
            assert 0 <= rate <= 20, f"Implausible FD rate {rate}% for {year}"
        assert data["fd"][1996] == pytest.approx(9.0)          # before the SBI series: its first value
        assert data["fd"][2015] == pytest.approx(9.25 + (6.7 - 9.25) * 4 / 8)  # between 2011 and 2019

    def test_all_inflation_rates_are_plausible_percentages(self, data):
        for year, rate in data["inflation"].items():
            assert -5 <= rate <= 25, f"Implausible inflation rate {rate}% for {year}"

    def test_bonds_follow_sbi_rates_until_2011(self, data):
        # 1996-1998: the SBI series' first value (9.00%) applied; 1999-2011: SBI year-end rate (API).
        # The whole year's return is booked in December; the other months are 0%.
        r = data["bonds_ret"]
        assert r[(1996, 6)] == 0.0 and r[(1996, 12)] == pytest.approx(0.09)
        assert r[(1998, 12)] == pytest.approx(0.09)
        assert r[(2001, 12)] == pytest.approx(0.0775)
        assert r[(2005, 3)] == 0.0 and r[(2005, 12)] == pytest.approx(0.055)
        assert r[(2008, 12)] == pytest.approx(0.0875)
        assert r[(2011, 12)] == pytest.approx(0.0925)

    def test_bonds_2012_2014_use_the_2011_sbi_rate_and_2015_the_gsec_index(self, data):
        import api_data
        for y in (2012, 2013, 2014):
            assert data["bonds_ret"][(y, 6)] == 0.0 and data["bonds_ret"][(y, 12)] == pytest.approx(0.0925)
        series = api_data.economic_series("INDIA_GSEC_COMPOSITE")
        first_2015 = series[min(d for d in series if d.startswith("2015"))]
        dec_2015 = series[max(d for d in series if d.startswith("2015"))]
        # 2015: from the index's first close (2015-10-13) to the December close
        assert data["bonds_ret"][(2015, 12)] == pytest.approx(dec_2015 / first_2015 - 1)

    def test_bonds_2016_2025_follow_api_gsec_index(self, data):
        import api_data
        series = api_data.economic_series("INDIA_GSEC_COMPOSITE")
        def dec(y):
            return series[max(d for d in series if d.startswith(str(y)))]
        for y in (2016, 2017, 2020, 2025):
            assert data["bonds_ret"][(y, 6)] == 0.0
            assert data["bonds_ret"][(y, 12)] == pytest.approx(dec(y) / dec(y - 1) - 1, abs=1e-9)

    def test_inflation_only_from_api(self, data):
        infl = data["inflation"]
        assert min(infl) == 1996 and max(infl) == 2026   # 1996-2025 from the API, 2026 carried forward
        assert infl[2026] == infl[2025]
        assert 3 < infl[2005] < 5
        assert infl[1999] == pytest.approx(4.67)

    def test_december_only_buy_and_hold_equals_monthly(self, data):
        # Without rebalancing, valuing at December closes must give exactly the
        # same December values as the monthly buy-and-hold (inflation too).
        w = {"equity": 50, "gold": 30, "bonds": 15, "midcap": 0, "smallcap": 0, "cash": 5}
        monthly = simulate(data, 200000, w, usable_months(data, "1996", "2025-12"))
        a = to_annual(data)
        yearly = simulate(a, 200000, w, usable_months(a, "1996", "2025-12"), periods_per_year=1)
        by_period = {r["period"]: r for r in monthly}
        assert len(yearly) == 30
        for r in yearly:
            assert r["nominal_value"] == pytest.approx(by_period[r["period"]]["nominal_value"], rel=1e-9)
            assert r["real_value"] == pytest.approx(by_period[r["period"]]["real_value"], rel=1e-9)

    def test_pre_2005_gold_joins_mcx_without_a_jump(self, data):
        gl = data["gold_level"]
        # December anchors are GOLDINR closes matched to MCX; 2005-06 is MCX itself.
        assert gl[(2005, 6)] == pytest.approx(624.0 * 1.03)  # MCX + 3% GST
        assert 400 < gl[(1995, 12)] < 520
        jump = gl[(2005, 6)] / gl[(2005, 5)] - 1
        assert abs(jump) < 0.05

    def test_midcap_and_smallcap_flat_before_2005(self, data):
        months = usable_months(data, "1995", "2005-03")
        weights = {"equity": 0, "gold": 0, "bonds": 0, "midcap": 50, "smallcap": 50, "cash": 0}
        rows = simulate(data, 100000, weights, months)
        assert rows[-1]["nominal_value"] == pytest.approx(100000)

    def test_usable_months_clamped_to_gold_start(self, data):
        months = usable_months(data, "1990-01", "2026-12")
        # Inflation from the API starts in 1996 (1995 repeats it); the data runs to the last complete month.
        # Money goes in at the Dec-1995 close, so the first return month is 1996-01.
        assert months[0] == (1996, 1) and months[-1] >= (2026, 1)
