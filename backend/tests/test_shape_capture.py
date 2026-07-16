"""Shape capture: names + types only, never values — asserted, not assumed."""

import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
from hyundai_kia_connect_api.Vehicle import Vehicle

from app import shape_capture
from app.main import app
from app.shape_capture import ShapeStore


def test_record_never_records_values():
    store = ShapeStore()
    v = SimpleNamespace(
        fuel_level=62,
        username_looking_field="secret@example.com",
        is_locked=True,
        latitude=51.5072,
    )
    store.record("Kia", "USA", "HEV", v)
    dumped = json.dumps(store.snapshot())
    # Field names and Python type names only.
    assert "62" not in dumped
    assert "secret" not in dumped.lower()
    assert "51.5" not in dumped
    shape = store.snapshot()["Kia:USA:HEV"]
    assert shape["fuel_level"] == "int"
    assert shape["is_locked"] == "bool"
    assert shape["latitude"] == "float"


def test_record_real_vehicle_dataclass_excludes_raw_data():
    store = ShapeStore()
    v = Vehicle()
    v.data = {"raw": "payload"}
    store.record("Genesis", "Europe", "EV", v)
    shape = store.snapshot()["Genesis:Europe:EV"]
    assert "data" not in shape
    assert shape["fuel_level"] == "NoneType"  # blank Vehicle — types still typed


def test_one_shape_per_key_overwritten_on_change():
    store = ShapeStore()
    store.record("Kia", "USA", "EV", SimpleNamespace(a=1))
    store.record("Kia", "USA", "EV", SimpleNamespace(a=1.5))
    assert store.snapshot() == {"Kia:USA:EV": {"a": "float"}}


def test_persists_and_reloads(tmp_path):
    path = str(tmp_path / "shapes.json")
    store = ShapeStore(path)
    store.record("Kia", "USA", "HEV", SimpleNamespace(fuel_level=62))
    reloaded = ShapeStore(path)
    assert reloaded.snapshot() == {"Kia:USA:HEV": {"fuel_level": "int"}}


def test_unwritable_path_never_raises(tmp_path):
    store = ShapeStore(str(tmp_path / "no-such-dir" / "shapes.json"))
    store.record("Kia", "USA", "EV", SimpleNamespace(a=1))  # logs, doesn't raise
    assert store.snapshot() == {"Kia:USA:EV": {"a": "int"}}


def test_hostile_vehicle_never_raises():
    store = ShapeStore()
    store.record("Kia", "USA", "EV", 42)  # no __dict__, not a dataclass
    assert store.snapshot() == {}


# ---------------------------------------------------------------------------
# GET /debug/shapes token gate.

client = TestClient(app)


def test_debug_shapes_404_when_token_unset(monkeypatch):
    monkeypatch.delenv("SHAPES_DEBUG_TOKEN", raising=False)
    assert client.get("/debug/shapes").status_code == 404
    # Even a lucky guess of any header can't open an unconfigured gate.
    r = client.get("/debug/shapes", headers={"X-Debug-Token": ""})
    assert r.status_code == 404


def test_debug_shapes_404_on_wrong_token(monkeypatch):
    monkeypatch.setenv("SHAPES_DEBUG_TOKEN", "right-token")
    r = client.get("/debug/shapes", headers={"X-Debug-Token": "wrong-token"})
    assert r.status_code == 404


def test_debug_shapes_returns_snapshot_with_token(monkeypatch):
    monkeypatch.setenv("SHAPES_DEBUG_TOKEN", "right-token")
    shape_capture.store.record("Kia", "USA", "HEV", SimpleNamespace(fuel_level=62))
    r = client.get("/debug/shapes", headers={"X-Debug-Token": "right-token"})
    assert r.status_code == 200
    assert r.json()["Kia:USA:HEV"] == {"fuel_level": "int"}
