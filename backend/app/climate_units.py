"""Target-temperature conversion for the climate command.

The proxy's API is Celsius everywhere: ClimateBody.temp is validated ge=14,
le=30 and the phone only ever sends Celsius. hyundai_kia_connect_api is *not*
Celsius everywhere — the unit is decided by the per-region implementation it
picks, and it performs no conversion of its own:

  region 1 EU  KiaUvoApiEU            "unit": "C"  temperature_range 14.0–29.5
  region 2 CA  KiaUvoApiCA            "unit": 0    (=C) year-dependent range
  region 3 US  HyundaiBlueLinkApiUSA  "unit": 1    (=F) temperature_range 62–81
  region 3 US  KiaUvoApiUSA           "unit": 1    (=F) temperature_range 62–82
  region 5 AU  KiaUvoApiAU            "unit": "C"  temperature_range 17.0–26.5

(const.py: TEMPERATURE_UNITS = {None: None, 0: "°C", 1: "°F"}.)

Before this module the raw Celsius value went straight through, so a US user
asking for 21°C sent airTemp 21 with unit=1 — 21°F to the car. Worse, Kia US
coerces anything below 62 to the string "LOW", so *every* value the proxy
could send became "LOW".

Two separate concerns, deliberately split:

  * the unit is an explicit table here (FAHRENHEIT_REGIONS), because getting
    it wrong is a silent, car-visible bug that deserves a reviewed decision;
  * the snapping target is read from the live implementation, because several
    impls index into `temperature_range` with `.index(set_temp)` and raise
    ValueError on any value that isn't exactly a member. Reading it from the
    lib means a range change on upgrade self-corrects instead of silently
    reintroducing the crash.
"""

from __future__ import annotations

from collections.abc import Sequence

# Only region 3 (USA) puts Fahrenheit on the wire. EU/CA/AU are all Celsius.
FAHRENHEIT_REGIONS = frozenset({3})


def wire_unit(region: int) -> str:
    """The unit the region's upstream API expects: "C" or "F"."""
    return "F" if region in FAHRENHEIT_REGIONS else "C"


def c_to_f(celsius: float) -> float:
    return celsius * 9 / 5 + 32


def snap(value: float, allowed: Sequence[float] | None) -> float:
    """Nearest value the API will accept.

    `allowed` is the implementation's `temperature_range`. Picking the nearest
    member also clamps, since the ends of the range are the nearest members to
    anything outside it — that's what keeps Kia US off the "LOW" path.

    Canada exposes no flat `temperature_range` (it has year-dependent
    `temperature_range_c_old`/`_c_new`), so `allowed` is None there and we fall
    back to the 0.5°C grid both of its ranges share. Known gap: a pre-2020 CA
    car's range starts at 16.0°C, so 14–15.5 would still raise upstream. Left
    alone rather than clamped, because clamping would silently misreport the
    target for every newer CA car.
    """
    if not allowed:
        return round(value * 2) / 2
    return min(allowed, key=lambda candidate: abs(candidate - value))


def wire_temp(
    celsius: float, region: int, allowed: Sequence[float] | None = None
) -> float:
    """Celsius from the API → the number to hand the library as `set_temp`."""
    value = c_to_f(celsius) if wire_unit(region) == "F" else celsius
    return snap(value, allowed)
