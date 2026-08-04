"""Tests for GenesisProvider._to_status against float-typed lib data.

Regression for the real-world failure where ev_battery_percentage arrived as
74.5 and every /status 502'd. Built without VehicleManager (no credentials):
the provider is constructed via __new__ and given a stub vehicle registry.
"""

import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from hyundai_kia_connect_api.exceptions import AuthenticationError, PINMissingError

from app.providers.base import (
    AuthError,
    ClimateSettings,
    ProviderDataError,
    UnknownVehicleError,
    UpstreamError,
)
from app.providers.genesis import GenesisProvider


def make_provider(**vehicle_attrs) -> GenesisProvider:
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._vm = SimpleNamespace(vehicles={"v1": SimpleNamespace(**vehicle_attrs)})
    provider._vehicles_loaded = True
    provider._powertrains = {}
    provider._brand_name = "Genesis"
    provider._region_name = "Europe"
    return provider


def test_to_status_tolerates_floats_in_every_numeric_field():
    provider = make_provider(
        ev_battery_percentage=74.5,
        ev_driving_range=213.7,
        ev_driving_range_unit="mi",
        is_locked=True,
        ev_battery_is_charging=True,
        ev_estimated_current_charge_duration=95.4,
        air_control_is_on=False,
        ev_charge_limits_ac=80.0,
        ev_charge_limits_dc=90.0,
        location_latitude=51,
        location_longitude=0,
    )
    s = provider._to_status("v1")
    assert s.soc_percent == 74
    assert s.range_value == 214
    assert s.charge_eta_minutes == 95
    assert s.charge_limit_ac == 80
    assert s.charge_limit_dc == 90
    assert s.latitude == 51.0
    assert s.longitude == 0.0


def test_to_status_reads_location_timestamp_from_the_public_property():
    """The car finder's "parked 2h ago" line depends on this exact name.

    `location_last_updated_at` is the public property; `_location_last_set_time`
    is the private attribute behind it. Reading the private name via getattr
    would return None forever and the staleness line would silently never
    appear — so assert the property name is the one being read, and that the
    private name alone is not enough.
    """
    parked = datetime(2026, 7, 20, 8, 30, tzinfo=timezone.utc)
    s = make_provider(location_last_updated_at=parked)._to_status("v1")
    assert s.location_last_updated == parked

    decoy = make_provider(_location_last_set_time=parked)._to_status("v1")
    assert decoy.location_last_updated is None


def test_to_status_missing_attributes_yield_none():
    s = make_provider()._to_status("v1")
    assert s.soc_percent is None
    assert s.range_value is None
    assert s.range_unit == "km"
    assert s.doors_open == []


def test_to_status_unparseable_data_raises_provider_data_error():
    provider = make_provider(ev_battery_percentage="not-a-number")
    with pytest.raises(ProviderDataError) as excinfo:
        provider._to_status("v1")
    assert "can't parse" in str(excinfo.value)


# ---------------------------------------------------------------------------
# _prepare error classification. Retries are exercised with a single zero
# delay — the (0, 3, 7) backoff itself would make the test sleep for real.


def make_login_provider(
    monkeypatch, exc: Exception, scrub_values: list[str] | None = None
) -> GenesisProvider:
    import threading

    monkeypatch.setattr(GenesisProvider, "RETRY_DELAYS", (0,))
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._lock = threading.Lock()
    provider._vehicles_loaded = False
    provider._powertrains = {}
    provider._scrub_values = scrub_values or []

    def raise_exc():
        raise exc

    provider._vm = SimpleNamespace(check_and_refresh_token=raise_exc)
    return provider


# Transient rejections and wrong passwords both surface as
# AuthenticationError; only after the retries are exhausted may it become the
# 401-producing AuthError — a transient blip must not evict the session.
def test_persistent_authentication_error_becomes_auth_error(monkeypatch):
    provider = make_login_provider(monkeypatch, AuthenticationError("bad password"))
    with pytest.raises(AuthError):
        provider._prepare()


def test_pin_missing_is_auth_error_without_retry(monkeypatch):
    calls = []
    provider = make_login_provider(monkeypatch, PINMissingError("PIN required"))
    monkeypatch.setattr(GenesisProvider, "RETRY_DELAYS", (0, 0, 0))

    def counting_raise():
        calls.append(1)
        raise PINMissingError("PIN required")

    provider._vm = SimpleNamespace(check_and_refresh_token=counting_raise)
    with pytest.raises(AuthError):
        provider._prepare()
    assert len(calls) == 1  # config error — no retries


def test_non_auth_login_failure_becomes_upstream_error(monkeypatch):
    provider = make_login_provider(monkeypatch, ConnectionError("ECONNRESET"))
    with pytest.raises(UpstreamError):
        provider._prepare()


# The lib embeds raw upstream response bodies in AuthenticationError text
# (e.g. KiaUvoApiEU puts resp.text[:300] in the message), and the upstream
# may echo the submitted account back — so anything leaving the provider as
# exception text must have the credentials scrubbed out, case-insensitively.
def test_auth_error_text_is_scrubbed_of_credentials(monkeypatch):
    echoed = AuthenticationError(
        'Signin failed: HTTP 400 — {"error":"bad password for USER@Example.COM"}'
    )
    provider = make_login_provider(
        monkeypatch, echoed, scrub_values=["user@example.com", "hunter2"]
    )
    with pytest.raises(AuthError) as excinfo:
        provider._prepare()
    text = str(excinfo.value)
    assert "user@example.com" not in text.lower()
    assert "<credential>" in text
    assert "Signin failed" in text  # diagnostic value survives


def test_scrub_replaces_overlapping_credentials_longest_first(monkeypatch):
    provider = make_login_provider(
        monkeypatch, Exception("x"), scrub_values=["ab", "abcd"]
    )
    provider._scrub_values = sorted(["ab", "abcd"], key=len, reverse=True)
    assert provider._scrub(Exception("abcd and ab")) == "<credential> and <credential>"


# The set_climate -> ClimateRequestOptions mapping was previously untested, so
# nothing observed what actually reached the library — which is how the
# Celsius-into-a-Fahrenheit-field bug survived. These tests capture the real
# payload. Unit rules live in test_climate_units.py.
def make_climate_provider(region: int, temperature_range=None) -> GenesisProvider:
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._lock = threading.Lock()
    provider._vehicles_loaded = True
    provider._powertrains = {}
    provider._region = region
    provider._region_name = "test"
    provider._vm = SimpleNamespace(
        api=SimpleNamespace(temperature_range=temperature_range),
        start_climate=lambda vid, options: captured.append(options),
        stop_climate=lambda vid: captured.append("stop"),
    )
    provider._prepare = lambda requested=None: "v1"
    return provider


captured: list = []


@pytest.fixture(autouse=True)
def _clear_captured():
    captured.clear()


def test_set_climate_sends_fahrenheit_in_the_us():
    provider = make_climate_provider(3, range(62, 83))
    provider.set_climate(ClimateSettings(on=True, temp=21.0, defrost=False, heating=False))
    assert captured[0].set_temp == 70
    # Guards the Kia US "LOW" coercion for values under 62.
    assert captured[0].set_temp >= 62


def test_set_climate_sends_celsius_in_europe():
    provider = make_climate_provider(1, [x * 0.5 for x in range(28, 60)])
    provider.set_climate(ClimateSettings(on=True, temp=22.5, defrost=True, heating=True))
    assert captured[0].set_temp == 22.5
    assert captured[0].defrost is True
    assert captured[0].heating == 1


def test_set_climate_off_ignores_temperature():
    provider = make_climate_provider(3, range(62, 83))
    provider.set_climate(ClimateSettings(on=False, temp=21.0, defrost=False, heating=False))
    assert captured == ["stop"]


# ---------------------------------------------------------------------------
# Bool coercion — hardware regression, 2026-07-24.


def test_climate_on_accepts_blower_speed_not_just_0_or_1():
    """`air_control_is_on` is the blower SPEED, not a flag.

    With the climate genuinely running the car reported 10, Pydantic v2 accepts
    only 0/1 for a bool, and the whole /status 500'd with "backend bug, please
    report" — i.e. the app broke exactly when the feature was in use. Any
    non-zero value means on.
    """
    from app.providers.base import VehicleStatus

    assert VehicleStatus(climate_on=10).climate_on is True
    assert VehicleStatus(climate_on=1).climate_on is True
    assert VehicleStatus(climate_on=0).climate_on is False
    # Absent stays absent — never coerced into a confident False.
    assert VehicleStatus(climate_on=None).climate_on is None
    assert VehicleStatus().climate_on is None


def test_every_bool_field_tolerates_odd_upstream_values():
    """One weird value must never take the whole status down."""
    from app.providers.base import VehicleStatus

    s = VehicleStatus(locked=2, charging=10, climate_on=7)
    assert (s.locked, s.charging, s.climate_on) == (True, True, True)
    assert VehicleStatus(locked=True, charging=False).locked is True


# ---------------------------------------------------------------------------
# Multi-car: one account, several vehicles. Selection is a per-call argument,
# never provider state, so two cars share one login without sharing anything
# that belongs to a single car.


def make_multi_provider(**per_vehicle) -> GenesisProvider:
    """Provider over N stub vehicles: make_multi_provider(v1={...}, v2={...})."""
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._lock = threading.Lock()
    provider._vm = SimpleNamespace(
        vehicles={
            vid: SimpleNamespace(id=vid, **attrs) for vid, attrs in per_vehicle.items()
        },
        check_and_refresh_token=lambda: None,
        update_all_vehicles_with_cached_state=lambda: None,
        update_vehicle_with_cached_state=lambda vid: None,
    )
    provider._vehicles_loaded = False
    provider._powertrains = {}
    provider._brand_name = "Hyundai"
    provider._region_name = "Europe"
    provider._scrub_values = []
    return provider


EV = dict(name="Ioniq", model="IONIQ 5", engine_type="EV", ev_battery_percentage=64)
ICE = dict(name="Tucson", model="TUCSON", engine_type="ICE", fuel_level=40)


def test_no_selector_uses_the_first_vehicle():
    # The pre-multi-car behaviour, kept byte-for-byte so shipped app versions
    # that never send a selector are unaffected.
    provider = make_multi_provider(v1=EV, v2=ICE)
    assert provider._prepare() == "v1"
    assert provider.get_cached_status().vehicle_name == "Ioniq"


def test_selector_picks_that_vehicle():
    provider = make_multi_provider(v1=EV, v2=ICE)
    assert provider._prepare("v2") == "v2"
    assert provider.get_cached_status(vehicle_id="v2").vehicle_name == "Tucson"


def test_unknown_vehicle_raises_and_is_not_retried(monkeypatch):
    # A bad id will still be bad next attempt — burning the backoff on it
    # would turn a 404 into a ~10s hang.
    monkeypatch.setattr(GenesisProvider, "RETRY_DELAYS", (0, 3, 7))
    provider = make_multi_provider(v1=EV, v2=ICE)
    attempts = []
    real = provider._vm.check_and_refresh_token
    provider._vm.check_and_refresh_token = lambda: attempts.append(1) or real()
    with pytest.raises(UnknownVehicleError):
        provider._prepare("v3-sold-last-year")
    assert len(attempts) == 1


def test_powertrain_is_classified_per_vehicle():
    # The bug this guards: one cached classification for the whole account
    # would render an ICE car's HUD as an EV (or suppress its fuel line).
    provider = make_multi_provider(v1=EV, v2=ICE)
    assert provider.get_cached_status(vehicle_id="v1").powertrain == "EV"
    assert provider.get_cached_status(vehicle_id="v2").powertrain == "ICE"
    # And the first car keeps its own answer afterwards.
    assert provider.get_cached_status(vehicle_id="v1").powertrain == "EV"
    assert provider._powertrains == {"v1": "EV", "v2": "ICE"}


def test_fuel_gating_follows_the_selected_car():
    provider = make_multi_provider(v1=EV, v2=ICE)
    assert provider.get_cached_status(vehicle_id="v1").fuel_level_percent is None
    assert provider.get_cached_status(vehicle_id="v2").fuel_level_percent == 40


def test_vehicle_count_lets_the_client_decide_to_show_a_name():
    multi = make_multi_provider(v1=EV, v2=ICE)
    assert multi.get_cached_status().vehicle_count == 2
    single = make_multi_provider(v1=EV)
    assert single.get_cached_status().vehicle_count == 1


def test_vehicle_name_falls_back_to_model():
    provider = make_multi_provider(v1={**EV, "name": None})
    assert provider.get_cached_status().vehicle_name == "IONIQ 5"


def test_list_vehicles_returns_identity_but_never_a_vin():
    provider = make_multi_provider(
        v1={**EV, "year": 2024, "VIN": "KMTG341ABC1234567"}, v2={**ICE, "year": 2021}
    )
    assert provider.list_vehicles() == [
        {"id": "v1", "name": "Ioniq", "model": "IONIQ 5", "year": 2024},
        {"id": "v2", "name": "Tucson", "model": "TUCSON", "year": 2021},
    ]


def test_discovery_runs_once_across_many_calls():
    # update_all_vehicles_with_cached_state fetches every car on the account;
    # doing it per request would multiply upstream load by the car count.
    provider = make_multi_provider(v1=EV, v2=ICE)
    discoveries = []
    provider._vm.update_all_vehicles_with_cached_state = lambda: discoveries.append(1)
    provider._prepare()
    provider._prepare("v2")
    provider._prepare()
    assert len(discoveries) == 1


def test_empty_account_still_raises_upstream_error():
    provider = make_multi_provider()
    with pytest.raises(UpstreamError):
        provider._prepare()


def test_list_vehicles_rediscovers_so_a_new_car_appears():
    # A car added after the session warmed up must show on the very screen
    # built to list it, not 10 minutes later when the session expires.
    provider = make_multi_provider(v1=EV)
    assert [v["id"] for v in provider.list_vehicles()] == ["v1"]
    provider._vm.vehicles["v2"] = SimpleNamespace(id="v2", **ICE)
    assert [v["id"] for v in provider.list_vehicles()] == ["v1", "v2"]


def test_status_paths_do_not_rediscover():
    # The per-poll paths must stay on the cached list: re-listing there would
    # multiply upstream load by the car count on every single status fetch.
    provider = make_multi_provider(v1=EV, v2=ICE)
    provider._prepare()
    discoveries = []
    provider._vm.update_all_vehicles_with_cached_state = lambda: discoveries.append(1)
    provider.get_cached_status()
    provider.get_cached_status(vehicle_id="v2")
    assert discoveries == []
