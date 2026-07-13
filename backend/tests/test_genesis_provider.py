"""Tests for GenesisProvider._to_status against float-typed lib data.

Regression for the real-world failure where ev_battery_percentage arrived as
74.5 and every /status 502'd. Built without VehicleManager (no credentials):
the provider is constructed via __new__ and given a stub vehicle registry.
"""

import os
from types import SimpleNamespace

os.environ.update(
    CONNECT_REMOTE_USERNAME="u",
    CONNECT_REMOTE_PASSWORD="p",
    CONNECT_REMOTE_PIN="0000",
    CONNECT_REMOTE_API_TOKEN="test-token",
)

import pytest

from app.providers.base import ProviderDataError
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
