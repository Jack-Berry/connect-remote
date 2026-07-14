"""Tests for GenesisProvider._to_status against float-typed lib data.

Regression for the real-world failure where ev_battery_percentage arrived as
74.5 and every /status 502'd. Built without VehicleManager (no credentials):
the provider is constructed via __new__ and given a stub vehicle registry.
"""

from types import SimpleNamespace

import pytest
from hyundai_kia_connect_api.exceptions import AuthenticationError, PINMissingError

from app.providers.base import AuthError, ProviderDataError, UpstreamError
from app.providers.genesis import GenesisProvider


def make_provider(**vehicle_attrs) -> GenesisProvider:
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._vehicle_id = "v1"
    provider._vm = SimpleNamespace(vehicles={"v1": SimpleNamespace(**vehicle_attrs)})
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
    s = provider._to_status()
    assert s.soc_percent == 74
    assert s.range_value == 214
    assert s.charge_eta_minutes == 95
    assert s.charge_limit_ac == 80
    assert s.charge_limit_dc == 90
    assert s.latitude == 51.0
    assert s.longitude == 0.0


def test_to_status_missing_attributes_yield_none():
    s = make_provider()._to_status()
    assert s.soc_percent is None
    assert s.range_value is None
    assert s.range_unit == "km"
    assert s.doors_open == []


def test_to_status_unparseable_data_raises_provider_data_error():
    provider = make_provider(ev_battery_percentage="not-a-number")
    with pytest.raises(ProviderDataError) as excinfo:
        provider._to_status()
    assert "can't parse" in str(excinfo.value)


# ---------------------------------------------------------------------------
# _prepare error classification. Retries are exercised with a single zero
# delay — the (0, 3, 7) backoff itself would make the test sleep for real.


def make_login_provider(monkeypatch, exc: Exception) -> GenesisProvider:
    import threading

    monkeypatch.setattr(GenesisProvider, "RETRY_DELAYS", (0,))
    provider = GenesisProvider.__new__(GenesisProvider)
    provider._lock = threading.Lock()
    provider._vehicle_id = None

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
