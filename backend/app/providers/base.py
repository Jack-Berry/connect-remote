"""Provider interfaces.

Status and commands are deliberately separate protocols: the official Pleos
Vehicle Data API is status-only, so a future hybrid can swap the status
provider while commands stay on the reverse-engineered flow.
"""

from datetime import datetime
from typing import Annotated, Any, Protocol

from pydantic import BaseModel, BeforeValidator


def _round_float(v: object) -> object:
    if isinstance(v, float):
        return round(v)
    return v


# The car reports nominally-integer values as floats without warning
# (observed: ev_battery_percentage 74.5, ev_driving_range 213.7). Every
# integer field that carries upstream data must tolerate that, so: round.
LaxInt = Annotated[int, BeforeValidator(_round_float)]


def _truthy(v: Any) -> Any:
    """Coerce upstream 'is on' values to a real bool.

    The library's boolean-looking flags are not always booleans. `climate_on`
    comes from `air_control_is_on`, which is actually the blower SPEED (0-10+):
    with the climate genuinely running at full fan it arrives as 10, and
    Pydantic v2 accepts only 0/1 for a bool — so the whole /status 500'd
    exactly when the feature was in use (hardware, 2026-07-24). Anything
    non-zero means on.

    Deliberately applied to every bool field rather than just the one that
    bit: one odd upstream value must never take the entire status down, and
    a field that is None stays None (absent, not false).
    """
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "on", "yes"):
            return True
        if s in ("false", "off", "no", ""):
            return False
    return v


LaxBool = Annotated[bool, BeforeValidator(_truthy)]


class VehicleStatus(BaseModel):
    # Powertrain classification: EV / PHEV / HEV / ICE / UNKNOWN. UNKNOWN
    # means conflicting or insufficient signals (see genesis._detect_powertrain)
    # — the app must render only the fields that are actually present. Every
    # field below is nullable: no powertrain populates all of them.
    powertrain: str = "UNKNOWN"
    # EV-side fields — absent (None) on HEV/ICE.
    soc_percent: LaxInt | None = None
    # UK/EU accounts report range in the account's unit ('mi' for UK).
    # range_unit covers ALL ranges in this response (range_value, fuel_range,
    # total_range) — the upstream reports one unit per account.
    range_value: LaxInt | None = None
    range_unit: str = "km"
    # Fuel-side fields — populated only for fuel-bearing powertrains
    # (PHEV/HEV/ICE, or UNKNOWN with genuine fuel evidence). Never populated
    # for a classified EV: every EV payload carries a vestigial fuelLevel: 0
    # and Kia-US EVs get a bogus fuel range via a distanceToEmpty fallback
    # (see docs-internal/POWERTRAIN-FIELDS.md).
    fuel_level_percent: LaxInt | None = None
    fuel_range: LaxInt | None = None
    # Combined range where the API provides one (PHEV: EV + fuel).
    total_range: LaxInt | None = None
    locked: LaxBool | None = None
    charging: LaxBool | None = None
    charge_eta_minutes: LaxInt | None = None
    climate_on: LaxBool | None = None
    doors_open: list[str] = []
    # Last reported car position — consumed by the glasses "Find my car" mode.
    latitude: float | None = None
    longitude: float | None = None
    # When the car last reported that position. Distinct from last_updated
    # (the whole status): a car parked hours ago still refreshes its status,
    # so only this field can honestly answer "parked 2h ago".
    location_last_updated: datetime | None = None
    last_updated: datetime | None = None
    # Current AC/DC charge targets as reported by the car (percent)
    charge_limit_ac: LaxInt | None = None
    charge_limit_dc: LaxInt | None = None
    # True when this is served from cache because upstream is unreachable
    stale: bool = False


class ClimateSettings(BaseModel):
    on: bool
    temp: float = 21.0
    defrost: bool = False
    # Steering wheel + rear window/mirror heat
    heating: bool = False
    duration_minutes: int = 10


class StatusProvider(Protocol):
    def get_cached_status(self) -> VehicleStatus:
        """Return vehicle state from the provider's server-side cache.
        Must NOT wake the car."""
        ...

    def force_refresh(self) -> VehicleStatus:
        """Wake the car and fetch fresh state. Expensive and rate-limited
        by the caller."""
        ...

    def get_raw_fields(self) -> dict:
        """Return the upstream vehicle data as plain JSON-able values, without
        mapping it onto VehicleStatus — so it still works when the mapping is
        exactly what's broken. Callers must redact it before showing anyone."""
        ...


class CommandProvider(Protocol):
    def lock(self) -> None: ...

    def unlock(self) -> None: ...

    def set_climate(self, req: ClimateSettings) -> None: ...

    def start_charge(self) -> None: ...

    def stop_charge(self) -> None: ...

    def set_charge_limits(self, ac: int, dc: int) -> None: ...


class UpstreamError(Exception):
    """Raised when the vehicle API is unreachable or rejects the request."""


class AuthError(Exception):
    """Raised when the vehicle API rejects the account credentials (bad
    username/password/PIN, OTP or consent required). Kept separate from
    UpstreamError so the proxy can evict the cached session and answer 401
    instead of 502."""


class ReenrollRequired(Exception):
    """Raised when the vehicle API demands device re-enrollment (Kia-US OTP).
    Distinct from AuthError so the proxy can answer 409 (not 401) and avoid
    counting it as a failed-auth strike — the credentials are fine, only the
    device trust has expired."""


class ProviderDataError(Exception):
    """Raised when the vehicle API responded but its data didn't fit our
    model — a backend bug to report, not a connectivity problem. Kept
    separate from UpstreamError so it never surfaces as 'Genesis
    unreachable'."""
