"""Car-reported warnings: per key, per parser path.

Structure mirrors test_powertrain.py, and for the same reason — the evidence
was gathered from real payloads through the lib's real parsers
(docs-internal/WARNINGS-FIELDS.md), so the tests run through them too:

1. Real fixtures through the real region parsers. Every fixture is a HEALTHY
   car, so these prove the "supported but silent" half: four keys provable,
   zero warnings emitted.
2. Synthetic FAULT payloads — the same fixtures with one raw flag flipped —
   for the firing half. **We hold no real fault specimen from any car.** That
   is the global confidence ceiling of this whole feature: these tests prove
   the plumbing reads the flag we believe is the lamp, not that the flag is
   the lamp.
3. Absence and type-surprise cases, which is where the landmines are: the
   CCS2 and EU-legacy parsers bool()-wrap the tyre flag with no None-guard,
   so an unsupported car and a healthy car are the same `False` and only the
   raw payload can tell them apart.
"""

import copy
import json
import pathlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from hyundai_kia_connect_api.ApiImplType1 import ApiImplType1
from hyundai_kia_connect_api.KiaUvoApiEU import KiaUvoApiEU
from hyundai_kia_connect_api.KiaUvoApiUSA import KiaUvoApiUSA
from hyundai_kia_connect_api.Vehicle import Vehicle

from app.warning_counts import WarningCountStore
from app.warnings import MAX_WARNING_AGE, WARNING_KEYS, WARNING_SPECS, evaluate

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)


def load_fixture(name: str) -> dict:
    with open(FIXTURES / name, encoding="utf-8") as f:
        return json.load(f)


# -- The three parser paths, fed a payload dict rather than a fixture name so
# -- a synthetic fault can be injected before parsing.


def parse_us(state: dict) -> Vehicle:
    api = KiaUvoApiUSA.__new__(KiaUvoApiUSA)
    api.data_timezone = None
    api.temperature_range = [62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82]
    vehicle = Vehicle()
    api._update_vehicle_properties(vehicle, state)
    return vehicle


def parse_eu(state: dict) -> Vehicle:
    api = KiaUvoApiEU.__new__(KiaUvoApiEU)
    api.data_timezone = KiaUvoApiEU.data_timezone
    api.temperature_range = KiaUvoApiEU.temperature_range
    vehicle = Vehicle()
    api._update_vehicle_properties(vehicle, state)
    return vehicle


def parse_ccs2(state: dict) -> Vehicle:
    api = ApiImplType1.__new__(ApiImplType1)
    api.data_timezone = None
    api.temperature_range = [x * 0.5 for x in range(28, 60)]
    vehicle = Vehicle()
    api._update_vehicle_properties_ccs2(vehicle, state)
    return vehicle


# Path name -> (parser, fixture, raw-path index into WarningSpec.raw_paths).
# The index order is the one WARNING_SPECS documents: CCS2, Kia-US, EU-legacy.
PATHS = {
    "ccs2": (parse_ccs2, "eu_kia_ev9_2024_ccs2.json", 0),
    "kia_us": (parse_us, "us_kia_niro_ev_2020_cached.json", 1),
    "kia_us_refresh": (parse_us, "us_kia_niro_ev_2020_force_refresh.json", 1),
    "eu_legacy": (parse_eu, "eu_kia_ev6_2023_with_soc.json", 2),
}
PATH_IDS = list(PATHS)
SPECS_BY_KEY = {spec.key: spec for spec in WARNING_SPECS}


def raw_set(state: dict, dotted: str, value) -> dict:
    """Set a dotted raw path, creating nothing: every path in these tests
    already exists in the fixture (that is itself the support evidence)."""
    node = state
    parts = dotted.split(".")
    for part in parts[:-1]:
        node = node[part]
    node[parts[-1]] = value
    return state


def raw_del(state: dict, dotted: str) -> dict:
    """Delete a dotted raw path — simulates a car that doesn't report it."""
    node = state
    parts = dotted.split(".")
    for part in parts[:-1]:
        node = node.get(part) if isinstance(node, dict) else None
        if node is None:
            return state
    node.pop(parts[-1], None)
    return state


def stamp(vehicle, when) -> None:
    """Set the car's reported timestamp, bypassing the lib's public setter.

    `Vehicle.last_updated_at`'s setter never goes backwards (it keeps the
    newer of old/new as a workaround for kia_uvo#931) and compares naive
    against aware — so assigning through it would silently refuse every
    older timestamp these tests depend on, and raise on a naive one."""
    vehicle._last_updated_at = when


def build(path_name: str, key: str | None = None, value=None, drop: str | None = None):
    """Parse a fixture through its real parser, optionally with one raw flag
    set to `value` (a fault) or one raw key deleted (an unsupporting car).
    The vehicle's timestamp is stamped fresh so the age gate is not what is
    under test here — it has its own tests below."""
    parse, fixture, index = PATHS[path_name]
    state = copy.deepcopy(load_fixture(fixture))
    if key is not None:
        raw_set(state, SPECS_BY_KEY[key].raw_paths[index], value)
    if drop is not None:
        raw_del(state, SPECS_BY_KEY[drop].raw_paths[index])
    vehicle = parse(state)
    stamp(vehicle, NOW - timedelta(minutes=1))
    return vehicle


# ---------------------------------------------------------------------------
# Layer 1: real fixtures — supported, and silent.


@pytest.mark.parametrize("path_name", PATH_IDS)
def test_healthy_real_fixture_emits_no_warnings(path_name):
    assert evaluate(build(path_name), now=NOW) == []


@pytest.mark.parametrize("path_name", PATH_IDS)
@pytest.mark.parametrize("key", WARNING_KEYS)
def test_every_key_is_provably_supported_on_every_real_fixture(path_name, key):
    """The support half of the contract, per key per path: all four raw keys
    are present on all three production/fixture payload shapes, which is why
    these four (and not `dtc_present` or `window_open`) are the first cut."""
    _, fixture, index = PATHS[path_name]
    state = load_fixture(fixture)
    node = state
    for part in SPECS_BY_KEY[key].raw_paths[index].split("."):
        assert isinstance(node, dict) and part in node, (
            f"{key} not reported by {fixture}"
        )
        node = node[part]


# ---------------------------------------------------------------------------
# Layer 2: synthetic faults — one flag flipped, per key, per parser path.
#
# Both truthy spellings are exercised because the same flag is a bool in one
# region and an int in the next; `is True` would silently drop half of these,
# which is exactly how fuel_level_is_low burned us before.


@pytest.mark.parametrize("path_name", PATH_IDS)
@pytest.mark.parametrize("key", WARNING_KEYS)
@pytest.mark.parametrize("fault", [1, True])
def test_each_key_fires_on_each_path(path_name, key, fault):
    assert evaluate(build(path_name, key, fault), now=NOW) == [key]


@pytest.mark.parametrize("path_name", PATH_IDS)
@pytest.mark.parametrize("key", WARNING_KEYS)
@pytest.mark.parametrize("healthy", [0, False])
def test_each_key_stays_silent_when_the_flag_reads_healthy(path_name, key, healthy):
    assert evaluate(build(path_name, key, healthy), now=NOW) == []


@pytest.mark.parametrize("path_name", PATH_IDS)
def test_all_four_fire_in_severity_order(path_name):
    parse, fixture, index = PATHS[path_name]
    state = copy.deepcopy(load_fixture(fixture))
    for spec in WARNING_SPECS:
        raw_set(state, spec.raw_paths[index], 1)
    vehicle = parse(state)
    stamp(vehicle, NOW - timedelta(minutes=1))
    # Brake fluid first, washer fluid last — the glasses render warnings[0]
    # and nothing else, so this order is part of the API contract.
    assert evaluate(vehicle, now=NOW) == [
        "brake_fluid_low",
        "tyre_pressure_low",
        "smart_key_battery_low",
        "washer_fluid_low",
    ]


# ---------------------------------------------------------------------------
# Layer 3: the absence-erasure landmine.


@pytest.mark.parametrize("path_name", PATH_IDS)
@pytest.mark.parametrize("key", WARNING_KEYS)
def test_a_car_that_does_not_report_the_key_never_warns(path_name, key):
    """Delete the raw key: the car no longer reports the flag at all. On the
    passthrough keys the parsed value becomes None; on the bool()-wrapped ones
    it becomes a perfectly innocent-looking `False`. Either way the key must
    silently not exist for this car."""
    vehicle = build(path_name, drop=key)
    assert evaluate(vehicle, now=NOW) == []
    # And it stays silent even if something downstream sets the attribute
    # truthy — support is proven from the payload, not from the attribute.
    setattr(vehicle, SPECS_BY_KEY[key].attr, True)
    assert evaluate(vehicle, now=NOW) == []


@pytest.mark.parametrize("path_name", ["ccs2", "eu_legacy"])
def test_bool_wrap_erasure_is_caught_for_tyres(path_name):
    """The specific landmine WARNINGS-FIELDS calls load-bearing. CCS2 wraps
    the tyre flag in a bare bool(); so does EU-legacy (KiaUvoApiEU.py:599 — a
    correction to the doc's table, which listed EU-legacy tyre as int|None).
    With the raw key gone the parser still yields a real False, so `is not
    None` would wrongly read that as proof of support."""
    vehicle = build(path_name, drop="tyre_pressure_low")
    assert vehicle.tire_pressure_all_warning_is_on is False  # not None!
    assert evaluate(vehicle, now=NOW) == []


def test_ccs2_smart_key_bool_wrap_erasure_is_caught():
    vehicle = build("ccs2", drop="smart_key_battery_low")
    assert vehicle.smart_key_battery_warning_is_on is False  # not None!
    assert evaluate(vehicle, now=NOW) == []


# ---------------------------------------------------------------------------
# Layer 4: type surprises. Anything that is not a flag is unsupported, never
# a warning — `"0"` is truthy, and that is the whole lesson of dtc_count.


@pytest.mark.parametrize("key", WARNING_KEYS)
@pytest.mark.parametrize("surprise", ["0", "1", "true", [], [1], {}, {"a": 1}, object()])
def test_type_surprises_are_unsupported_not_warnings(key, surprise):
    vehicle = build("ccs2")
    setattr(vehicle, SPECS_BY_KEY[key].attr, surprise)
    assert evaluate(vehicle, now=NOW) == []


def test_float_flags_are_read_truthily():
    """Nominally-integer values arrive as floats without warning elsewhere in
    this API (LaxInt exists for that), so a float flag is read, not refused."""
    vehicle = build("ccs2")
    vehicle.brake_fluid_warning_is_on = 1.0
    assert evaluate(vehicle, now=NOW) == ["brake_fluid_low"]


def test_unknown_payload_shape_falls_back_to_is_not_none_for_passthroughs():
    """A payload shape none of our three spellings match (another region or
    brand). A non-bool parsed value would have been None if absent, so it
    proves support; the value 1 then fires."""
    vehicle = SimpleNamespace(
        data={"someOtherRegion": {"brakeFluid": 1}},
        brake_fluid_warning_is_on=1,
        last_updated_at=NOW,
    )
    assert evaluate(vehicle, now=NOW) == ["brake_fluid_low"]


def test_unknown_payload_shape_refuses_a_bare_bool():
    """Same unknown shape, but the value is a plain bool — indistinguishable
    from a bool()-wrapped absence. Refused: an unprovable key does not exist."""
    vehicle = SimpleNamespace(
        data={"someOtherRegion": {"brakeFluid": True}},
        brake_fluid_warning_is_on=True,
        last_updated_at=NOW,
    )
    assert evaluate(vehicle, now=NOW) == []


def test_missing_raw_payload_entirely_is_survivable():
    vehicle = SimpleNamespace(data=None, brake_fluid_warning_is_on=1, last_updated_at=NOW)
    assert evaluate(vehicle, now=NOW) == ["brake_fluid_low"]


def test_evaluate_never_raises_on_a_hostile_object():
    class Hostile:
        @property
        def data(self):
            raise RuntimeError("boom")

        @property
        def last_updated_at(self):
            raise RuntimeError("boom")

    assert evaluate(Hostile(), now=NOW) == []


# ---------------------------------------------------------------------------
# Layer 5: the freshness gate. A warning is a claim about the car RIGHT NOW.


@pytest.mark.parametrize(
    "age, expected",
    [
        (timedelta(0), ["brake_fluid_low"]),
        (MAX_WARNING_AGE - timedelta(minutes=1), ["brake_fluid_low"]),
        (MAX_WARNING_AGE, ["brake_fluid_low"]),  # boundary is inclusive
        (MAX_WARNING_AGE + timedelta(minutes=1), []),
        (timedelta(days=1), []),
    ],
)
def test_warnings_are_suppressed_once_the_car_data_is_old(age, expected):
    vehicle = build("ccs2", "brake_fluid_low", 1)
    stamp(vehicle, NOW - age)
    assert evaluate(vehicle, now=NOW) == expected


def test_no_timestamp_means_no_warnings():
    """Freshness unprovable — same treatment as support unprovable."""
    vehicle = build("ccs2", "brake_fluid_low", 1)
    stamp(vehicle, None)
    assert evaluate(vehicle, now=NOW) == []


def test_naive_timestamps_are_read_as_utc():
    vehicle = build("ccs2", "brake_fluid_low", 1)
    stamp(vehicle, (NOW - timedelta(minutes=5)).replace(tzinfo=None))
    assert evaluate(vehicle, now=NOW) == ["brake_fluid_low"]


def test_a_car_clock_running_fast_is_not_treated_as_stale():
    vehicle = build("ccs2", "brake_fluid_low", 1)
    stamp(vehicle, NOW + timedelta(minutes=10))
    assert evaluate(vehicle, now=NOW) == ["brake_fluid_low"]


# ---------------------------------------------------------------------------
# Anonymous counters. What is NOT recorded matters more than what is.


def test_counts_are_per_brand_region_key_and_nothing_else(tmp_path):
    store = WarningCountStore(str(tmp_path / "warning-counts.json"))
    store.record("Kia", "USA", ["brake_fluid_low", "washer_fluid_low"])
    store.record("Kia", "USA", ["brake_fluid_low"])
    store.record("Genesis", "Europe", ["brake_fluid_low"])
    assert store.snapshot() == {
        "Kia:USA:brake_fluid_low": 2,
        "Kia:USA:washer_fluid_low": 1,
        "Genesis:Europe:brake_fluid_low": 1,
    }


def test_healthy_cars_write_nothing(tmp_path):
    path = tmp_path / "warning-counts.json"
    store = WarningCountStore(str(path))
    store.record("Kia", "USA", [])
    assert store.snapshot() == {}
    assert not path.exists()


def test_counts_survive_a_restart(tmp_path):
    path = str(tmp_path / "warning-counts.json")
    WarningCountStore(path).record("Kia", "USA", ["tyre_pressure_low"])
    # A redeploy: new process, same volume. Losing the first-ever real fault
    # specimen to a restart would cost months of waiting for another.
    assert WarningCountStore(path).snapshot() == {"Kia:USA:tyre_pressure_low": 1}


def test_memory_only_when_no_path_is_configured():
    store = WarningCountStore(None)
    store.record("Kia", "USA", ["tyre_pressure_low"])
    assert store.snapshot() == {"Kia:USA:tyre_pressure_low": 1}


def test_corrupt_count_file_is_quarantined_not_overwritten(tmp_path):
    path = tmp_path / "warning-counts.json"
    path.write_text("{not json", encoding="utf-8")
    store = WarningCountStore(str(path))
    assert store.snapshot() == {}
    assert (tmp_path / "warning-counts.json.corrupt").read_text() == "{not json"


def test_record_never_raises(tmp_path):
    store = WarningCountStore(str(tmp_path / "nonexistent-dir" / "counts.json"))
    store.record("Kia", "USA", ["brake_fluid_low"])  # unwritable path
    assert store.snapshot() == {"Kia:USA:brake_fluid_low": 1}


def test_snapshot_is_a_copy(tmp_path):
    store = WarningCountStore(None)
    store.record("Kia", "USA", ["brake_fluid_low"])
    store.snapshot()["Kia:USA:brake_fluid_low"] = 999
    assert store.snapshot() == {"Kia:USA:brake_fluid_low": 1}
