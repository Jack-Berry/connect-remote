"""Provider interfaces.

Status and commands are deliberately separate protocols: the official Pleos
Vehicle Data API is status-only, so a future hybrid can swap the status
provider while commands stay on the reverse-engineered flow.
"""

from datetime import datetime
from typing import Annotated, Protocol

from pydantic import BaseModel, BeforeValidator


def _round_float(v: object) -> object:
    if isinstance(v, float):
        return round(v)
    return v


# The car reports nominally-integer values as floats without warning
# (observed: ev_battery_percentage 74.5, ev_driving_range 213.7). Every
# integer field that carries upstream data must tolerate that, so: round.
LaxInt = Annotated[int, BeforeValidator(_round_float)]


class VehicleStatus(BaseModel):
    soc_percent: LaxInt | None = None
    # UK/EU accounts report range in the account's unit ('mi' for UK)
    range_value: LaxInt | None = None
    range_unit: str = "km"
    locked: bool | None = None
    charging: bool | None = None
    charge_eta_minutes: LaxInt | None = None
    climate_on: bool | None = None
    doors_open: list[str] = []
    # Last reported car position (exposed by the API; no glasses UI consumes it yet)
    latitude: float | None = None
    longitude: float | None = None
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


class ProviderDataError(Exception):
    """Raised when the vehicle API responded but its data didn't fit our
    model — a backend bug to report, not a connectivity problem. Kept
    separate from UpstreamError so it never surfaces as 'Genesis
    unreachable'."""
