"""
Allocation storage for the backtester (Buy & Hold and Rebalancing pages).

Every page and API endpoint goes through AllocationStore, never the JSON file
directly, so the backend can later be switched to a database by changing only
this module.

Current backend: config/asset_allocations.json
  - written to a temp file in the same folder, then atomically renamed over the
    real file, so a crash never leaves a half-written file;
  - recreated with the predefined allocations when it is missing.

An allocation stores only weights (no rebalance settings): the page decides
whether and how often to rebalance, so one allocation is reused on both pages.
"""

import copy
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent / "config" / "asset_allocations.json"
WEIGHT_TOLERANCE = 0.01      # weights must add up to 100 +- this
NAME_MAX = 50

# Asset config. "loader" tells daily_data.py how to build the daily price series;
# adding an asset (e.g. SILVER, MIDCAP) = a new entry here + a loader mapping there.
DEFAULT_ASSETS = {
    "NIFTY": {"label": "Nifty 50", "symbol": "NIFTY", "loader": "index", "color": "#3b82f6",
              "source": "TradeEntry /chart-data NIFTY daily close (price index)"},
    "GOLD": {"label": "Gold", "symbol": "MCX GOLD (masid 2) + GOLDINR", "loader": "gold_india", "color": "#facc15",
             "source": "MCX Gold spot from 2005-06-06; before that GOLDINR x matching factor; x 1.03 GST"},
    "BOND": {"label": "Bond", "symbol": "INDIA_GSEC_COMPOSITE + in_fixed_deposit_rate", "loader": "bond_chained",
             "color": "#22c55e",
             "source": "NIFTY Composite G-sec Index from 2015-10-13; before that the SBI FD rate compounded daily"},
    "CASH": {"label": "Cash", "annual_return_pct": 0, "loader": "fixed_rate", "color": "#a3a3a3",
             "source": "No price data: annual_return_pct compounded over 252 trading days"},
}

PREDEFINED = [
    ("gold_nifty_50_50", "Gold + Nifty", {"NIFTY": 50, "GOLD": 50}),
    ("gold_bond_50_50", "Gold + Bond", {"GOLD": 50, "BOND": 50}),
    ("bond_nifty_50_50", "Bond + Nifty", {"NIFTY": 50, "BOND": 50}),
    ("classic_60_40", "Classic 60/40", {"NIFTY": 60, "BOND": 40}),
    ("equity_gold_70_30", "Equity + Gold Hedge", {"NIFTY": 70, "GOLD": 30}),
    ("equity_cash_80_20", "Equity + Cash Buffer", {"NIFTY": 80, "CASH": 20}),
    ("equal_weight_4", "Equal Weight", {"NIFTY": 25, "GOLD": 25, "BOND": 25, "CASH": 25}),
    ("balanced_4_asset", "Balanced 4-Asset", {"NIFTY": 50, "GOLD": 20, "BOND": 20, "CASH": 10}),
    ("growth_4_asset", "Growth 4-Asset", {"NIFTY": 60, "GOLD": 20, "BOND": 10, "CASH": 10}),
    ("conservative_4_asset", "Conservative", {"NIFTY": 20, "GOLD": 10, "BOND": 50, "CASH": 20}),
]


def default_document():
    return {
        "version": 1,
        "assets": copy.deepcopy(DEFAULT_ASSETS),
        "allocations": [{"id": i, "name": n, "type": "predefined", "weights": dict(w)} for i, n, w in PREDEFINED],
    }


# ---------- errors (each carries the HTTP status the API should answer with) ----------

class AllocationError(Exception):
    status = 400

    def __init__(self, message, errors=None):
        super().__init__(message)
        self.errors = errors or [message]


class ValidationError(AllocationError):
    status = 422


class NotFoundError(AllocationError):
    status = 404


class ReadOnlyError(AllocationError):
    status = 403


# ---------- validation ----------

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return s or "allocation"


def clean_weights(weights, assets):
    """Validate a {asset: weight} dict. Returns the weights with zero entries removed,
    or raises ValidationError listing every problem."""
    errors = []
    if not isinstance(weights, dict):
        raise ValidationError("Weights must be an object like {\"NIFTY\": 60, \"BOND\": 40}.")
    cleaned = {}
    for key, value in weights.items():
        asset = str(key).strip().upper()
        if asset not in assets:
            errors.append(f"Unknown asset '{key}'. Use one of: {', '.join(assets)}.")
            continue
        try:
            w = float(value)
        except (TypeError, ValueError):
            errors.append(f"Weight for {asset} must be a number.")
            continue
        if w != w or w in (float("inf"), float("-inf")):
            errors.append(f"Weight for {asset} must be a number.")
        elif w < 0:
            errors.append(f"Weight for {asset} cannot be negative ({w:g}).")
        elif w > 0:
            cleaned[asset] = cleaned.get(asset, 0.0) + w
    if not errors:
        if not cleaned:
            errors.append("Give at least one asset a weight above 0.")
        else:
            total = sum(cleaned.values())
            if abs(total - 100) > WEIGHT_TOLERANCE:
                errors.append(f"Weights must add up to 100 (now {round(total, 4):g}).")
    if errors:
        raise ValidationError(errors[0], errors)
    return {k: (int(v) if float(v).is_integer() else round(v, 4)) for k, v in cleaned.items()}


def clean_name(name, existing, exclude_id=None):
    """Trimmed name; required, at most NAME_MAX characters, unique (case-insensitive)."""
    if not isinstance(name, str) or not name.strip():
        raise ValidationError("Name is required.")
    name = " ".join(name.split())
    if len(name) > NAME_MAX:
        raise ValidationError(f"Name can be at most {NAME_MAX} characters (now {len(name)}).")
    for a in existing:
        if a["id"] != exclude_id and a["name"].lower() == name.lower():
            raise ValidationError(f"An allocation named '{a['name']}' already exists.")
    return name


# ---------- store ----------

class AllocationStore:
    """JSON-file backed allocation store. Thread-safe within one process."""

    def __init__(self, path=DEFAULT_PATH):
        self.path = Path(path)
        self._lock = threading.RLock()

    # -- file handling --
    def _read(self):
        if not self.path.exists():
            doc = default_document()
            self._write(doc)
            return doc
        try:
            with open(self.path, encoding="utf-8") as f:
                doc = json.load(f)
        except json.JSONDecodeError as e:
            raise AllocationError(f"{self.path.name} is not valid JSON ({e.msg}, line {e.lineno}). "
                                  "Fix it or delete it to recreate the predefined allocations.") from e
        doc.setdefault("version", 1)
        doc.setdefault("assets", copy.deepcopy(DEFAULT_ASSETS))
        doc.setdefault("allocations", [])
        # predefined allocations are always present, even if someone removed them from the file
        have = {a["id"] for a in doc["allocations"]}
        missing = [{"id": i, "name": n, "type": "predefined", "weights": dict(w)} for i, n, w in PREDEFINED if i not in have]
        if missing:
            doc["allocations"] = missing + doc["allocations"]
            self._write(doc)
        return doc

    def _write(self, doc):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f, indent=2, ensure_ascii=False)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)          # atomic on the same filesystem
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    @staticmethod
    def _sorted(allocs):
        return [a for a in allocs if a.get("type") == "predefined"] + [a for a in allocs if a.get("type") != "predefined"]

    def _find(self, doc, alloc_id):
        for a in doc["allocations"]:
            if a["id"] == alloc_id:
                return a
        raise NotFoundError(f"Allocation '{alloc_id}' not found.")

    def _unique_id(self, doc, name):
        base = slugify(name)
        ids = {a["id"] for a in doc["allocations"]}
        if base not in ids:
            return base
        n = 2
        while f"{base}_{n}" in ids:
            n += 1
        return f"{base}_{n}"

    # -- public interface --
    def get_assets(self):
        with self._lock:
            return copy.deepcopy(self._read()["assets"])

    def list_allocations(self):
        with self._lock:
            return copy.deepcopy(self._sorted(self._read()["allocations"]))

    def get_allocation(self, alloc_id):
        with self._lock:
            return copy.deepcopy(self._find(self._read(), alloc_id))

    def create_allocation(self, data):
        with self._lock:
            doc = self._read()
            name = clean_name((data or {}).get("name"), doc["allocations"])
            weights = clean_weights((data or {}).get("weights"), doc["assets"])
            now = _now()
            alloc = {"id": self._unique_id(doc, name), "name": name, "type": "custom", "weights": weights,
                     "created_at": now, "updated_at": now}
            doc["allocations"].append(alloc)
            self._write(doc)
            return copy.deepcopy(alloc)

    def update_allocation(self, alloc_id, data):
        with self._lock:
            doc = self._read()
            alloc = self._find(doc, alloc_id)
            if alloc.get("type") == "predefined":
                raise ReadOnlyError(f"'{alloc['name']}' is predefined and cannot be edited. Duplicate it instead.")
            data = data or {}
            if "name" in data:
                alloc["name"] = clean_name(data["name"], doc["allocations"], exclude_id=alloc_id)
            if "weights" in data:
                alloc["weights"] = clean_weights(data["weights"], doc["assets"])
            alloc["updated_at"] = _now()
            self._write(doc)
            return copy.deepcopy(alloc)

    def delete_allocation(self, alloc_id):
        with self._lock:
            doc = self._read()
            alloc = self._find(doc, alloc_id)
            if alloc.get("type") == "predefined":
                raise ReadOnlyError(f"'{alloc['name']}' is predefined and cannot be deleted.")
            doc["allocations"] = [a for a in doc["allocations"] if a["id"] != alloc_id]
            self._write(doc)
            return copy.deepcopy(alloc)

    def duplicate_allocation(self, alloc_id, new_name):
        with self._lock:
            src = self.get_allocation(alloc_id)
            return self.create_allocation({"name": new_name, "weights": src["weights"]})

    def export_document(self):
        with self._lock:
            doc = self._read()
            return {"version": doc["version"], "assets": copy.deepcopy(doc["assets"]),
                    "allocations": copy.deepcopy(self._sorted(doc["allocations"]))}

    def import_allocations(self, payload):
        """Import allocations from an exported document (or a plain list). Each entry is validated
        and saved as custom; entries whose name or id already exist are skipped.
        Returns {"imported": [...], "skipped": [{"name", "reason"}], "failed": [{"name", "errors"}]}."""
        items = payload.get("allocations") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise ValidationError("Import file must contain an \"allocations\" list.")
        summary = {"imported": [], "skipped": [], "failed": []}
        with self._lock:
            for item in items:
                name = (item or {}).get("name") if isinstance(item, dict) else None
                label = name if isinstance(name, str) and name.strip() else "(no name)"
                if not isinstance(item, dict):
                    summary["failed"].append({"name": label, "errors": ["Entry is not an object."]})
                    continue
                doc = self._read()
                if isinstance(name, str) and any(a["name"].lower() == " ".join(name.split()).lower() for a in doc["allocations"]):
                    summary["skipped"].append({"name": label, "reason": "an allocation with this name already exists"})
                    continue
                if item.get("id") and any(a["id"] == item["id"] for a in doc["allocations"]):
                    summary["skipped"].append({"name": label, "reason": "an allocation with this id already exists"})
                    continue
                try:
                    created = self.create_allocation({"name": name, "weights": item.get("weights")})
                    summary["imported"].append(created)
                except ValidationError as e:
                    summary["failed"].append({"name": label, "errors": e.errors})
        return summary
