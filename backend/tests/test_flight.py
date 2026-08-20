"""Flight endpoint tests.

The fixtures below mirror the shape of a real aviationstack response for BA117
(LHR T5 -> JFK T7), including the six-way codeshare fan-out that motivated
`_select_carrier` and the lowercase `flight_iata` inside the codeshare blocks.
If aviationstack ever changes either, these tests are what will notice.
"""

import json
import pathlib
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import flight, flight_store
from app.main import app

LONDON = ZoneInfo("Europe/London")


def today_lhr() -> str:
    return datetime.now(LONDON).date().isoformat()


def yesterday_lhr() -> str:
    return (datetime.now(LONDON) - timedelta(days=1)).date().isoformat()


def operating(date: str, **overrides) -> dict:
    """The British Airways record — the one with real gate/terminal data."""
    record = {
        "flight_date": date,
        "flight_status": "scheduled",
        "departure": {
            "airport": "London Heathrow",
            "iata": "LHR",
            "timezone": "Europe/London",
            "terminal": "5",
            "gate": "A10",
            "delay": 15,
            "scheduled": f"{date}T14:20:00+00:00",
            "estimated": f"{date}T14:20:00+00:00",
            "actual": None,
        },
        "arrival": {
            "airport": "John F Kennedy International",
            "iata": "JFK",
            "timezone": "America/New_York",
            "terminal": "7",
            "gate": "1",
            "baggage": "7",
            "delay": None,
            "scheduled": f"{date}T17:25:00-05:00",
            "estimated": f"{date}T17:25:00-05:00",
            "actual": None,
        },
        "airline": {"name": "British Airways", "iata": "BA"},
        # No `codeshared` key inside `flight` — that absence is what marks the
        # operating carrier. Note it is NESTED here, matching the real API.
        "flight": {"number": "117", "iata": "BA117", "icao": "BAW117"},
    }
    record.update(overrides)
    return record


def marketing(date: str, iata: str) -> dict:
    """A codeshare copy. Note the LOWERCASE flight_iata in `codeshared` — this
    is verbatim upstream behaviour and the reason `_iata_eq` exists."""
    return {
        "flight_date": date,
        "flight_status": "scheduled",
        # Marketing records routinely carry null gate/terminal — another reason
        # to prefer the operating carrier.
        "departure": {
            "airport": "London Heathrow",
            "iata": "LHR",
            "timezone": "Europe/London",
            "terminal": None,
            "gate": None,
            "delay": None,
            "scheduled": f"{date}T14:20:00+00:00",
            "estimated": None,
            "actual": None,
        },
        "arrival": {
            "airport": "John F Kennedy International",
            "iata": "JFK",
            "timezone": "America/New_York",
            "terminal": None,
            "gate": None,
            "baggage": None,
            "delay": None,
            "scheduled": f"{date}T17:25:00-05:00",
            "estimated": None,
            "actual": None,
        },
        # `codeshared` NESTED inside `flight`, exactly where the real API puts
        # it, and lowercase exactly as the real API spells it.
        "flight": {
            "number": iata[2:],
            "iata": iata,
            "icao": None,
            "codeshared": {
                "airline_name": "british airways",
                "airline_iata": "ba",
                "airline_icao": "baw",
                "flight_number": "117",
                "flight_iata": "ba117",
                "flight_icao": "baw117",
            },
        },
    }


def ba117_set(date: str | None = None) -> list[dict]:
    """All six records, marketing copies FIRST so a naive `data[0]` fails."""
    date = date or today_lhr()
    return [
        marketing(date, "AA6167"),
        marketing(date, "IB7458"),
        marketing(date, "EI7231"),
        marketing(date, "AY5551"),
        marketing(date, "AS6851"),
        operating(date),
    ]


FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def real_ba117() -> list[dict]:
    """The VERBATIM aviationstack response for BA117, captured 2026-08-20.

    Six records for one aircraft (LHR T5 -> JFK T8) under six different flight
    numbers — and `codeshared` is null on ALL SIX, including the marketing
    ones. This is the response that proved the original "pick codeshared is
    null" rule cannot discriminate, and it is why the exact flight number now
    leads. Do not hand-edit: re-capture it if the upstream shape changes.
    """
    return json.loads((FIXTURES / "ba117-aviationstack.json").read_text())["data"]


@pytest.fixture(autouse=True)
def fresh_store(tmp_path):
    """Every test gets its own on-disk store, so nothing leaks between them
    and the persistence path is exercised rather than mocked away."""
    previous = flight.store
    flight.store = flight_store.FlightStore(str(tmp_path / "flights.json"))
    yield flight.store
    flight.store = previous


# --------------------------------------------------------------------------
# Record selection, against the real captured response


def test_real_response_returns_the_number_the_user_asked_for():
    """The regression that shipped: BA117 answered AA6930.

    All six records have codeshared=null, so the operating-carrier rule
    matched every one of them and an arbitrary tie-break won. The exact
    flight number is the only field that identifies the right record.
    """
    records = real_ba117()
    assert len(records) == 6

    # THE BUG, pinned: there is no top-level `codeshared` key on ANY record, so
    # the original `record["codeshared"] is None` test was true for all six and
    # an arbitrary tie-break answered AA6930. The block lives one level down.
    assert all("codeshared" not in r for r in records)
    assert sum(1 for r in records if (r["flight"].get("codeshared")) is None) == 1

    record, _ = flight.select_record(records, "BA117")
    assert record["flight"]["iata"] == "BA117"
    assert flight._codeshare_of(record) is None


def test_real_response_is_flagged_stale_not_presented_as_current():
    """Captured on 2026-08-20; every record is dated 2026-08-19 and landed.
    Presenting that as current status is the worst failure this app has."""
    records = real_ba117()
    assert all(r["flight_date"] == "2026-08-19" for r in records)
    _, stale = flight.select_record(records, "BA117")
    assert stale is True


def test_real_response_shapes_into_the_wire_payload():
    record, stale = flight.select_record(real_ba117(), "BA117")
    payload = flight.shape(record, stale)
    assert payload.flight_iata == "BA117"
    assert payload.airline == "British Airways"
    assert payload.status == "landed"
    assert payload.departure.iata == "LHR"
    assert payload.departure.terminal == "5"
    assert payload.arrival.iata == "JFK"
    assert payload.arrival.terminal == "8"
    assert payload.stale is True


def test_any_marketing_number_resolves_to_the_operating_carrier():
    """Ask for AA6930 — a codeshare sold by American — and get BA117.

    That is the specified behaviour and the right one: the operating record is
    the one carrying authoritative gate, terminal and baggage data. The
    traveller sees the number the aircraft actually flies under, which is also
    what the departure board shows.
    """
    for sold_as in ("AA6930", "AS5255", "IB3545", "EI8817", "AY5517", "BA117"):
        record, _ = flight.select_record(real_ba117(), sold_as)
        assert record["flight"]["iata"] == "BA117", sold_as


def test_real_set_is_matched_by_icao_number_too():
    """BAW117 is BA117 in the other alphabet. easyJet's EZY2229 is the case
    that matters in practice — its IATA form is U22229."""
    record, _ = flight.select_record(real_ba117(), "BAW117")
    assert record["flight"]["iata"] == "BA117"


def test_lowercase_request_still_finds_the_real_record():
    record, _ = flight.select_record(real_ba117(), "ba117")
    assert record["flight"]["iata"] == "BA117"


# --------------------------------------------------------------------------
# Record selection, synthetic


def test_picks_operating_carrier_out_of_a_codeshare_set():
    record, stale = flight.select_record(ba117_set(), "BA117")
    assert record["flight"]["iata"] == "BA117"
    # Operating carrier = no codeshare block, read from the NESTED path.
    assert flight._codeshare_of(record) is None
    assert stale is False
    # The whole point: the operating record is the one carrying gate data.
    assert record["departure"]["terminal"] == "5"


def test_marketing_number_resolves_to_the_operating_record_it_shadows():
    """User booked AA6167, which is operated as BA117. The BA117 record is in
    the same response and is the one with real gate data, so it wins."""
    record, stale = flight.select_record(ba117_set(), "AA6167")
    assert record["flight"]["iata"] == "BA117"
    assert stale is False


def test_marketing_number_used_when_no_operating_record_came_back():
    """Tier 2: every record is a codeshare, so honour the number typed."""
    date = today_lhr()
    records = [marketing(date, "AA6167"), marketing(date, "IB7458")]
    record, _ = flight.select_record(records, "aa6167")
    assert record["flight"]["iata"] == "AA6167"


def test_codeshare_block_naming_the_requested_flight_is_tier_three():
    """Tier 3: the user asked for BA117, no BA117 record came back, but the
    marketing copies name `ba117` (lowercase) as the flight they shadow.
    Same aircraft, same gate — better than a 404."""
    date = today_lhr()
    records = [marketing(date, "AA6167"), marketing(date, "IB7458")]
    record, _ = flight.select_record(records, "BA117")
    assert flight._shadows_number(record, "BA117")


def test_number_comparison_is_case_insensitive():
    # The codeshare block spells it "ba117"; the flight object spells it
    # "BA117". Without this the tier-3 fallback silently finds nothing.
    assert flight._number_eq("BA117", "ba117")
    assert flight._number_eq(" ba117 ", "BA117")
    assert not flight._number_eq("BA117", "BA118")
    assert not flight._number_eq(None, "BA117")


def test_yesterdays_flight_is_returned_but_flagged_stale():
    record, stale = flight.select_record(ba117_set(yesterday_lhr()), "BA117")
    assert stale is True
    assert record["flight_date"] == yesterday_lhr()


def test_today_wins_over_yesterday_in_a_mixed_set():
    records = ba117_set(yesterday_lhr()) + ba117_set(today_lhr())
    record, stale = flight.select_record(records, "BA117")
    assert stale is False
    assert record["flight_date"] == today_lhr()


def test_stale_fallback_picks_the_most_recent_record():
    older = operating("2020-01-01")
    newer = operating("2020-06-01")
    record, stale = flight.select_record([older, newer], "BA117")
    assert stale is True
    assert record["flight_date"] == "2020-06-01"


def test_date_is_judged_in_the_departure_timezone_not_utc():
    """A late departure from Auckland is 'today' locally while UTC has not got
    there yet — filtering in UTC would call it stale."""
    nz = ZoneInfo("Pacific/Auckland")
    local_today = datetime.now(nz).date().isoformat()
    record = operating(local_today)
    record["departure"]["timezone"] = "Pacific/Auckland"
    picked, stale = flight.select_record([record], "BA117")
    assert stale is False
    assert picked["flight_date"] == local_today


def test_missing_timezone_is_not_treated_as_stale():
    record = operating("2020-01-01")
    record["departure"]["timezone"] = None
    _, stale = flight.select_record([record], "BA117")
    assert stale is False


def test_unknown_timezone_is_not_treated_as_stale():
    record = operating("2020-01-01")
    record["departure"]["timezone"] = "Mars/Olympus_Mons"
    _, stale = flight.select_record([record], "BA117")
    assert stale is False


def test_empty_data_is_a_404():
    with pytest.raises(flight.FlightUnavailable) as exc:
        flight.select_record([], "BA117")
    assert exc.value.status == 404


# --------------------------------------------------------------------------
# Shaping


def test_shape_trims_to_the_wire_fields():
    payload = flight.shape(operating(today_lhr()), stale=False)
    assert payload.flight_iata == "BA117"
    assert payload.status == "scheduled"
    assert payload.departure.iata == "LHR"
    assert payload.departure.terminal == "5"
    assert payload.departure.gate == "A10"
    assert payload.departure.delay == 15
    assert payload.arrival.baggage == "7"
    # baggage is arrival-only; the departure block must not invent one.
    assert payload.departure.baggage is None
    assert payload.stale is False
    # The upstream's aircraft/live/airline blocks are deliberately dropped.
    assert not hasattr(payload, "aircraft")


def test_null_delay_survives_as_null():
    """0 means 'on time', null means 'unknown'. The HUD renders them
    differently, so null must not be defaulted to 0."""
    payload = flight.shape(operating(today_lhr()), stale=False)
    assert payload.arrival.delay is None


# --------------------------------------------------------------------------
# HTTP endpoint


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AVIATIONSTACK_KEY", "test-key")
    return TestClient(app)


def test_endpoint_returns_the_operating_carrier(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    response = client.get("/flight/BA117")
    assert response.status_code == 200
    body = response.json()
    assert body["flight_iata"] == "BA117"
    assert body["departure"]["terminal"] == "5"
    assert body["stale"] is False


def test_endpoint_uppercases_the_path_segment(client, monkeypatch):
    seen = []

    def fake(number, *, key):
        seen.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)
    assert client.get("/flight/ba117").status_code == 200
    assert seen == ["BA117"]


def test_endpoint_rejects_junk_without_calling_upstream(client, monkeypatch):
    def explode(number, *, key):  # pragma: no cover - must never run
        raise AssertionError("upstream called for a malformed flight number")

    monkeypatch.setattr(flight, "_fetch", explode)
    for bad in ("hello", "1", "BA", "BAW", "BA12345", "12345", "EZY22299", "../etc/passwd"):
        assert client.get(f"/flight/{bad}").status_code in (400, 404), bad


def test_endpoint_accepts_both_alphabets(client, monkeypatch):
    """BAW117 and EZY2229 are ICAO; BA117 and U22229 are IATA. A traveller
    types whichever their booking shows."""
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    for good in ("BA117", "U22229", "BAW117", "EZY2229", "9W123"):
        assert client.get(f"/flight/{good}").status_code == 200, good


def test_icao_numbers_go_to_the_icao_upstream_filter():
    """Sending an ICAO number to `flight_iata` matches nothing upstream and
    silently spends one of the month's hundred requests."""
    assert flight._query_field("EZY2229") == "flight_icao"
    assert flight._query_field("BAW117") == "flight_icao"
    assert flight._query_field("BA117") == "flight_iata"
    assert flight._query_field("U22229") == "flight_iata"
    assert flight._query_field("9W123") == "flight_iata"


def test_stored_result_is_served_without_a_second_upstream_call(client, monkeypatch):
    calls = []

    def fake(number, *, key):
        calls.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)
    assert client.get("/flight/BA117").status_code == 200
    assert client.get("/flight/BA117").status_code == 200
    # The whole 100-requests-per-month budget rests on this being 1.
    assert len(calls) == 1


def test_storage_is_keyed_per_flight(client, monkeypatch):
    calls = []

    def fake(number, *, key):
        calls.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)
    client.get("/flight/BA117")
    client.get("/flight/BA118")
    assert calls == ["BA117", "BA118"]


def test_a_stale_entry_triggers_exactly_one_refresh(client, monkeypatch):
    calls = []

    def fake(number, *, key):
        calls.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)
    client.get("/flight/BA117")
    # Age the stored entry past the freshness window.
    flight.store.get("BA117").fetched_at -= 10_000
    client.get("/flight/BA117")
    assert len(calls) == 2


def test_results_survive_a_restart(tmp_path, monkeypatch):
    """THE REASON THIS STORE EXISTS. A redeploy used to throw the cache away
    and pay for it out of the monthly budget."""
    path = str(tmp_path / "flights.json")
    monkeypatch.setenv("AVIATIONSTACK_KEY", "test-key")

    calls = []

    def fake(number, *, key):
        calls.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)

    flight.store = flight_store.FlightStore(path)
    assert flight.lookup("BA117").flight_iata == "BA117"
    assert len(calls) == 1

    # A new process, same volume — exactly what `docker compose up -d` does.
    flight.store = flight_store.FlightStore(path)
    assert flight.lookup("BA117").flight_iata == "BA117"
    assert len(calls) == 1, "a restart must not cost an upstream call"


def test_fetched_at_reports_the_real_retrieval_time_not_the_serve_time(client, monkeypatch):
    """A cache hit must not claim to be fresh. The glasses print this."""
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    first = client.get("/flight/BA117").json()
    assert first["age_seconds"] < 5

    # Age the stored entry by an hour and exhaust the budget, so the stored
    # copy is served rather than refreshed.
    entry = flight.store.get("BA117")
    entry.fetched_at -= 3600
    aged_to = flight_store.iso(entry.fetched_at)
    flight.store._calls = flight.store._monthly_budget

    second = client.get("/flight/BA117").json()
    # The served payload reports the hour-old retrieval time, NOT now. This is
    # the field the glasses print as "Updated"; getting it wrong makes every
    # cache hit a quiet lie about how current the gate number is.
    assert second["age_seconds"] >= 3600
    assert second["fetched_at"] == aged_to
    assert second["fetched_at"] != first["fetched_at"]


def test_upstream_failure_falls_back_to_the_stored_result(client, monkeypatch):
    """Old gate information beats an error screen."""
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    assert client.get("/flight/BA117").status_code == 200

    flight.store.get("BA117").fetched_at -= 10_000

    def fail(number, *, key):
        raise flight.FlightUnavailable("flight service unreachable")

    monkeypatch.setattr(flight, "_fetch", fail)
    response = client.get("/flight/BA117")
    assert response.status_code == 200
    assert response.json()["flight_iata"] == "BA117"
    assert response.json()["age_seconds"] >= 10_000


def test_upstream_failure_with_nothing_stored_is_a_502(client, monkeypatch):
    def fail(number, *, key):
        raise flight.FlightUnavailable("flight service unreachable")

    monkeypatch.setattr(flight, "_fetch", fail)
    assert client.get("/flight/BA117").status_code == 502


def test_monthly_budget_stops_upstream_calls(client, monkeypatch):
    calls = []

    def fake(number, *, key):
        calls.append(number)
        return ba117_set()

    monkeypatch.setattr(flight, "_fetch", fake)
    flight.store._monthly_budget = 2
    for n in ("BA117", "BA118", "BA119", "BA120"):
        client.get(f"/flight/{n}")
    # A runaway client hits OUR ceiling, not the provider's — theirs gives no
    # warning and takes a month to clear.
    assert len(calls) == 2


def test_budget_exhausted_still_serves_a_stored_result(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    assert client.get("/flight/BA117").status_code == 200
    flight.store.get("BA117").fetched_at -= 10_000
    flight.store._calls = flight.store._monthly_budget
    assert client.get("/flight/BA117").status_code == 200


def test_budget_exhausted_with_nothing_stored_is_a_503(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    flight.store._calls = flight.store._monthly_budget
    assert client.get("/flight/ZZ999").status_code == 503


def test_budget_is_counted_before_the_call_not_after_it_succeeds(client, monkeypatch):
    """A call that times out still consumed the provider's quota."""
    def fail(number, *, key):
        raise flight.FlightUnavailable("flight service unreachable")

    monkeypatch.setattr(flight, "_fetch", fail)
    client.get("/flight/BA117")
    assert flight.store.usage()["used"] == 1


def test_budget_survives_a_restart(tmp_path):
    path = str(tmp_path / "flights.json")
    store = flight_store.FlightStore(path, monthly_budget=3)
    assert store.reserve() and store.reserve()
    reloaded = flight_store.FlightStore(path, monthly_budget=3)
    assert reloaded.usage()["used"] == 2
    assert reloaded.reserve() is True
    assert reloaded.reserve() is False


def test_budget_rolls_over_on_a_new_month(tmp_path, monkeypatch):
    path = str(tmp_path / "flights.json")
    store = flight_store.FlightStore(path, monthly_budget=1)
    assert store.reserve() is True
    assert store.reserve() is False
    monkeypatch.setattr(flight_store, "_month_key", lambda at=None: "2099-01")
    assert store.reserve() is True


def test_corrupt_store_is_quarantined_not_fatal(tmp_path):
    path = tmp_path / "flights.json"
    path.write_text("{not json")
    store = flight_store.FlightStore(str(path))
    assert store.usage()["used"] == 0
    assert (tmp_path / "flights.json.corrupt").exists()


def test_one_unreadable_entry_does_not_cost_the_others(tmp_path):
    path = tmp_path / "flights.json"
    path.write_text(json.dumps({
        "entries": {
            "BA117": {"payload": {"flight_iata": "BA117"}, "fetched_at": 1_000_000.0},
            "JUNK1": {"payload": "not a dict", "fetched_at": "not a number"},
        },
        "usage": {"month": "2099-01", "calls": 4},
    }))
    store = flight_store.FlightStore(str(path))
    assert store.get("BA117") is not None
    assert store.get("JUNK1") is None


def test_boot_status_is_visible_even_though_the_store_is_built_pre_logging(tmp_path):
    """The store is constructed while `from . import flight` runs, one line
    ABOVE logging.basicConfig, so its own boot record is dropped. log_status()
    replays it. The first deploy shipped without this and the line vanished."""
    store = flight_store.FlightStore(str(tmp_path / "flights.json"))
    line = store.log_status()
    assert "ACTIVE" in line
    assert "upstream calls used in" in line
    assert "remaining" in line


def test_boot_status_announces_degradation_loudly(tmp_path):
    unwritable = tmp_path / "nope" / "flights.json"  # parent does not exist
    store = flight_store.FlightStore(str(unwritable))
    line = store.log_status()
    # This is the line that distinguishes "working" from "quietly costing you
    # an upstream call on every restart".
    assert "DEGRADED" in line


def test_a_stored_payload_missing_a_newer_field_still_loads(client, monkeypatch):
    """Fields get added to FlightStatus; entries already on disk predate them.
    A stored payload must degrade to None, not blow up the endpoint."""
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    client.get("/flight/BA117")
    entry = flight.store.get("BA117")
    entry.payload.pop("airline", None)
    flight.store._calls = flight.store._monthly_budget  # force the stored path
    entry.fetched_at -= 10_000
    body = client.get("/flight/BA117").json()
    assert body["airline"] is None
    assert body["flight_iata"] == "BA117"


def test_usage_endpoint_reports_headroom(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    client.get("/flight/BA117")
    usage = client.get("/flight-usage").json()
    assert usage["used"] == 1
    assert usage["remaining"] == usage["budget"] - 1
    assert "BA117" in usage["stored_flights"]


def test_stale_records_are_flagged_on_the_wire(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set(yesterday_lhr()))
    body = client.get("/flight/BA117").json()
    assert body["stale"] is True


def test_cors_is_wide_open(client, monkeypatch):
    monkeypatch.setattr(flight, "_fetch", lambda number, *, key: ba117_set())
    response = client.get("/flight/BA117", headers={"Origin": "http://127.0.0.1:54321"})
    assert response.headers["access-control-allow-origin"] == "*"


# --------------------------------------------------------------------------
# Upstream envelope handling


def test_quota_exhaustion_maps_to_503(monkeypatch):
    """aviationstack reports quota exhaustion with HTTP 200 and an error
    object, so the envelope has to be read before the payload."""
    import json as _json
    import io

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    payload = _json.dumps(
        {"error": {"code": "usage_limit_reached", "message": "monthly limit reached"}}
    ).encode()
    monkeypatch.setattr(flight.urllib.request, "urlopen", lambda *a, **k: FakeResponse(payload))

    with pytest.raises(flight.FlightUnavailable) as exc:
        flight._fetch("BA117", key="k")
    assert exc.value.status == 503
    assert "quota" in str(exc.value)
