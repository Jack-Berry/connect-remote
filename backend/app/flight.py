"""Flight status lookup — aviationstack, trimmed to what a 576x288 HUD can show.

This module is a lodger in the car proxy: it shares the process, the CORS
policy and the per-IP rate limiter, and nothing else. No credentials, no
session cache, no car code paths.

THREE UPSTREAM FACTS drive almost every line below. All three were confirmed
against a real response for BA117 (LHR -> JFK) rather than inferred from the
aviationstack docs, which document none of them:

 1. **Codeshare duplicates, and the block is NESTED.** One physical flight comes
    back many times — BA117 returned SIX records: the British Airways one plus
    AA/AS/IB/EI/AY marketing numbers, all LHR T5 -> JFK T8. They are not
    near-duplicates to be de-duped by content; they carry DIFFERENT flight
    numbers for the SAME aircraft, and picking the wrong one shows the user a
    number they never booked under.

    The operating carrier is the record with no codeshare block — but that
    block lives at **`flight.codeshared`**, not at the record's top level.
    Reading `record["codeshared"]` finds a key that does not exist, so every
    record looks like an operating carrier, the rule matches all six, and an
    arbitrary tie-break wins. That shipped, and answered AA6930 to a request
    for BA117. See `_codeshare_of`.

 2. **Codeshare blocks are lowercase.** Inside `flight.codeshared`,
    `flight_iata` reads `"ba117"`, not `"BA117"`. Any match on it must be
    case-insensitive or the fallback path silently finds nothing. See
    `_number_eq`.

 3. **`flight_date` is not today.** The free plan happily returns yesterday's
    completed flight for a number that also flies today. A landed flight from
    12 hours ago rendered as current status is the single worst failure this
    app has — the user walks to the wrong gate. So the date is filtered in the
    DEPARTURE airport's timezone (a 23:00 JFK departure is still "yesterday" in
    UTC), and when nothing matches today we return the newest record we have
    with `stale: true` rather than 404. An honestly-labelled stale record beats
    a blank screen; the app prints the marker.

IATA *or* ICAO. Travellers read whichever number their booking shows, and the
two alphabets disagree: BA117 is IATA and BAW117 ICAO, while easyJet's EZY2229
is ICAO for what IATA calls U22229. Both forms are accepted and each is sent to
the matching upstream filter — `flight_iata` or `flight_icao`. See
`_query_field`.

QUOTA is the other constraint: the free plan allows 100 requests per MONTH.
That is roughly three per day. The in-memory cache is therefore not an
optimisation, it is the only reason the app can run at all — a flight looked up
repeatedly costs one upstream call per 5-minute bucket, and every extra viewer
of that same flight costs nothing. Upstream failures are cached too (briefly):
a broken key that answered 100 times would burn the month's budget in an hour.

PLAIN HTTP, deliberately. The free plan rejects HTTPS on api.aviationstack.com
(paid tiers only), so the upstream hop is unencrypted. That is acceptable
exactly here and nowhere else in this service: the request carries a public
flight number and our API key, the response is public timetable data, and the
client-facing hop is still TLS via Caddy. The key is the thing at risk on that
hop, which is why it lives in the environment and is rotatable.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel

from . import flight_store

logger = logging.getLogger(__name__)

# The two flight-number alphabets, as regexes, so the API layer and this module
# validate identically. IATA: a two-character airline designator with at least
# one letter (BA, U2, 9W), then 1-4 digits and an optional suffix letter. ICAO:
# three letters (BAW, EZY, RYR), then the same.
#
# The alternation in the IATA form is not decoration. `[A-Z0-9]{2,3}` accepts
# "12345" as an all-digit designator and, because it can eat a digit, also
# accepts "BA12345" as BA1 + 2345. A test caught the second one.
IATA_PATTERN = re.compile(r"(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}[A-Z]?")
ICAO_PATTERN = re.compile(r"[A-Z]{3}\d{1,4}[A-Z]?")


def is_flight_number(value: str) -> bool:
    """Accept either alphabet. Validation happens before the upstream call so a
    junk path segment costs nothing out of a 100-request MONTHLY budget."""
    return bool(IATA_PATTERN.fullmatch(value) or ICAO_PATTERN.fullmatch(value))

# Free plan: HTTP only. See the module docstring before "fixing" this to https.
API_URL = "http://api.aviationstack.com/v1/flights"

# Freshness window and monthly budget both live in flight_store.py, tunable by
# environment variable — they are storage policy, not lookup logic.

# Upstream socket timeout. The endpoint runs in FastAPI's threadpool, so a hung
# connection ties up a worker thread; the glasses give up long before 10s anyway.
UPSTREAM_TIMEOUT_SECONDS = 10.0


class FlightUnavailable(Exception):
    """Upstream could not be reached, or answered with an error envelope.

    Carries an HTTP status for the caller to re-raise with: 404 when the flight
    genuinely has no records, 502 when aviationstack is the problem.
    """

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class Endpoint(BaseModel):
    """One end of the flight. `baggage` is arrival-only and stays None on the
    departure side — the shape is shared so the client has one renderer."""

    airport: str | None = None
    # The three-letter code as well as the name: "LHR" fits the HUD, "London
    # Heathrow" does not. Additive to the agreed field list, not a replacement.
    iata: str | None = None
    terminal: str | None = None
    gate: str | None = None
    baggage: str | None = None
    scheduled: str | None = None
    estimated: str | None = None
    actual: str | None = None
    # Minutes. Null and 0 are different answers upstream ("unknown" vs "on
    # time") and the client renders them differently, so this is not defaulted.
    delay: int | None = None


class FlightStatus(BaseModel):
    """The whole payload. Everything the HUD draws, nothing it doesn't.

    Deliberately omits the upstream's aircraft/live/airline blocks: they are
    tens of fields the glasses cannot show, and shipping them would put an
    aircraft registration on the wire for no reason.
    """

    flight_iata: str | None = None
    flight_date: str | None = None
    status: str | None = None
    departure: Endpoint
    arrival: Endpoint
    # True when no record matched today in the departure timezone and this is
    # the most recent one we have. The client MUST label it; see module docs.
    stale: bool = False
    # When the proxy last actually spoke to the upstream, ISO-8601 UTC. Set on
    # the way out, including on a cache hit, so the glasses can print an honest
    # "Updated 14:02" for data retrieved at 14:02 and served from disk at
    # 18:30. Without it the client stamps its own receive time and every cache
    # hit becomes a quiet lie about how current the gate number is.
    fetched_at: str | None = None
    # Seconds since that fetch. Same information, pre-computed, because the
    # glasses have no clock of their own worth trusting.
    age_seconds: int | None = None


# --------------------------------------------------------------------------
# Storage
#
# Results live on the server volume, not just in process memory — see
# flight_store.py for why (short version: every redeploy used to throw the
# cache away and pay for it out of a 100-request MONTHLY budget).
#
# The per-flight lock stays, and is still about quota rather than dict safety:
# two taps landing in the same second on a cold flight would otherwise both
# miss and both call upstream, spending two requests to learn one thing.

store = flight_store.build_store()

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(number: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(number, threading.Lock())


# --------------------------------------------------------------------------
# Record selection


def _number_eq(a: str | None, b: str | None) -> bool:
    """Case-insensitive flight-number comparison.

    Load-bearing: the codeshare block spells the number lowercase
    (`"ba117"`) while the top-level flight object spells it uppercase
    (`"BA117"`). Confirmed in the captured response — see the fixture.
    """
    if a is None or b is None:
        return False
    return a.strip().lower() == b.strip().lower()


def _codeshare_of(record: dict) -> dict | None:
    """The codeshare block, which lives at `flight.codeshared` — NESTED inside
    the flight object, NOT at the top level of the record.

    This one path cost a wrong answer in production: reading
    `record["codeshared"]` finds nothing, because that key does not exist at
    all. Every record then looks like an operating carrier, the selection rule
    matches all six, and an arbitrary tie-break answered AA6930 to a request
    for BA117. The fixture pins the real nesting.
    """
    return (record.get("flight") or {}).get("codeshared")


def _is_operating(record: dict) -> bool:
    """True for the carrier that actually flies the aircraft — the record with
    no codeshare block, carrying the authoritative gate/terminal/baggage."""
    return _codeshare_of(record) is None


def _matches_number(record: dict, requested: str) -> bool:
    """Does this record carry the number the user typed, in either alphabet?

    Both are checked because the two coexist in the wild: BA117 is the IATA
    form and BAW117 the ICAO one, and easyJet's EZY2229 is an ICAO number
    whose IATA form is U22229. Travellers use whichever their booking shows.
    """
    flight_block = record.get("flight") or {}
    return _number_eq(flight_block.get("iata"), requested) or _number_eq(
        flight_block.get("icao"), requested
    )


def _shadows_number(record: dict, requested: str) -> bool:
    """This record is a marketing copy OF the requested flight — its codeshare
    block names it. Used when the operating record itself is absent."""
    codeshare = _codeshare_of(record)
    if not codeshare:
        return False
    return _number_eq(codeshare.get("flight_iata"), requested) or _number_eq(
        codeshare.get("flight_icao"), requested
    )


def _select_carrier(records: list[dict], flight_number: str) -> list[dict]:
    """Narrow a codeshare set to the records describing the flight asked about.

    THE SHAPE OF THE PROBLEM, from a real BA117 response (saved verbatim in
    tests/fixtures/ba117-aviationstack.json): one aircraft, LHR T5 -> JFK T8,
    returned SIX times — as AA6930, AS5255, IB3545, EI8817, AY5517 and BA117.
    Five carry `flight.codeshared` naming `"ba117"`; only BA117 itself has no
    codeshare block. Picking the wrong one shows a flight number the traveller
    never booked under.

    Four tiers, in order:

      1. The operating carrier (no codeshare block). This is the record with
         real gate/terminal/baggage data and the number printed on the
         aircraft. Where several operating records come back, one matching the
         requested number wins.
      2. Exact match on `flight.iata` or `flight.icao` — the operating record
         is absent, so honour the number the user typed.
      3. A marketing record whose codeshare block NAMES the requested flight.
         Same aircraft, same gate, different number on the ticket.
      4. Everything. Reached only if upstream answered about a different
         flight entirely, which we surface rather than 404 — being wrong
         loudly beats being blank.
    """
    operating = [r for r in records if _is_operating(r)]
    if operating:
        exact = [r for r in operating if _matches_number(r, flight_number)]
        return exact or operating

    exact = [r for r in records if _matches_number(r, flight_number)]
    if exact:
        return exact

    shadowing = [r for r in records if _shadows_number(r, flight_number)]
    if shadowing:
        logger.info(
            "flight %s: no operating record; using a marketing copy of it",
            flight_number,
        )
        return shadowing

    logger.warning(
        "flight %s: nothing in %d records matches by number or codeshare",
        flight_number,
        len(records),
    )
    return records


def _departure_today(record: dict) -> str | None:
    """Today's date as the DEPARTURE airport reckons it.

    Not UTC: a 23:00 departure from JFK is still today in New York and already
    tomorrow in UTC, and `flight_date` is the airport's local date. Getting this
    wrong makes every late-evening westbound flight look stale.

    Returns None when the record carries no usable timezone, which tells the
    caller to skip the date filter for that record rather than guess.
    """
    tz_name = (record.get("departure") or {}).get("timezone")
    if not tz_name:
        return None
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        logger.warning("unknown departure timezone %r; skipping date filter", tz_name)
        return None
    return datetime.now(tz).date().isoformat()


def _sort_key(record: dict) -> str:
    """Newest-last ordering for the stale fallback. `flight_date` is an ISO
    date so it sorts lexicographically; scheduled departure breaks ties between
    two records on the same date."""
    date = record.get("flight_date") or ""
    scheduled = (record.get("departure") or {}).get("scheduled") or ""
    return f"{date}T{scheduled}"


def select_record(records: list[dict], flight_number: str) -> tuple[dict, bool]:
    """Pick the one record to render, and say whether it is stale.

    Returns `(record, stale)`. Raises `FlightUnavailable(404)` only when there
    is genuinely nothing to choose from.
    """
    if not records:
        raise FlightUnavailable(f"no flights found for {flight_number}", status=404)

    candidates = _select_carrier(records, flight_number)

    # A record with no departure timezone can't be date-filtered, so it is never
    # rejected as "not today" — absent evidence is not evidence of staleness.
    today = []
    for record in candidates:
        local_date = _departure_today(record)
        if local_date is None or record.get("flight_date") == local_date:
            today.append(record)

    if today:
        # More than one match means the same number flies twice today; the
        # earliest scheduled departure is the one still ahead of the traveller
        # often enough, and upstream orders them that way already.
        return min(today, key=_sort_key), False

    return max(candidates, key=_sort_key), True


# --------------------------------------------------------------------------
# Shaping


def _endpoint(block: dict | None, *, include_baggage: bool) -> Endpoint:
    block = block or {}
    return Endpoint(
        airport=block.get("airport"),
        iata=block.get("iata"),
        terminal=block.get("terminal"),
        gate=block.get("gate"),
        baggage=block.get("baggage") if include_baggage else None,
        scheduled=block.get("scheduled"),
        estimated=block.get("estimated"),
        actual=block.get("actual"),
        delay=block.get("delay"),
    )


def shape(record: dict, stale: bool) -> FlightStatus:
    """Trim one upstream record down to the wire payload."""
    return FlightStatus(
        flight_iata=(record.get("flight") or {}).get("iata"),
        flight_date=record.get("flight_date"),
        status=record.get("flight_status"),
        departure=_endpoint(record.get("departure"), include_baggage=False),
        arrival=_endpoint(record.get("arrival"), include_baggage=True),
        stale=stale,
    )


# --------------------------------------------------------------------------
# Upstream


def _api_key() -> str:
    key = os.environ.get("AVIATIONSTACK_KEY", "").strip()
    if not key:
        # 503, not 500: the code is fine, the deployment is missing a secret.
        raise FlightUnavailable("flight lookup is not configured on this server", status=503)
    return key


def _query_field(flight_number: str) -> str:
    """Which upstream filter this number belongs in.

    A three-letter airline designator is ICAO (BAW117, EZY2229); a two-character
    one is IATA (BA117, U22229). Sending an ICAO number to `flight_iata` matches
    nothing and silently spends one of the month's hundred requests, so the
    choice is made from the shape of the number, not guessed.
    """
    return "flight_icao" if ICAO_PATTERN.fullmatch(flight_number) else "flight_iata"


def _fetch(flight_number: str, *, key: str) -> list[dict]:
    """One upstream call. Returns the raw `data` array.

    aviationstack signals failure with HTTP 200 and an `error` object as often
    as with a status code (quota exhaustion in particular), so the envelope is
    checked before the payload.
    """
    query = urllib.parse.urlencode(
        {"access_key": key, _query_field(flight_number): flight_number}
    )
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Never log the URL — it carries access_key in the query string.
        raise FlightUnavailable(f"flight service returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise FlightUnavailable("flight service unreachable") from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise FlightUnavailable("flight service sent a malformed response") from exc

    if isinstance(body, dict) and body.get("error"):
        error = body["error"]
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else str(error)
        logger.error("aviationstack error: code=%s message=%s", code, message)
        # Quota is the failure that will actually happen, and it is ours, not
        # the user's — say so plainly so the HUD can't blame their network.
        if code in ("usage_limit_reached", "rate_limit_reached", "too_many_requests"):
            raise FlightUnavailable("flight lookups are over their monthly quota", status=503)
        raise FlightUnavailable(f"flight service error: {message}")

    data = (body or {}).get("data")
    if not isinstance(data, list):
        raise FlightUnavailable("flight service sent no data")
    return data


def _from_entry(entry: flight_store.Entry) -> FlightStatus:
    """Rebuild the response from a stored payload, re-stamping its real age."""
    payload = dict(entry.payload)
    payload["fetched_at"] = flight_store.iso(entry.fetched_at)
    payload["age_seconds"] = int(entry.age_seconds())
    return FlightStatus.model_validate(payload)


def lookup(flight_number: str) -> FlightStatus:
    """Flight status, from storage where possible and upstream only when not.

    The order here IS the quota policy:

      1. A stored result inside the freshness window is returned as-is. No
         network, no budget spent, however many times it is asked for.
      2. Past the window we want a refresh — but only if the month's budget
         allows one. Exhausted budget serves the stored copy rather than an
         error, because old gate information beats none.
      3. A refresh that fails falls back to the stored copy for the same
         reason. Only a flight we have never successfully fetched can produce
         an error.
    """
    number = flight_number.strip().upper()
    entry = store.get(number)
    if entry is not None and store.is_fresh(entry):
        return _from_entry(entry)

    # Serialise cold misses per flight so concurrent callers spend one upstream
    # request between them, not one each.
    with _lock_for(number):
        # Re-read: another thread may have refreshed while we waited.
        entry = store.get(number)
        if entry is not None and store.is_fresh(entry):
            return _from_entry(entry)

        if not store.reserve():
            if entry is not None:
                logger.warning(
                    "flight %s: monthly budget spent — serving stored result from %s",
                    number, flight_store.iso(entry.fetched_at),
                )
                return _from_entry(entry)
            raise FlightUnavailable(
                "flight lookups are over their monthly quota", status=503
            )

        try:
            records = _fetch(number, key=_api_key())
            record, stale = select_record(records, number)
        except FlightUnavailable as exc:
            if entry is not None:
                # The traveller had good data a moment ago; an error screen
                # would take it away and give nothing back.
                logger.warning(
                    "flight %s: refresh failed (%s) — serving stored result from %s",
                    number, exc, flight_store.iso(entry.fetched_at),
                )
                return _from_entry(entry)
            raise

        payload = shape(record, stale).model_dump()
        stored = store.put(number, payload)
        return _from_entry(stored)
