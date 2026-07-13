import os
from datetime import datetime, timezone

os.environ.update(
    CONNECT_REMOTE_USERNAME="u",
    CONNECT_REMOTE_PASSWORD="p",
    CONNECT_REMOTE_PIN="0000",
    CONNECT_REMOTE_API_TOKEN="test-token",
)

import pytest
from fastapi.testclient import TestClient

from app.main import AppState, app
from app.providers.base import ProviderDataError, UpstreamError, VehicleStatus
from app.rate_limit import RefreshThrottle
from app.redact import REDACTED, redact

AUTH = {"Authorization": "Bearer test-token"}


def make_status(**kw) -> VehicleStatus:
    base = dict(
        soc_percent=80,
        range_value=310,
        range_unit="mi",
        locked=True,
        charging=False,
        climate_on=False,
        latitude=51.5072,
        longitude=-0.1276,
        last_updated=datetime(2026, 7, 7, 12, 0, tzinfo=timezone.utc),
    )
    base.update(kw)
    return VehicleStatus(**base)


class FakeProvider:
    def __init__(self):
        self.status = make_status()
        self.fail = False
        self.fail_parse = False
        self.commands: list[str] = []

    def _check(self):
        if self.fail:
            raise UpstreamError("upstream down")
        if self.fail_parse:
            raise ProviderDataError("soc_percent: int_from_float")

    def get_cached_status(self):
        self._check()
        return self.status

    def force_refresh(self):
        self._check()
        return self.status

    def get_raw_fields(self):
        if self.fail:
            raise UpstreamError("upstream down")
        return {
            "fields": {
                "VIN": "KMTG341ABC1234567",
                "name": "Test Vehicle",
                "model": "GV70",
                "location_latitude": 51.5072,
                "location_longitude": -0.1276,
                "ev_battery_percentage": 74.5,
            },
            "raw": {"vehicleStatus": {"evStatus": {"batteryStatus": 74.5}}},
        }

    def lock(self):
        self._check()
        self.commands.append("lock")

    def unlock(self):
        self._check()
        self.commands.append("unlock")

    def set_climate(self, req):
        self._check()
        self.commands.append(f"climate:{req.on}:{req.temp}:{req.defrost}:{req.heating}")

    def set_charge_limits(self, ac, dc):
        self._check()
        self.commands.append(f"charge-limits:{ac}:{dc}")

    def start_charge(self):
        self._check()
        self.commands.append("charge:start")

    def stop_charge(self):
        self._check()
        self.commands.append("charge:stop")


@pytest.fixture
def wiring():
    provider = FakeProvider()
    app.state.wiring = AppState(
        status_provider=provider,
        command_provider=provider,
        throttle=RefreshThrottle(min_interval_seconds=900, daily_cap=20),
    )
    yield app.state.wiring
    del app.state.wiring


@pytest.fixture
def client(wiring):
    return TestClient(app)


def test_status_requires_token(client):
    assert client.get("/status").status_code == 401
    assert client.get("/status", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_status_returns_vehicle_state(client):
    r = client.get("/status", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["soc_percent"] == 80
    assert body["locked"] is True
    assert body["stale"] is False
    assert body["latitude"] == 51.5072
    assert body["longitude"] == -0.1276


def test_status_serves_stale_cache_when_upstream_down(client, wiring):
    client.get("/status", headers=AUTH)  # populate last_known
    wiring.status_provider.fail = True
    r = client.get("/status", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["stale"] is True


def test_status_502_when_down_and_no_cache(client, wiring):
    wiring.status_provider.fail = True
    assert client.get("/status", headers=AUTH).status_code == 502


# Regression: the car reported ev_battery_percentage=74.5 and every /status
# 502'd with int_from_float. Any nominally-integer field can arrive as float.
def test_vehicle_status_accepts_floats_in_every_numeric_field():
    s = VehicleStatus(
        soc_percent=74.5,
        range_value=213.7,
        charge_eta_minutes=95.4,
        charge_limit_ac=80.0,
        charge_limit_dc=90.0,
        latitude=51,  # and ints where floats are expected
        longitude=0,
    )
    assert s.soc_percent == 74  # Python banker's rounding: 74.5 -> 74
    assert s.range_value == 214
    assert s.charge_eta_minutes == 95
    assert s.charge_limit_ac == 80
    assert s.charge_limit_dc == 90
    assert s.latitude == 51.0
    assert s.longitude == 0.0


def test_status_endpoint_serves_float_reported_values_as_ints(client, wiring):
    wiring.status_provider.status = make_status(
        soc_percent=74.5,
        range_value=213.7,
        charge_eta_minutes=95.4,
        charge_limit_ac=80.0,
        charge_limit_dc=90.0,
    )
    r = client.get("/status", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["soc_percent"] == 74
    assert body["range_value"] == 214
    assert body["charge_eta_minutes"] == 95
    assert body["charge_limit_ac"] == 80
    assert body["charge_limit_dc"] == 90


# A parse failure is our bug: it must surface as a 500 that says so — never
# as the 502 the apps translate to "Genesis unreachable", and never masked
# by stale-cache serving.
def test_status_parse_failure_is_500_not_502_and_not_stale(client, wiring):
    client.get("/status", headers=AUTH)  # populate last_known
    wiring.status_provider.fail_parse = True
    r = client.get("/status", headers=AUTH)
    assert r.status_code == 500
    assert "backend bug" in r.json()["detail"]
    assert "could not parse" in r.json()["detail"]


def test_refresh_parse_failure_is_500(client, wiring):
    wiring.status_provider.fail_parse = True
    r = client.post("/refresh", headers=AUTH)
    assert r.status_code == 500
    assert "backend bug" in r.json()["detail"]


def test_refresh_throttled_second_call(client):
    assert client.post("/refresh", headers=AUTH).status_code == 200
    r = client.post("/refresh", headers=AUTH)
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_refresh_daily_cap(client, wiring):
    wiring.throttle = RefreshThrottle(min_interval_seconds=0, daily_cap=2)
    assert client.post("/refresh", headers=AUTH).status_code == 200
    assert client.post("/refresh", headers=AUTH).status_code == 200
    assert client.post("/refresh", headers=AUTH).status_code == 429


def test_commands_fire_and_forget(client, wiring):
    assert client.post("/lock", headers=AUTH).status_code == 200
    assert client.post("/unlock", headers=AUTH).status_code == 200
    r = client.post("/climate", headers=AUTH, json={"on": True, "temp": 22.5, "defrost": True})
    assert r.status_code == 200
    assert r.json()["sent"] is True
    assert client.post("/charge", headers=AUTH, json={"on": True}).status_code == 200
    assert client.post("/charge", headers=AUTH, json={"on": False}).status_code == 200
    assert client.post("/charge-limits", headers=AUTH, json={"ac": 80, "dc": 90}).status_code == 200
    assert wiring.command_provider.commands == [
        "lock",
        "unlock",
        "climate:True:22.5:True:False",
        "charge:start",
        "charge:stop",
        "charge-limits:80:90",
    ]


def test_climate_heating_passthrough(client, wiring):
    r = client.post(
        "/climate", headers=AUTH, json={"on": True, "temp": 21, "defrost": False, "heating": True}
    )
    assert r.status_code == 200
    assert wiring.command_provider.commands == ["climate:True:21.0:False:True"]


def test_charge_requires_on_field(client):
    assert client.post("/charge", headers=AUTH, json={}).status_code == 422


def test_climate_presets(client, wiring):
    assert client.post("/presets/cool", headers=AUTH).status_code == 200
    assert client.post("/presets/warm", headers=AUTH).status_code == 200
    assert client.post("/presets/defrost", headers=AUTH).status_code == 200
    assert wiring.command_provider.commands == [
        "climate:True:17.0:False:False",
        "climate:True:24.0:False:False",
        "climate:True:24.0:True:True",
    ]


def test_climate_preset_unknown_is_404(client):
    assert client.post("/presets/arctic", headers=AUTH).status_code == 404


def test_climate_preset_requires_token(client):
    assert client.post("/presets/cool").status_code == 401


def test_charge_limits_bounds(client):
    assert client.post("/charge-limits", headers=AUTH, json={"ac": 40, "dc": 90}).status_code == 422
    assert client.post("/charge-limits", headers=AUTH, json={"ac": 80}).status_code == 422


def test_climate_temp_bounds(client):
    assert client.post("/climate", headers=AUTH, json={"on": True, "temp": 40}).status_code == 422


def test_command_upstream_error_is_502(client, wiring):
    wiring.command_provider.fail = True
    assert client.post("/lock", headers=AUTH).status_code == 502


def test_debug_fields_requires_token(client):
    assert client.get("/debug/fields").status_code == 401


# The page itself is an empty shell users can open without a token; the data
# behind it is not. If this ever serves car data, the auth above is bypassed.
def test_debug_page_is_a_tokenless_shell_with_no_car_data(client):
    r = client.get("/debug")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    # Sentinels drawn from every kind of value the fixture carries: model (not
    # redacted), nickname and location (both redacted). None may reach the shell.
    assert "GV70" not in r.text
    assert "Test Vehicle" not in r.text and "51.5072" not in r.text


# The users who need this endpoint are the ones whose car we can't parse, so it
# must not touch VehicleStatus — and what it hands back gets pasted in public.
def test_debug_fields_works_when_status_cannot_parse(client, wiring):
    wiring.status_provider.fail_parse = True
    r = client.get("/debug/fields", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["fields"]["ev_battery_percentage"] == 74.5


def test_debug_fields_redacts_vin_location_and_nickname(client):
    r = client.get("/debug/fields", headers=AUTH)
    body = r.text
    assert "KMTG341ABC1234567" not in body
    assert "51.5072" not in body and "-0.1276" not in body
    assert "Test Vehicle" not in body
    # …while keeping the field names and the non-identifying values, which are
    # the reason to look at this at all.
    fields = r.json()["fields"]
    assert fields["VIN"] == REDACTED
    assert fields["location_latitude"] == REDACTED
    assert fields["model"] == "GV70"
    assert r.json()["raw"]["vehicleStatus"]["evStatus"]["batteryStatus"] == 74.5


def test_debug_fields_is_pretty_printed_for_a_browser(client):
    assert "\n  " in client.get("/debug/fields", headers=AUTH).text


def test_debug_fields_upstream_error_is_502(client, wiring):
    wiring.status_provider.fail = True
    assert client.get("/debug/fields", headers=AUTH).status_code == 502


def test_redact_catches_vin_shaped_values_under_unknown_keys():
    out = redact({"someNewField": "KMTG341ABC1234567", "trim": "Sport"})
    assert out == {"someNewField": REDACTED, "trim": "Sport"}


# A sensitive key takes its whole subtree with it — the real payload nests the
# coordinates two levels under "Location".
def test_redact_drops_nested_location_subtree():
    out = redact({"Location": {"GeoCoord": {"Latitude": 51.5072}}, "Speed": 30})
    assert out == {"Location": REDACTED, "Speed": 30}


# Caught against the real car's payload: substring matching redacted
# ev_driving_range and DrivingMode, because "dri-VIN-g" contains "vin", and
# GearPosition, because "position" looked like coordinates. All are exactly the
# fields a Hyundai/Kia reporter needs us to see.
def test_redact_keeps_fields_that_merely_look_sensitive():
    out = redact({
        "ev_driving_range": 213.7,
        "DrivingMode": 2,
        "GearPosition": 1,
        "Version": "ABCDEFGH123456789JK",  # 19 chars — a firmware string, not a VIN
    })
    assert out == {
        "ev_driving_range": 213.7,
        "DrivingMode": 2,
        "GearPosition": 1,
        "Version": "ABCDEFGH123456789JK",
    }
