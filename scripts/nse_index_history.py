"""
Download daily history of NSE indices (price index) from niftyindices.com.

This is a stand-alone data tool. The app/server never calls it; it only
writes CSV files that you then review and copy into ./data.

Examples (run from the project folder):
    python scripts/nse_index_history.py "NIFTY MIDCAP 150" --start 2026-01-01
    python scripts/nse_index_history.py "NIFTY MIDCAP 150" "NIFTY SMALLCAP 250" \
        --start 2005-04-01 --app-format
    python scripts/nse_index_history.py "NIFTY MIDCAP 150" --start 2025-01-01 \
        --compare data/NIFTY_MIDCAP_150_2005_2026.csv

--app-format writes `date,<name>_close` in the same column layout the
backtest loaders read (nifty_midcap150_close / nifty_smallcap250_close).
--compare checks the downloaded closes against an existing CSV on the dates
they share, so you can confirm the new data matches before replacing anything.

Needs: pip install requests pandas   (Python 3.9+)
"""

import argparse
import json
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
import requests

BASE = "https://www.niftyindices.com"
HIST_URL = BASE + "/Backpage.aspx/getHistoricaldatatabletoString"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json; charset=UTF-8",
    "Origin": BASE,
    "Referer": BASE + "/reports/historical-data",
    "X-Requested-With": "XMLHttpRequest",
}
EARLIEST_POSSIBLE = date(1990, 1, 1)
MAX_GAP_DAYS = 10  # a longer hole between two trading days is reported


class DownloadError(Exception):
    pass


def _session():
    s = requests.Session()
    s.headers.update(HEADERS)
    try:  # warm-up request to pick up cookies
        s.get(BASE + "/reports/historical-data", timeout=20)
    except requests.RequestException:
        pass
    return s


def _fetch_chunk(s, index_name, start, end, retries=4):
    """One date window (<= 1 year). Returns (rows, ok). ok=False means every
    retry failed, which is different from a window that is genuinely empty."""
    cinfo = {
        "name": index_name,
        "startDate": start.strftime("%d-%b-%Y"),
        "endDate": end.strftime("%d-%b-%Y"),
        "indexName": index_name,
    }
    payload = {"cinfo": json.dumps(cinfo).replace('"', "'")}
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = s.post(HIST_URL, json=payload, timeout=30)
            r.raise_for_status()
            if "json" not in r.headers.get("content-type", ""):
                raise ValueError("site returned a web page instead of data (script blocked or "
                                 "endpoint changed) -- download the CSV manually from "
                                 "niftyindices.com/reports/historical-data")
            d = r.json().get("d", "[]")
            rows = json.loads(d) if isinstance(d, str) else d
            return rows or [], True
        except (requests.RequestException, ValueError) as e:
            last_err = e
            time.sleep(2 * attempt)
    print(f"  ! {start}..{end} failed after {retries} tries: {last_err}")
    return [], False


def _year_windows(start, end):
    cur = start
    while cur <= end:
        nxt = min(date(cur.year, 12, 31), end)
        yield cur, nxt
        cur = nxt + timedelta(days=1)


def download_index_history(index_name, start: Optional[date] = None,
                           end: Optional[date] = None, pause=0.6) -> pd.DataFrame:
    """Daily Date/Open/High/Low/Close for the exact NSE index name.

    Raises DownloadError if no data came back, or if any year-window failed
    (so a half-downloaded history can never be saved by accident).
    """
    index_name = index_name.strip().upper()
    start = start or EARLIEST_POSSIBLE
    end = end or date.today()

    s = _session()
    all_rows, failed, found_first = [], [], False
    for a, b in _year_windows(start, end):
        rows, ok = _fetch_chunk(s, index_name, a, b)
        if not ok:
            failed.append(a.year)
        elif rows:
            found_first = True
            print(f"  {a.year}: {len(rows)} rows")
            all_rows.extend(rows)
        elif found_first:
            print(f"  {a.year}: no data")
        time.sleep(pause)

    if failed:
        raise DownloadError(f"{index_name}: these years failed and are missing: {failed}. "
                            "Re-run (the site may be rate-limiting).")
    if not all_rows:
        raise DownloadError(
            f"No data returned for '{index_name}'. Check the exact name on "
            "niftyindices.com (e.g. 'NIFTY MIDCAP 150'), or the site may be blocking scripts.")

    df = pd.DataFrame(all_rows).rename(columns={
        "HistoricalDate": "Date", "OPEN": "Open", "HIGH": "High",
        "LOW": "Low", "CLOSE": "Close"})
    df["Date"] = pd.to_datetime(df["Date"], format="mixed", dayfirst=True)
    for c in ("Open", "High", "Low", "Close"):
        if c in df:
            df[c] = pd.to_numeric(df[c].astype(str).str.replace(",", ""), errors="coerce")
    cols = [c for c in ("Date", "Open", "High", "Low", "Close") if c in df]
    df = df[cols].drop_duplicates("Date").sort_values("Date").reset_index(drop=True)
    return df.dropna(subset=["Close"])


def report_gaps(df):
    """Print any hole longer than MAX_GAP_DAYS between consecutive rows."""
    d = df["Date"]
    bad = df[(d.diff().dt.days > MAX_GAP_DAYS)]
    for i in bad.index:
        print(f"  ! gap: {d[i - 1]:%Y-%m-%d} -> {d[i]:%Y-%m-%d} ({(d[i] - d[i - 1]).days} days)")
    if bad.empty:
        print("  no gaps longer than %d days" % MAX_GAP_DAYS)


def compare_with(df, path):
    """Compare closes against an existing CSV (date + one close column)."""
    old = pd.read_csv(path)
    old.columns = ["Date", "OldClose"] + list(old.columns[2:])
    old["Date"] = pd.to_datetime(old["Date"])
    m = df[["Date", "Close"]].merge(old[["Date", "OldClose"]], on="Date")
    if m.empty:
        print(f"  compare: no shared dates with {path}")
        return
    diff = (m["Close"] - m["OldClose"]).abs()
    bad = m[diff > 0.01]
    print(f"  compare: {len(m)} shared dates, {len(bad)} differ by more than 0.01")
    if len(bad):
        print(bad.head(10).to_string(index=False))


def app_column_name(index_name):
    # "NIFTY MIDCAP 150" -> nifty_midcap150_close
    return re.sub(r"\s+(\d+)$", r"\1", index_name.strip().lower()).replace(" ", "_") + "_close"


def main():
    p = argparse.ArgumentParser(description="Download NSE index history")
    p.add_argument("index", nargs="+", help='Exact index name(s), e.g. "NIFTY MIDCAP 150"')
    p.add_argument("--start", help="YYYY-MM-DD (default: auto-detect from 1990)")
    p.add_argument("--end", help="YYYY-MM-DD (default: today)")
    p.add_argument("--outdir", default="downloads", help="Folder for the CSVs (default: downloads)")
    p.add_argument("--app-format", action="store_true",
                   help="Write only date,<index>_close like the files in ./data")
    p.add_argument("--compare", help="Existing CSV to compare closes against (single index only)")
    a = p.parse_args()
    if a.compare and len(a.index) > 1:
        p.error("--compare works with one index at a time")

    start = datetime.strptime(a.start, "%Y-%m-%d").date() if a.start else None
    end = datetime.strptime(a.end, "%Y-%m-%d").date() if a.end else None
    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    status = 0
    for name in a.index:
        print(f"Downloading {name.upper()} ...")
        try:
            df = download_index_history(name, start, end)
        except DownloadError as e:
            print(f"ERROR: {e}")
            status = 1
            continue
        report_gaps(df)
        if a.compare:
            compare_with(df, a.compare)
        out = outdir / (name.strip().upper().replace(" ", "_") + ".csv")
        if a.app_format:
            df[["Date", "Close"]].rename(
                columns={"Date": "date", "Close": app_column_name(name)}
            ).to_csv(out, index=False, date_format="%Y-%m-%d")
        else:
            df.to_csv(out, index=False, date_format="%Y-%m-%d")
        print(f"Saved {len(df)} rows ({df['Date'].min():%d-%b-%Y} to "
              f"{df['Date'].max():%d-%b-%Y}) -> {out}\n")
    sys.exit(status)


if __name__ == "__main__":
    main()
