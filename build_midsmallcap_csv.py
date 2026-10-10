"""
Builds two CSVs from data/amidata (AmiBroker database):
  data/NIFTY_MIDCAP_2001_2026.csv
  data/NIFTY_SMALLCAP_2009_2026.csv

Each is a single continuous daily-close series, spliced from the renamed
history of one NSE index. Splices are verified same-index joins (identical
price on every overlapping day between adjacent source files), not rescaled
approximations. See README section on these files for the verification.
"""

import csv
import datetime
import struct
from pathlib import Path

AMIDATA = Path(__file__).parent / "data" / "amidata"
OUT_DIR = Path(__file__).parent / "data"


def read_amibroker(path):
    """{date: close} from an AmiBroker BROKDAt5 binary file."""
    data = path.read_bytes()
    if not data.startswith(b"BROKDAt5"):
        raise ValueError(f"{path} is not a BROKDAt5 file")
    out = {}
    off = 1184
    while off + 40 <= len(data):
        (packed,) = struct.unpack_from("<Q", data, off)
        high = packed >> 32
        y, m, d = high >> 20, (high >> 16) & 0xF, (high >> 11) & 0x1F
        (close,) = struct.unpack_from("<f", data, off + 8)
        try:
            dt = datetime.date(y, m, d)
        except ValueError:
            break
        if not 1980 <= y <= 2100 or close <= 0:
            break
        out[dt] = close
        off += 40
    return out


def splice(*sources):
    """Later sources win on overlapping dates (they supersede the earlier name)."""
    merged = {}
    for path in sources:
        merged.update(read_amibroker(path))
    return merged


def write_csv(path, series, label):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", f"{label}_close"])
        for dt in sorted(series):
            w.writerow([dt.isoformat(), series[dt]])


def main():
    midcap = splice(
        AMIDATA / "n" / "NSEMIDCAP",        # 2001-01-01 -> 2014-06-18
        AMIDATA / "c" / "CNX MIDCAP",        # 2009-04-01 -> 2015-11-06 (same index, renamed)
        AMIDATA / "n" / "NIFTY MIDCAP 100",  # 2015-11-06 -> present   (same index, renamed again)
    )
    write_csv(OUT_DIR / "NIFTY_MIDCAP_2001_2026.csv", midcap, "nifty_midcap")
    dates = sorted(midcap)
    print(f"Midcap:   {len(dates)} rows, {dates[0]} -> {dates[-1]}")

    smallcap = splice(
        AMIDATA / "c" / "CNX SMALLCAP",         # 2009-04-01 -> 2015-11-06
        AMIDATA / "n" / "NIFTY SMALL 100",       # 2015-11-17 -> 2021-01-08 (same index, renamed)
        # GAP: no source file covers 2021-01-09 -> 2024-07-14 (not filled/estimated)
        AMIDATA / "n" / "NIFTY SMALLCAP 100",    # 2024-07-15 -> present
    )
    write_csv(OUT_DIR / "NIFTY_SMALLCAP_2009_2026.csv", smallcap, "nifty_smallcap")
    dates = sorted(smallcap)
    gap_start = datetime.date(2021, 1, 9)
    gap_end = datetime.date(2024, 7, 14)
    print(f"Smallcap: {len(dates)} rows, {dates[0]} -> {dates[-1]}"
          f"  (GAP: {gap_start} to {gap_end}, no data in source)")


if __name__ == "__main__":
    main()
