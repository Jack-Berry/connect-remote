"""Car-reported warnings: the `warnings: []` array on /status.

Evidence base and the rules this file implements:
docs-internal/WARNINGS-FIELDS.md. The governing principle is binding —

    **every warning is per-car opt-in, proven from that car's own payload.**

A key that cannot be PROVEN supported for this specific car simply does not
exist for it. An empty array is the normal, common answer; nothing downstream
is allowed to treat it as an error.

Four keys ship in the first cut, in severity order:

    brake_fluid_low > tyre_pressure_low > smart_key_battery_low >
    washer_fluid_low

All four are lamp-mirror flags (the car's own warning lamp, mirrored into the
payload), present on both production cars across all three parser paths.

Three rules, each of which a real payload has already tried to break:

1. **Support must be proven, and `False` proves nothing.** The CCS2 parser
   wraps the tyre and smart-key flags in a bare ``bool(...)``, and so does the
   EU-legacy parser for the tyre flags (`KiaUvoApiEU.py:599`, a correction to
   the doc's table, which listed EU-legacy tyre as int|None). ``bool(None)`` is
   ``False``, so on those paths "not supported" and "no warning" are the same
   value at the `Vehicle` level. Proof therefore comes from raw-key presence in
   ``vehicle.data``, which every parser stores unconditionally.

2. **Truthiness only, never `is True`.** The same flag is a bool in one region
   and an int in the next; `fuel_level_is_low` already burned us that way. Any
   OTHER type (str, list, an enum we can't calibrate) is treated as
   unsupported, not as a warning — `"0"` is truthy, and a warning we can't read
   correctly is worse than no warning.

3. **Flags only, never readings.** No warning is ever derived from a number
   (pressure, level, SoC) or from an uncalibrated raw enum. The live Genesis
   reports ``Pressure: 255`` on all four corners (a no-data sentinel) and
   ``ChargingDoor.ErrorState: 1`` while perfectly healthy — both are proof that
   only the car's own lamp fields can be read as lamps.

Confidence ceiling: every specimen we hold is a healthy car. The
flag → dashboard-lamp correspondence is inferred from key names, never
observed firing. That is why the copy reports rather than diagnoses, and why
warning_counts.py exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# How old the car's own data may be before warnings are suppressed entirely.
#
# 30 minutes, chosen against the two clocks that actually exist here: /refresh
# is throttled to one wake per 15 min per account (main.REFRESH_MIN_INTERVAL_
# SECONDS), so 30 min is two full refresh windows — a user who acts on a
# warning can always get fresh data well inside it — while a cached status from
# an earlier drive, or from before a garage visit, falls outside it. The
# asymmetry is deliberate: a warning is a claim about the car RIGHT NOW, and a
# stale payload can describe a fault already dealt with. Missing/unparseable
# timestamp counts as "cannot prove freshness" and suppresses too, matching the
# governing principle.
MAX_WARNING_AGE = timedelta(minutes=30)

_MISSING = object()


@dataclass(frozen=True)
class WarningSpec:
    """One stable warning key and the three ways cars spell its raw flag."""

    key: str
    # The lib Vehicle attribute the parsers assign.
    attr: str
    # Raw dotted paths into vehicle.data, one per parser path. Presence of ANY
    # of them is per-car proof that this car genuinely reports the flag.
    raw_paths: tuple[str, ...]


# Severity order, highest first. This tuple IS the rank: the glasses show
# warnings[0] and nothing else, so the order is part of the API contract.
WARNING_SPECS: tuple[WarningSpec, ...] = (
    WarningSpec(
        key="brake_fluid_low",
        attr="brake_fluid_warning_is_on",
        raw_paths=(
            "Chassis.Brake.Fluid.Warning",  # EU CCS2
            "lastVehicleInfo.vehicleStatusRpt.vehicleStatus.breakOilStatus",  # Kia US (sic)
            "vehicleStatus.breakOilStatus",  # EU legacy
        ),
    ),
    WarningSpec(
        key="tyre_pressure_low",
        # The axle-level "all" lamp only. The four per-corner flags are
        # enrichment at best (never parsed at all on Kia-US) and are
        # deliberately not a trigger — see WARNINGS-FIELDS.md.
        attr="tire_pressure_all_warning_is_on",
        raw_paths=(
            "Chassis.Axle.Tire.PressureLow",  # EU CCS2
            "lastVehicleInfo.vehicleStatusRpt.vehicleStatus.tirePressure.all",  # Kia US
            "vehicleStatus.tirePressureLamp.tirePressureLampAll",  # EU legacy
        ),
    ),
    WarningSpec(
        key="smart_key_battery_low",
        attr="smart_key_battery_warning_is_on",
        raw_paths=(
            "Electronics.FOB.LowBattery",  # EU CCS2
            "lastVehicleInfo.vehicleStatusRpt.vehicleStatus.smartKeyBatteryWarning",  # Kia US
            "vehicleStatus.smartKeyBatteryWarning",  # EU legacy
        ),
    ),
    WarningSpec(
        key="washer_fluid_low",
        attr="washer_fluid_warning_is_on",
        raw_paths=(
            "Body.Windshield.Front.WasherFluid.LevelLow",  # EU CCS2
            "lastVehicleInfo.vehicleStatusRpt.vehicleStatus.washerFluidStatus",  # Kia US
            "vehicleStatus.washerFluidStatus",  # EU legacy
        ),
    ),
)

WARNING_KEYS: tuple[str, ...] = tuple(spec.key for spec in WARNING_SPECS)


def _raw_lookup(data, path: str):
    """Walk a dotted path through the raw payload.

    Returns ``_MISSING`` when any segment is absent — deliberately distinct
    from a present key holding ``None``, because "the car reports this field"
    is exactly the distinction the whole module rests on. (The lib's own
    ``get_child_value`` collapses both to ``None``, which is why this exists.)
    """
    value = data
    for segment in path.split("."):
        if isinstance(value, dict):
            if segment not in value:
                return _MISSING
            value = value[segment]
        elif isinstance(value, list):
            try:
                value = value[int(segment)]
            except (ValueError, IndexError, TypeError):
                return _MISSING
        else:
            return _MISSING
    return value


def _raw_present(data, spec: WarningSpec) -> bool:
    if not isinstance(data, dict):
        return False
    return any(_raw_lookup(data, path) is not _MISSING for path in spec.raw_paths)


def _supported(vehicle, spec: WarningSpec) -> bool:
    """Does THIS car genuinely report this flag?

    Raw-key presence is the strong proof and the normal path — every parser
    stores its untouched payload on ``vehicle.data``, and each of the three
    spellings above is the exact string its parser reads.

    The fallback matters only for a payload shape we have never seen (another
    region, another brand) where none of the known spellings hit. There, a
    parsed value that is a plain ``bool`` is NOT accepted: ``bool()``-wrapping
    is precisely what erases absence, and we cannot tell an erased ``False``
    from a reported one. A non-bool value (the int/None passthrough shape)
    would have been ``None`` if absent, so being non-None does prove support.
    """
    if _raw_present(getattr(vehicle, "data", None), spec):
        return True
    value = getattr(vehicle, spec.attr, None)
    return value is not None and not isinstance(value, bool)


def _fires(value) -> bool:
    """Truthy — but only for types we can read as a flag.

    bool and int/float (the documented cross-region flips) only. A str, list,
    dict or enum is a type surprise: treated as unsupported, never as a
    warning. `"0"` being truthy is the reason this is not a bare ``bool(v)``.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return False


def _fresh_enough(last_updated, now: datetime) -> bool:
    """Is the car's own data recent enough to make a claim about it?

    Naive timestamps are read as UTC: the lib returns tz-aware datetimes on
    every path we use, and a naive one arriving from a parser we haven't seen
    must not raise inside a status response.
    """
    if not isinstance(last_updated, datetime):
        return False
    if last_updated.tzinfo is None:
        last_updated = last_updated.replace(tzinfo=timezone.utc)
    age = now - last_updated
    # A timestamp in the future (car clock skew) is not evidence of staleness.
    return age <= MAX_WARNING_AGE


def evaluate(vehicle, now: datetime | None = None) -> list[str]:
    """The warning keys this car is currently reporting, most severe first.

    Never raises: a warning is a nice-to-have, and nothing here may be the
    reason /status fails. Any surprise degrades to "no warnings".
    """
    try:
        now = now or datetime.now(timezone.utc)
        if not _fresh_enough(getattr(vehicle, "last_updated_at", None), now):
            # Suppressed wholesale. The response already explains itself
            # without a new field: last_updated is in the payload (and `stale`
            # covers the cache-served case), so a client that cares can see
            # exactly why the array is empty.
            return []
        return [
            spec.key
            for spec in WARNING_SPECS
            if _supported(vehicle, spec) and _fires(getattr(vehicle, spec.attr, None))
        ]
    except Exception:  # pragma: no cover - defensive, see docstring
        return []
