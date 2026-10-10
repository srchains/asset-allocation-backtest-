"""Tests for allocation_store.py: validation, predefined protection, file handling, import/export."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from allocation_store import (
    AllocationStore, ValidationError, ReadOnlyError, NotFoundError, AllocationError, PREDEFINED, slugify,
)


@pytest.fixture
def store(tmp_path):
    return AllocationStore(tmp_path / "config" / "asset_allocations.json")


# ---------- file handling ----------

class TestFile:
    def test_missing_file_is_recreated_with_predefined(self, tmp_path):
        path = tmp_path / "config" / "asset_allocations.json"
        assert not path.exists()
        st = AllocationStore(path)
        allocs = st.list_allocations()
        assert path.exists()
        assert [a["id"] for a in allocs] == [p[0] for p in PREDEFINED]
        assert all(a["type"] == "predefined" for a in allocs)
        doc = json.loads(path.read_text(encoding="utf-8"))
        assert doc["version"] == 1 and set(doc["assets"]) == {"NIFTY", "GOLD", "BOND", "CASH"}
        assert doc["assets"]["CASH"]["annual_return_pct"] == 0

    def test_deleted_file_comes_back(self, store):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 100}})
        store.path.unlink()
        assert len(store.list_allocations()) == len(PREDEFINED)

    def test_write_leaves_valid_json_and_no_temp_files(self, store):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 70, "GOLD": 30}})
        store.update_allocation("mine", {"weights": {"NIFTY": 60, "GOLD": 40}})
        json.loads(store.path.read_text(encoding="utf-8"))
        assert [p.name for p in store.path.parent.iterdir()] == [store.path.name]

    def test_corrupt_file_is_reported_not_overwritten(self, store):
        store.list_allocations()
        store.path.write_text("{ not json", encoding="utf-8")
        with pytest.raises(AllocationError, match="not valid JSON"):
            store.list_allocations()
        assert store.path.read_text(encoding="utf-8") == "{ not json"

    def test_predefined_restored_if_removed_from_file(self, store):
        store.list_allocations()
        doc = json.loads(store.path.read_text(encoding="utf-8"))
        doc["allocations"] = [a for a in doc["allocations"] if a["id"] != "classic_60_40"]
        store.path.write_text(json.dumps(doc), encoding="utf-8")
        assert "classic_60_40" in [a["id"] for a in store.list_allocations()]


# ---------- validation ----------

class TestValidation:
    def test_sum_not_100(self, store):
        with pytest.raises(ValidationError, match="add up to 100"):
            store.create_allocation({"name": "Bad", "weights": {"NIFTY": 60, "GOLD": 30}})

    def test_sum_within_tolerance_is_ok(self, store):
        a = store.create_allocation({"name": "Thirds", "weights": {"NIFTY": 33.333, "GOLD": 33.333, "BOND": 33.334}})
        assert sum(a["weights"].values()) == pytest.approx(100)
        a = store.create_allocation({"name": "Almost", "weights": {"NIFTY": 50.005, "GOLD": 49.999}})
        assert a["type"] == "custom"

    def test_negative_weight(self, store):
        with pytest.raises(ValidationError, match="cannot be negative"):
            store.create_allocation({"name": "Neg", "weights": {"NIFTY": 120, "GOLD": -20}})

    def test_unknown_asset(self, store):
        with pytest.raises(ValidationError, match="Unknown asset 'SILVER'"):
            store.create_allocation({"name": "Silver", "weights": {"NIFTY": 50, "SILVER": 50}})

    def test_non_number_weight(self, store):
        with pytest.raises(ValidationError, match="must be a number"):
            store.create_allocation({"name": "Txt", "weights": {"NIFTY": "lots"}})

    def test_zero_weights_are_removed(self, store):
        a = store.create_allocation({"name": "Zeros", "weights": {"NIFTY": 100, "GOLD": 0, "BOND": 0}})
        assert a["weights"] == {"NIFTY": 100}

    def test_at_least_one_asset(self, store):
        with pytest.raises(ValidationError, match="at least one asset"):
            store.create_allocation({"name": "Empty", "weights": {"NIFTY": 0}})

    def test_lowercase_asset_keys_are_accepted(self, store):
        a = store.create_allocation({"name": "Lower", "weights": {"nifty": 60, "bond": 40}})
        assert a["weights"] == {"NIFTY": 60, "BOND": 40}

    def test_duplicate_name_case_insensitive(self, store):
        with pytest.raises(ValidationError, match="already exists"):
            store.create_allocation({"name": "classic 60/40", "weights": {"NIFTY": 100}})

    def test_name_required_and_max_length(self, store):
        with pytest.raises(ValidationError, match="Name is required"):
            store.create_allocation({"name": "   ", "weights": {"NIFTY": 100}})
        with pytest.raises(ValidationError, match="at most 50"):
            store.create_allocation({"name": "x" * 51, "weights": {"NIFTY": 100}})
        a = store.create_allocation({"name": "y" * 50, "weights": {"NIFTY": 100}})
        assert len(a["name"]) == 50

    def test_all_problems_are_listed(self, store):
        with pytest.raises(ValidationError) as e:
            store.create_allocation({"name": "Many", "weights": {"SILVER": 10, "NIFTY": -5}})
        assert len(e.value.errors) == 2


# ---------- create / update / delete / duplicate ----------

class TestCrud:
    def test_create_generates_slug_id_and_timestamps(self, store):
        a = store.create_allocation({"name": "My  Growth Mix!", "weights": {"NIFTY": 80, "GOLD": 20}})
        assert a["id"] == "my_growth_mix" and a["name"] == "My Growth Mix!"
        assert a["type"] == "custom" and a["created_at"] and a["updated_at"]
        assert store.get_allocation("my_growth_mix")["weights"] == {"NIFTY": 80, "GOLD": 20}

    def test_ids_stay_unique(self, store):
        store.create_allocation({"name": "Mix A", "weights": {"NIFTY": 100}})
        b = store.create_allocation({"name": "Mix-A", "weights": {"GOLD": 100}})
        assert b["id"] == "mix_a_2"

    def test_list_predefined_first(self, store):
        store.create_allocation({"name": "Aaa first alphabetically", "weights": {"NIFTY": 100}})
        allocs = store.list_allocations()
        assert [a["type"] for a in allocs] == ["predefined"] * len(PREDEFINED) + ["custom"]

    def test_update_custom(self, store):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 100}})
        u = store.update_allocation("mine", {"name": "Mine v2", "weights": {"NIFTY": 50, "CASH": 50}})
        assert u["id"] == "mine" and u["name"] == "Mine v2" and u["weights"] == {"NIFTY": 50, "CASH": 50}

    def test_update_keeps_own_name(self, store):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 100}})
        assert store.update_allocation("mine", {"name": "MINE"})["name"] == "MINE"

    def test_delete_custom(self, store):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 100}})
        store.delete_allocation("mine")
        with pytest.raises(NotFoundError):
            store.get_allocation("mine")

    def test_predefined_cannot_be_edited_or_deleted(self, store):
        with pytest.raises(ReadOnlyError):
            store.update_allocation("classic_60_40", {"weights": {"NIFTY": 100}})
        with pytest.raises(ReadOnlyError):
            store.delete_allocation("classic_60_40")
        assert store.get_allocation("classic_60_40")["weights"] == {"NIFTY": 60, "BOND": 40}

    def test_duplicate_predefined_as_custom(self, store):
        d = store.duplicate_allocation("classic_60_40", "My 60/40")
        assert d["type"] == "custom" and d["weights"] == {"NIFTY": 60, "BOND": 40}
        with pytest.raises(ValidationError, match="already exists"):
            store.duplicate_allocation("classic_60_40", "My 60/40")

    def test_not_found(self, store):
        with pytest.raises(NotFoundError):
            store.get_allocation("nope")


# ---------- export / import ----------

class TestImportExport:
    def test_export_then_import_skips_existing(self, store, tmp_path):
        store.create_allocation({"name": "Mine", "weights": {"NIFTY": 90, "GOLD": 10}})
        exported = store.export_document()
        assert len(exported["allocations"]) == len(PREDEFINED) + 1
        other = AllocationStore(tmp_path / "other.json")
        s1 = other.import_allocations(exported)
        assert [a["name"] for a in s1["imported"]] == ["Mine"]
        assert len(s1["skipped"]) == len(PREDEFINED) and not s1["failed"]
        s2 = other.import_allocations(exported)
        assert not s2["imported"] and len(s2["skipped"]) == len(PREDEFINED) + 1

    def test_import_reports_invalid_entries(self, store):
        res = store.import_allocations({"allocations": [
            {"name": "Good one", "weights": {"NIFTY": 100}},
            {"name": "Bad sum", "weights": {"NIFTY": 10}},
            {"name": "Bad asset", "weights": {"COPPER": 100}},
            "not an object",
        ]})
        assert [a["name"] for a in res["imported"]] == ["Good one"]
        assert [f["name"] for f in res["failed"]] == ["Bad sum", "Bad asset", "(no name)"]

    def test_import_needs_a_list(self, store):
        with pytest.raises(ValidationError):
            store.import_allocations({"something": 1})


def test_slugify():
    assert slugify("Gold + Nifty 50/50") == "gold_nifty_50_50"
    assert slugify("!!!") == "allocation"
