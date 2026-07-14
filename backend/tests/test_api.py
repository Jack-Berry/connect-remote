from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers.base import (
    AuthError,
    ProviderDataError,
    UpstreamError,
    VehicleStatus,
)
from app.rate_limit import ThrottleRegistry
from app.redact import REDACTED, redact
from app.session_cache import SessionCache, credentials_key

CREDS = {"username": "u", "password": "p", "pin": "1234", "region": 1, "brand": 3}
OTHER_CREDS = {**CREDS, "username": "someone-else"}


def body(**extra) -> dict:
    return {"credentials": CREDS, **extra}


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
        self.fail_auth = False
        self.commands: list[str] = []

    def _check(self):
        if self.fail_auth:
            raise AuthError("bad credentials")
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
        # Like the real provider: never builds VehicleStatus, so a parse
        # failure (fail_parse) can't stop it — only auth/upstream failures.
        if self.fail_auth:
            raise AuthError("bad credentials")
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


class Factory:
    """Provider factory that records how often it was called — a second call
    for the same credentials means the session was evicted (or expired)."""

    def __init__(self):
        self.provider = FakeProvider()
        self.calls = 0

    def __call__(self, creds):
        self.calls += 1
        return self.provider


@pytest.fixture
def factory():
    return Factory()


@pytest.fixture
def provider(factory):
    return factory.provider


@pytest.fixture
def client(factory):
    app.state.cache = SessionCache(factory=factory, ttl_seconds=600)
    app.state.refresh_throttles = ThrottleRegistry(
        min_interval_seconds=900, daily_cap=20
    )
    # Per-IP limits are covered by their own test; everywhere else they'd
    # trip on the shared in-memory counters as the suite hammers one "IP".
    app.state.limiter.enabled = False
    return TestClient(app)


# ---------------------------------------------------------------------------
# Credential validation


def test_status_requires_credentials(client):
    assert client.post("/status", json={}).status_code == 422


def test_status_rejects_blank_username_or_password(client):
    for field in ("username", "password"):
        r = client.post(
            "/status", json={"credentials": {**CREDS, field: ""}}
        )
        assert r.status_code == 422


def test_unknown_region_and_brand_are_422(client):
    assert (
        client.post("/status", json={"credentials": {**CREDS, "region": 99}}).status_code
        == 422
    )
    assert (
        client.post("/status", json={"credentials": {**CREDS, "brand": 9}}).status_code
        == 422
    )


def test_known_regions_and_brands_accepted(client):
    # The codes the app offers: EU=1 CA=2 US=3 AU=5; brands Kia=1 Hyundai=2
    # Genesis=3 — all verified against the lib's const module.
    for region in (1, 2, 3, 5):
        for brand in (1, 2, 3):
            r = client.post(
                "/status",
                json={"credentials": {**CREDS, "region": region, "brand": brand}},
            )
            assert r.status_code == 200, (region, brand)


# ---------------------------------------------------------------------------
# Status


def test_status_returns_vehicle_state(client):
    r = client.post("/status", json=body())
    assert r.status_code == 200
    payload = r.json()
    assert payload["soc_percent"] == 80
    assert payload["locked"] is True
    assert payload["stale"] is False
    assert payload["latitude"] == 51.5072
    assert payload["longitude"] == -0.1276


def test_status_serves_stale_cache_when_upstream_down(client, provider):
    client.post("/status", json=body())  # populate session last_known
    provider.fail = True
    r = client.post("/status", json=body())
    assert r.status_code == 200
    assert r.json()["stale"] is True


def test_status_502_when_down_and_no_cache(client, provider):
    provider.fail = True
    assert client.post("/status", json=body()).status_code == 502


def test_stale_cache_is_per_account_not_global(client, factory, provider):
    client.post("/status", json=body())  # cache for CREDS only
    provider.fail = True
    # A different account has no last_known to fall back on.
    r = client.post("/status", json={"credentials": OTHER_CREDS})
    assert r.status_code == 502


# ---------------------------------------------------------------------------
# Auth failures: 401 + session eviction


def test_auth_failure_is_401_and_evicts_session(client, factory, provider):
    client.post("/status", json=body())
    assert factory.calls == 1
    provider.fail_auth = True
    r = client.post("/status", json=body())
    assert r.status_code == 401
    assert "credentials" in r.json()["detail"]
    # Session was evicted: the next request builds a fresh provider.
    provider.fail_auth = False
    client.post("/status", json=body())
    assert factory.calls == 2


def test_auth_failure_on_command_is_401(client, provider):
    provider.fail_auth = True
    assert client.post("/lock", json=body()).status_code == 401


def test_session_reused_across_requests(client, factory):
    client.post("/status", json=body())
    client.post("/lock", json=body())
    client.post("/status", json=body())
    assert factory.calls == 1


def test_distinct_credentials_get_distinct_sessions(client, factory):
    client.post("/status", json=body())
    client.post("/status", json={"credentials": OTHER_CREDS})
    assert factory.calls == 2


# ---------------------------------------------------------------------------
# Float tolerance (LaxInt)

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


def test_status_endpoint_serves_float_reported_values_as_ints(client, provider):
    provider.status = make_status(
        soc_percent=74.5,
        range_value=213.7,
        charge_eta_minutes=95.4,
        charge_limit_ac=80.0,
        charge_limit_dc=90.0,
    )
    r = client.post("/status", json=body())
    assert r.status_code == 200
    payload = r.json()
    assert payload["soc_percent"] == 74
    assert payload["range_value"] == 214
    assert payload["charge_eta_minutes"] == 95
    assert payload["charge_limit_ac"] == 80
    assert payload["charge_limit_dc"] == 90


# ---------------------------------------------------------------------------
# Parse failures

# A parse failure is our bug: it must surface as a 500 that says so — never
# as the 502 the apps translate to "service unreachable", and never masked
# by stale-cache serving.
def test_status_parse_failure_is_500_not_502_and_not_stale(client, provider):
    client.post("/status", json=body())  # populate last_known
    provider.fail_parse = True
    r = client.post("/status", json=body())
    assert r.status_code == 500
    assert "backend bug" in r.json()["detail"]
    assert "could not parse" in r.json()["detail"]


def test_refresh_parse_failure_is_500(client, provider):
    provider.fail_parse = True
    r = client.post("/refresh", json=body())
    assert r.status_code == 500
    assert "backend bug" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Force-refresh throttling (per account)


def test_refresh_throttled_second_call(client):
    assert client.post("/refresh", json=body()).status_code == 200
    r = client.post("/refresh", json=body())
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_refresh_throttle_is_per_account(client):
    assert client.post("/refresh", json=body()).status_code == 200
    r = client.post("/refresh", json={"credentials": OTHER_CREDS})
    assert r.status_code == 200


def test_refresh_daily_cap(client):
    app.state.refresh_throttles = ThrottleRegistry(
        min_interval_seconds=0, daily_cap=2
    )
    assert client.post("/refresh", json=body()).status_code == 200
    assert client.post("/refresh", json=body()).status_code == 200
    assert client.post("/refresh", json=body()).status_code == 429


def test_refresh_throttle_survives_session_eviction(client):
    # The throttle exists to stop runaway car wake-ups; the session cache
    # TTL (10 min) is shorter than the refresh interval (15 min), so the
    # throttle must be keyed independently of session lifetime.
    assert client.post("/refresh", json=body()).status_code == 200
    app.state.cache.evict(credentials_key("u", "p", "1234", 1, 3))
    assert client.post("/refresh", json=body()).status_code == 429


# ---------------------------------------------------------------------------
# Commands


def test_commands_fire_and_forget(client, provider):
    assert client.post("/lock", json=body()).status_code == 200
    assert client.post("/unlock", json=body()).status_code == 200
    r = client.post("/climate", json=body(on=True, temp=22.5, defrost=True))
    assert r.status_code == 200
    assert r.json()["sent"] is True
    assert client.post("/charge", json=body(on=True)).status_code == 200
    assert client.post("/charge", json=body(on=False)).status_code == 200
    assert client.post("/charge-limits", json=body(ac=80, dc=90)).status_code == 200
    assert provider.commands == [
        "lock",
        "unlock",
        "climate:True:22.5:True:False",
        "charge:start",
        "charge:stop",
        "charge-limits:80:90",
    ]


def test_climate_heating_passthrough(client, provider):
    r = client.post(
        "/climate", json=body(on=True, temp=21, defrost=False, heating=True)
    )
    assert r.status_code == 200
    assert provider.commands == ["climate:True:21.0:False:True"]


def test_charge_requires_on_field(client):
    assert client.post("/charge", json=body()).status_code == 422


def test_charge_limits_bounds(client):
    assert client.post("/charge-limits", json=body(ac=40, dc=90)).status_code == 422
    assert client.post("/charge-limits", json=body(ac=80)).status_code == 422


def test_climate_temp_bounds(client):
    assert client.post("/climate", json=body(on=True, temp=40)).status_code == 422


def test_command_upstream_error_is_502(client, provider):
    provider.fail = True
    assert client.post("/lock", json=body()).status_code == 502


# ---------------------------------------------------------------------------
# Debug fields


def test_debug_fields_requires_credentials(client):
    assert client.post("/debug/fields", json={}).status_code == 422


# The users who need this endpoint are the ones whose car we can't parse, so it
# must not touch VehicleStatus — and what it hands back gets pasted in public.
def test_debug_fields_works_when_status_cannot_parse(client, provider):
    provider.fail_parse = True
    r = client.post("/debug/fields", json=body())
    assert r.status_code == 200
    assert r.json()["fields"]["ev_battery_percentage"] == 74.5


def test_debug_fields_redacts_vin_location_and_nickname(client):
    r = client.post("/debug/fields", json=body())
    text = r.text
    assert "KMTG341ABC1234567" not in text
    assert "51.5072" not in text and "-0.1276" not in text
    assert "Test Vehicle" not in text
    # …while keeping the field names and the non-identifying values, which are
    # the reason to look at this at all.
    fields = r.json()["fields"]
    assert fields["VIN"] == REDACTED
    assert fields["location_latitude"] == REDACTED
    assert fields["model"] == "GV70"
    assert r.json()["raw"]["vehicleStatus"]["evStatus"]["batteryStatus"] == 74.5


def test_debug_fields_is_pretty_printed_for_a_browser(client):
    assert "\n  " in client.post("/debug/fields", json=body()).text


def test_debug_fields_upstream_error_is_502(client, provider):
    provider.fail = True
    assert client.post("/debug/fields", json=body()).status_code == 502


# ---------------------------------------------------------------------------
# healthz


def test_healthz_needs_no_credentials(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True


# ---------------------------------------------------------------------------
# Per-IP rate limiting


def test_per_ip_rate_limit_general(client):
    app.state.limiter.enabled = True
    try:
        app.state.limiter.reset()
        for _ in range(30):
            assert client.get("/healthz").status_code == 200
        assert client.get("/healthz").status_code == 429
    finally:
        app.state.limiter.enabled = False
        app.state.limiter.reset()


def test_per_ip_rate_limit_stricter_on_refresh(client):
    app.state.limiter.enabled = True
    app.state.refresh_throttles = ThrottleRegistry(
        min_interval_seconds=0, daily_cap=1000
    )
    try:
        app.state.limiter.reset()
        for _ in range(5):
            assert client.post("/refresh", json=body()).status_code == 200
        assert client.post("/refresh", json=body()).status_code == 429
    finally:
        app.state.limiter.enabled = False
        app.state.limiter.reset()


# ---------------------------------------------------------------------------
# Redaction


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
