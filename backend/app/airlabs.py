"""AirLabs flight source — the one that actually knows the gate.

WHY THIS EXISTS. aviationstack's free plan does not return a departure gate for
a live flight. Measured, not assumed: on 2026-08-20, BA1373 (MAN -> LHR) had a
gate on Manchester Airport's own departures board while aviationstack returned
`gate: null` for every one of its four records for that date — and returned
gate "A9" only on the SETTLED record for the previous day. The gate arrives
after it is useful.

AirLabs, asked about the same flight at the same moment, answered `dep_gate:
"A11"`. For EZY2229 it answered `dep_gate: "A3"` and `dep_delayed: 117` where
aviationstack had null for both. Gates and delays are the entire point of this
app, so AirLabs leads and aviationstack is the fallback.

THREE THINGS THIS SOURCE DOES BETTER, and one it does worse:

  + Gates and delays are populated while the flight still matters.
  + HTTPS works, so the upstream hop is encrypted (aviationstack's free tier
    is HTTP-only).
  + One flight object per request — AirLabs resolves codeshares itself, so
    none of the operating-carrier selection in `flight.py` is needed here.
  - Coverage is not total. `flight_iata=EZY2229` answers "not found", because
    EZY2229 is an ICAO number; and some flights it simply does not hold. Both
    are why `flight.py` keeps aviationstack behind it rather than dropping it.

TIME FORMAT. AirLabs sends `"2026-08-20 18:20"` — local airport time, a space
instead of a T, and no offset. The wire format this service promises is ISO
with a T, so the space is swapped and the value left offset-free: it is already
the wall clock the traveller reads off the departure board, which is exactly
what the glasses print. `dep_time_utc` is used ONLY to work out the airport's
offset, so "is this today?" can be answered in the airport's own reckoning.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

API_URL = "https://airlabs.co/api/v9/flight"

UPSTREAM_TIMEOUT_SECONDS = 10.0

# AirLabs answers 403 to urllib's default `Python-urllib/3.x` User-Agent.
# Confirmed on the server: identical URL and key, 403 with the default UA and
# 200 with any explicit one. Without this every AirLabs call fails, the chain
# quietly falls through to aviationstack, and the gate — the entire reason this
# source exists — silently goes missing again.
USER_AGENT = "flight-tracker/1.0 (+https://flight.berrydev.co.uk)"

# Three letters is ICAO (EZY2229, BAW117); two characters is IATA (U22229,
# BA117). AirLabs has a separate parameter for each and answers "not found" if
# you use the wrong one — silently spending a request to learn nothing.
ICAO_PATTERN = re.compile(r"[A-Z]{3}\d{1,4}[A-Z]?")

_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})")


class NotFound(Exception):
    """AirLabs has no record of this flight. Distinct from an outage: the
    caller should fall through to the other source, not report a failure."""


class Unavailable(Exception):
    """AirLabs could not be reached or refused the request."""


def query_field(flight_number: str) -> str:
    return "flight_icao" if ICAO_PATTERN.fullmatch(flight_number) else "flight_iata"


def fetch(flight_number: str, *, key: str) -> dict:
    """One upstream call. Returns the `response` object.

    AirLabs reports failure in an `error` object alongside HTTP 200, so the
    envelope is checked before the payload — the same trap aviationstack sets.
    """
    query = urllib.parse.urlencode(
        {query_field(flight_number): flight_number, "api_key": key}
    )
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Never log the URL — it carries api_key in the query string.
        raise Unavailable(f"airlabs returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise Unavailable("airlabs unreachable") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise Unavailable("airlabs sent a malformed response") from exc

    error = body.get("error") if isinstance(body, dict) else None
    if error:
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else str(error)
        if code == "not_found":
            raise NotFound(str(message))
        logger.error("airlabs error: code=%s message=%s", code, message)
        raise Unavailable(f"airlabs error: {message}")

    response_body = (body or {}).get("response")
    if not isinstance(response_body, dict) or not response_body:
        raise NotFound("airlabs returned no flight")
    return response_body


def _iso(value: str | None) -> str | None:
    """`"2026-08-20 18:20"` -> `"2026-08-20T18:20:00"`.

    Deliberately offset-free. The value is already the airport's local wall
    clock, which is what the departure board shows and what the glasses print;
    attaching an offset would invite something downstream to "helpfully"
    convert it into the phone's timezone.
    """
    if not value:
        return None
    match = _TIME.match(value.strip())
    if not match:
        return None
    return f"{match.group(1)}T{match.group(2)}:00"


def _local_offset(response: dict) -> timedelta | None:
    """The departure airport's UTC offset, derived from the two times AirLabs
    gives for the same instant. AirLabs sends no timezone name, and the offset
    is all `_is_today` actually needs."""
    local, utc = _iso(response.get("dep_time")), _iso(response.get("dep_time_utc"))
    if not local or not utc:
        return None
    try:
        return datetime.fromisoformat(local) - datetime.fromisoformat(utc)
    except ValueError:
        return None


def is_today(response: dict) -> bool:
    """Is this departure today, as the DEPARTURE AIRPORT reckons it?

    Not UTC: a 23:00 departure from JFK is still today in New York and already
    tomorrow in UTC. Unknown offset returns True — absent evidence is not
    evidence of staleness, and marking a good record stale is worse than
    missing a stale one.
    """
    departure = _iso(response.get("dep_time"))
    if not departure:
        return True
    offset = _local_offset(response)
    if offset is None:
        return True
    local_today = (datetime.now(timezone.utc) + offset).date().isoformat()
    return departure[:10] == local_today


def _int(value) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def shape(response: dict) -> dict:
    """Normalise into the wire payload `flight.FlightStatus` validates.

    Both sources are flattened to one shape here so the glasses app never
    learns which provider answered — it should not have to, and a client that
    branches on provider is a client that breaks when the fallback fires.
    """
    departure = _iso(response.get("dep_time"))
    return {
        # AirLabs resolves codeshares itself and reports the operating number,
        # so there is no selection to do — unlike aviationstack.
        "flight_iata": response.get("flight_iata"),
        "flight_date": departure[:10] if departure else None,
        "status": response.get("status"),
        "airline": response.get("airline_name"),
        "departure": {
            "airport": response.get("dep_name"),
            "iata": response.get("dep_iata"),
            "terminal": response.get("dep_terminal"),
            # The field this whole module exists for.
            "gate": response.get("dep_gate"),
            "baggage": None,
            "scheduled": departure,
            "estimated": _iso(response.get("dep_estimated")),
            "actual": _iso(response.get("dep_actual")),
            "delay": _int(response.get("dep_delayed")),
        },
        "arrival": {
            "airport": response.get("arr_name"),
            "iata": response.get("arr_iata"),
            "terminal": response.get("arr_terminal"),
            "gate": response.get("arr_gate"),
            "baggage": response.get("arr_baggage"),
            "scheduled": _iso(response.get("arr_time")),
            "estimated": _iso(response.get("arr_estimated")),
            "actual": _iso(response.get("arr_actual")),
            "delay": _int(response.get("arr_delayed")),
        },
        "stale": not is_today(response),
    }
