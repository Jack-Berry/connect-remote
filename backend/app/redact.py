"""Strip identifying values out of raw upstream payloads.

The raw vehicle dump is the most useful thing a non-developer can send us when
their car reports fields we don't handle — and it carries the VIN, the car's
last position and account details. Redaction is key-name based: a false positive
costs one field of diagnostic value, a false negative posts someone's VIN and
home address into a public issue.

Values are replaced, keys are kept — the shape of the data is the whole point.
"""

import re

REDACTED = "<redacted>"

# Keys are split into words on separators and camelCase humps, then matched
# word-for-word: "vehicleVin"/"vehicle_vin"/"VIN" all hit `vin`, while
# "ev_driving_range" does not — substring matching flunked that one ("driVINg"),
# and range is exactly the field we need to see on an unfamiliar model.
_SENSITIVE_WORDS = frozenset({
    "vin", "id", "uuid", "name", "nickname", "user", "users", "username",
    "owner", "customer", "email", "mail", "phone", "mobile", "msisdn", "tel",
    "address", "addr", "lat", "latitude", "lon", "lng", "longitude",
    "coord", "coords", "coordinate", "coordinates", "geo", "gps", "location",
    "token", "password", "passwd", "pin", "secret", "serial",
    "imei", "iccid", "plate", "registration",
})
# Deliberately NOT sensitive, though they read that way: "position" (the real
# payload uses it for GearPosition/ParkingPosition — gear state, ints) and
# "long" (LongTerm-style keys). Actual coordinates are caught by the words
# above wherever they sit, including inside a kept subtree.
# Belt and braces for keys that don't tokenize as expected (no separators, no
# humps): these words are long enough that a substring hit is never a coincidence.
_SENSITIVE_SUBSTRINGS = (
    "latitude", "longitude", "password", "nickname", "address", "coordinate",
)

# A VIN reaching us under an unexpected key still looks like a VIN: 17 chars,
# no I/O/Q. Anchored — a longer alphanumeric blob (firmware "Version", say) is
# not a VIN and stays readable.
_VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")

_HUMPS = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _is_sensitive(key: str) -> bool:
    spaced = _HUMPS.sub(" ", str(key))
    words = set(re.split(r"[^a-z0-9]+", spaced.lower())) - {""}
    if words & _SENSITIVE_WORDS:
        return True
    flat = "".join(words)
    return any(s in flat for s in _SENSITIVE_SUBSTRINGS)


def redact(value: object, key: str | None = None) -> object:
    # Checked before recursing, so a sensitive key drops its whole subtree
    # ("Location": {"GeoCoord": {...}}) rather than only its scalar leaves.
    if key is not None and _is_sensitive(key):
        return REDACTED
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str) and _VIN_RE.match(value):
        return REDACTED
    return value
