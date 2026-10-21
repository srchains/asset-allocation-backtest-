"""Small helpers shared by the test files."""
from datetime import date, timedelta


def weekdays(start, end, skip=()):
    """ISO dates of the weekdays from start to end (inclusive), leaving out the ones in skip."""
    d, out = date.fromisoformat(start), []
    while d <= date.fromisoformat(end):
        if d.weekday() < 5 and d.isoformat() not in skip:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out
