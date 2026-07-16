"""Powertrain detection and fuel-field gating.

Two layers, matching how the evidence was gathered (see
docs-internal/POWERTRAIN-FIELDS.md):

1. Real fixtures through the lib's real region parsers (tests/fixtures/ —
   all EVs; the lib ships no HEV/PHEV/ICE samples). These prove the two
   landmines are handled: every EV reports fuelLevel 0, and Kia-US EVs can
   get fuel_driving_range populated via the distanceToEmpty fallback.
2. Synthetic vehicles for the powertrains no fixture exists for, built from
   the parsers' documented behavior — including UNKNOWN/conflict cases.
"""

import json
import pathlib
from types import SimpleNamespace

import pytest
from hyundai_kia_connect_api.ApiImplType1 import ApiImplType1
from hyundai_kia_connect_api.const import ENGINE_TYPES
from hyundai_kia_connect_api.KiaUvoApiEU import KiaUvoApiEU
from hyundai_kia_connect_api.KiaUvoApiUSA import KiaUvoApiUSA
from hyundai_kia_connect_api.Vehicle import Vehicle

from app.providers.genesis import GenesisProvider, _detect_powertrain

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    with open(FIXTURES / name, encoding="utf-8") as f:
        return json.load(f)


def make_provider(vehicle) -> GenesisProvider:
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._vehicle_id = "v1"
    provider._vm = SimpleNamespace(vehicles={"v1": vehicle})
    provider._powertrain = None
    provider._brand_name = "Kia"
    provider._region_name = "USA"
    return provider


def parse_us(fixture_name: str) -> Vehicle:
    api = KiaUvoApiUSA.__new__(KiaUvoApiUSA)
    api.data_timezone = None
    api.temperature_range = [62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82]
    vehicle = Vehicle()
    api._update_vehicle_properties(vehicle, load_fixture(fixture_name))
    return vehicle


def parse_eu(fixture_name: str) -> Vehicle:
    api = KiaUvoApiEU.__new__(KiaUvoApiEU)
    api.data_timezone = KiaUvoApiEU.data_timezone
    api.temperature_range = KiaUvoApiEU.temperature_range
    vehicle = Vehicle()
    api._update_vehicle_properties(vehicle, load_fixture(fixture_name))
    return vehicle


def parse_ccs2(fixture_name: str) -> Vehicle:
    api = ApiImplType1.__new__(ApiImplType1)
    api.data_timezone = None
    api.temperature_range = [x * 0.5 for x in range(28, 60)]
    vehicle = Vehicle()
    api._update_vehicle_properties_ccs2(vehicle, load_fixture(fixture_name))
    return vehicle


# ---------------------------------------------------------------------------
# Layer 1: real fixtures through real parsers.


@pytest.mark.parametrize(
    "parse, fixture",
    [
        (parse_us, "us_kia_niro_ev_2020_cached.json"),
        (parse_us, "us_kia_niro_ev_2020_force_refresh.json"),
        (parse_eu, "eu_kia_ev6_2023_with_soc.json"),
        (parse_ccs2, "eu_kia_ev9_2024_ccs2.json"),
    ],
)
def test_real_ev_fixtures_classify_as_ev(parse, fixture):
    vehicle = parse(fixture)
    # The landmine this guards: every EV fixture carries fuelLevel 0 —
    # present, not absent. Detection must not read that as a fuel tank.
    assert vehicle.fuel_level == 0
    assert _detect_powertrain(vehicle) == "EV"


@pytest.mark.parametrize(
    "parse, fixture",
    [
        (parse_us, "us_kia_niro_ev_2020_cached.json"),
        (parse_eu, "eu_kia_ev6_2023_with_soc.json"),
        (parse_ccs2, "eu_kia_ev9_2024_ccs2.json"),
    ],
)
def test_real_ev_fixtures_suppress_fuel_fields(parse, fixture):
    status = make_provider(parse(fixture))._to_status()
    assert status.powertrain == "EV"
    assert status.fuel_level_percent is None
    assert status.fuel_range is None
    assert status.soc_percent is not None  # the EV side genuinely renders


def test_kia_us_engine_type_from_vehicle_list_is_respected():
    # In production get_vehicles sets engine_type before any status parse
    # (fuelType 4 -> EV); the parser then must not need the inference path.
    api = KiaUvoApiUSA.__new__(KiaUvoApiUSA)
    api.data_timezone = None
    api.temperature_range = [62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82]
    vehicle = Vehicle(engine_type=ENGINE_TYPES.EV)
    api._update_vehicle_properties(
        vehicle, load_fixture("us_kia_niro_ev_2020_cached.json")
    )
    assert _detect_powertrain(vehicle) == "EV"


# ---------------------------------------------------------------------------
# Layer 2: synthetic vehicles for the missing powertrains. Field values match
# the parsers' documented behavior for each type (POWERTRAIN-FIELDS.md).


def test_detects_phev():
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.PHEV, ev_battery_percentage=80, fuel_level=55
    )
    assert _detect_powertrain(v) == "PHEV"


def test_detects_hev_from_vehicle_list_type():
    v = SimpleNamespace(engine_type=ENGINE_TYPES.HEV, fuel_level=62)
    assert _detect_powertrain(v) == "HEV"


def test_detects_ice():
    v = SimpleNamespace(engine_type=ENGINE_TYPES.ICE, fuel_level=40)
    assert _detect_powertrain(v) == "ICE"


def test_ice_with_empty_tank_still_ice():
    # Zero and missing are different: a classified ICE keeps its label (and
    # its fuel fields) even at fuel_level 0.
    v = SimpleNamespace(engine_type=ENGINE_TYPES.ICE, fuel_level=0)
    assert _detect_powertrain(v) == "ICE"


def test_engine_type_as_plain_string_is_tolerated():
    # Vehicle.engine_type is typed str; some paths store the enum, others
    # could store its value. Both must classify.
    v = SimpleNamespace(engine_type="HEV", fuel_level=62)
    assert _detect_powertrain(v) == "HEV"


# Conflict cases -> UNKNOWN, never a guess.


def test_ev_with_genuine_fuel_is_unknown():
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.EV, ev_battery_percentage=70, fuel_level=48
    )
    assert _detect_powertrain(v) == "UNKNOWN"


def test_ev_without_ev_battery_is_unknown():
    v = SimpleNamespace(engine_type=ENGINE_TYPES.EV, fuel_level=0)
    assert _detect_powertrain(v) == "UNKNOWN"


def test_phev_without_ev_battery_is_unknown():
    v = SimpleNamespace(engine_type=ENGINE_TYPES.PHEV, fuel_level=50)
    assert _detect_powertrain(v) == "UNKNOWN"


def test_ice_with_ev_battery_is_unknown():
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.ICE, ev_battery_percentage=70, fuel_level=0
    )
    assert _detect_powertrain(v) == "UNKNOWN"


# No engine_type at all (AU/CN never set it).


def test_no_engine_type_ev_battery_only_infers_ev():
    v = SimpleNamespace(ev_battery_percentage=64, fuel_level=0)
    assert _detect_powertrain(v) == "EV"


def test_no_engine_type_fuel_only_is_unknown():
    # HEV vs ICE is not decidable from fields — stays UNKNOWN rather than
    # guessing. Fuel fields still flow (genuine fuel evidence).
    v = SimpleNamespace(fuel_level=62)
    assert _detect_powertrain(v) == "UNKNOWN"


def test_no_engine_type_no_signals_is_unknown():
    assert _detect_powertrain(SimpleNamespace()) == "UNKNOWN"


def test_no_engine_type_ev_battery_plus_fuel_is_unknown():
    v = SimpleNamespace(ev_battery_percentage=64, fuel_level=48)
    assert _detect_powertrain(v) == "UNKNOWN"


def test_low_fuel_light_counts_as_fuel_evidence():
    v = SimpleNamespace(fuel_level=0, fuel_level_is_low=True)
    assert _detect_powertrain(v) == "UNKNOWN"  # fuel evidence, type unknown


# ---------------------------------------------------------------------------
# _to_status fuel gating and shape.


def test_hev_status_carries_fuel_and_no_ev_fields():
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.HEV,
        fuel_level=62.4,  # floats happen (LaxInt lesson)
        fuel_driving_range=310.2,
        _fuel_driving_range_unit="mi",
        is_locked=True,
    )
    status = make_provider(v)._to_status()
    assert status.powertrain == "HEV"
    assert status.fuel_level_percent == 62
    assert status.fuel_range == 310
    assert status.range_unit == "mi"
    assert status.soc_percent is None
    assert status.range_value is None
    assert status.charging is None
    assert status.locked is True


def test_phev_status_carries_both_sides():
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.PHEV,
        ev_battery_percentage=80,
        ev_driving_range=25,
        ev_driving_range_unit="mi",
        fuel_level=55,
        fuel_driving_range=340,
        total_driving_range=365,
        ev_battery_is_charging=False,
    )
    status = make_provider(v)._to_status()
    assert status.powertrain == "PHEV"
    assert status.soc_percent == 80
    assert status.range_value == 25
    assert status.fuel_level_percent == 55
    assert status.fuel_range == 340
    assert status.total_range == 365


def test_kia_us_ev_dte_fallback_never_becomes_fuel_range():
    # KiaUvoApiUSA fills fuel_driving_range from distanceToEmpty when there
    # is no gasModeRange — on an EV that's the EV range wearing a fuel hat.
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.EV,
        ev_battery_percentage=68,
        ev_driving_range=170,
        ev_driving_range_unit="mi",
        fuel_level=0,
        fuel_driving_range=170,
    )
    status = make_provider(v)._to_status()
    assert status.powertrain == "EV"
    assert status.fuel_range is None
    assert status.fuel_level_percent is None


def test_unknown_with_genuine_fuel_emits_fuel_fields():
    v = SimpleNamespace(fuel_level=62, fuel_driving_range=310)
    status = make_provider(v)._to_status()
    assert status.powertrain == "UNKNOWN"
    assert status.fuel_level_percent == 62
    assert status.fuel_range == 310


def test_unknown_without_fuel_evidence_suppresses_fuel_fields():
    v = SimpleNamespace(fuel_level=0, fuel_driving_range=170)
    status = make_provider(v)._to_status()
    assert status.powertrain == "UNKNOWN"
    assert status.fuel_level_percent is None
    assert status.fuel_range is None


def test_classification_is_sticky_within_a_session():
    # First fetch classifies; a later blip (fields vanish mid-session) must
    # not flip the label.
    v = SimpleNamespace(
        engine_type=ENGINE_TYPES.EV, ev_battery_percentage=68, fuel_level=0
    )
    provider = make_provider(v)
    assert provider._to_status().powertrain == "EV"
    provider._vm.vehicles["v1"] = SimpleNamespace(fuel_level=55)
    assert provider._to_status().powertrain == "EV"
