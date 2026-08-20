"""AirLabs adapter tests.

The fixture below mirrors a real AirLabs response for EZY2229 (MAN -> PRG),
captured 2026-08-20 — the flight aviationstack returned with `gate: null` and
`delay: null` while AirLabs answered `dep_gate: "A3"` and `dep_delayed: 117`.
That gap is the entire reason this source exists.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import airlabs, flight, flight_store
from app.main import app


def ezy2229(**overrides) -> dict:
    """Verbatim field shape from the live response, values included."""
    response = {
        "flight_iata": "U22229",
        "flight_icao": "EZY2229",
        "airline_name": "easyJet",
        "status": "scheduled",
        "dep_iata": "MAN",
        "dep_name": "Manchester",
        "dep_terminal": "2",
        "dep_gate": "A3",
        "dep_time": "2026-08-20 18:20",
        "dep_time_utc": "2026-08-20 17:20",
        "dep_estimated": None,
        "dep_actual": None,
        "dep_delayed": 117,
        "arr_iata": "PRG",
        "arr_name": "Vaclav Havel",
        "arr_terminal": "1",
        "arr_gate": None,
        "arr_baggage": "13",
        "arr_time": "2026-08-20 21:25",
        "arr_estimated": None,
        "arr_actual": None,
        "arr_delayed": 100,
    }
    response.update(overrides)
    return response


def today_at(hhmm: str, offset_hours: int = 1) -> dict:
    """A response whose departure is today in the airport's own timezone."""
    offset = timezone(timedelta(hours=offset_hours))
    local = datetime.now(offset)
    return ezy2229(
        dep_time=f"{local.date().isoformat()} {hhmm}",
        dep_time_utc=f"{(local - timedelta(hours=offset_hours)).date().isoformat()} {hhmm}",
    )


# --------------------------------------------------------------------------
# Query routing


def test_icao_numbers_go_to_the_icao_parameter():
    """AirLabs answered "not found" for flight_iata=EZY2229 — it wanted
    flight_icao. Sending the wrong one silently spends a request to learn
    nothing."""
    assert airlabs.query_field("EZY2229") == "flight_icao"
    assert airlabs.query_field("BAW117") == "flight_icao"
    assert airlabs.query_field("U22229") == "flight_iata"
    assert airlabs.query_field("BA117") == "flight_iata"
    assert airlabs.query_field("9W123") == "flight_iata"


# --------------------------------------------------------------------------
# Shaping


def test_gate_survives_into_the_payload():
    """The one field this whole source exists for."""
    assert airlabs.shape(ezy2229())["departure"]["gate"] == "A3"


def test_delay_survives_into_the_payload():
    payload = airlabs.shape(ezy2229())
    assert payload["departure"]["delay"] == 117
    assert payload["arrival"]["delay"] == 100


def test_times_become_iso_without_an_offset():
    """AirLabs sends "2026-08-20 18:20" — a space, no offset, and already the
    airport's local wall clock. It must stay offset-free: attaching one invites
    something downstream to convert it into the phone's timezone, and the
    glasses are supposed to print what the departure board prints."""
    payload = airlabs.shape(ezy2229())
    assert payload["departure"]["scheduled"] == "2026-08-20T18:20:00"
    assert payload["arrival"]["scheduled"] == "2026-08-20T21:25:00"
    assert "+" not in payload["departure"]["scheduled"]
    assert not payload["departure"]["scheduled"].endswith("Z")


def test_flight_date_is_derived_from_the_local_departure_time():
    assert airlabs.shape(ezy2229())["flight_date"] == "2026-08-20"


def test_maps_the_rest_of_the_wire_shape():
    payload = airlabs.shape(ezy2229())
    assert payload["flight_iata"] == "U22229"
    assert payload["airline"] == "easyJet"
    assert payload["status"] == "scheduled"
    assert payload["departure"]["iata"] == "MAN"
    assert payload["departure"]["terminal"] == "2"
    assert payload["arrival"]["baggage"] == "13"
    # Departure side never carries a belt, whatever upstream says.
    assert payload["departure"]["baggage"] is None


def test_missing_times_do_not_explode():
    payload = airlabs.shape(ezy2229(dep_time=None, arr_time=None, dep_time_utc=None))
    assert payload["departure"]["scheduled"] is None
    assert payload["flight_date"] is None


def test_a_junk_delay_becomes_null_rather_than_a_crash():
    assert airlabs.shape(ezy2229(dep_delayed="soon"))["departure"]["delay"] is None
    assert airlabs.shape(ezy2229(dep_delayed=None))["departure"]["delay"] is None


def test_zero_delay_is_preserved_not_swallowed():
    # 0 means "on time" and null means "unknown"; the display renders them
    # differently, so falsiness must not collapse them.
    assert airlabs.shape(ezy2229(dep_delayed=0))["departure"]["delay"] == 0


# --------------------------------------------------------------------------
# Staleness, in the departure airport's timezone


def test_todays_departure_is_not_stale():
    assert airlabs.shape(today_at("18:20"))["stale"] is False


def test_a_past_departure_is_stale():
    """An old record must be flagged, not presented as current — an unlabelled
    landed flight sends someone to a gate that closed hours ago. Dated
    explicitly rather than relying on the fixture's date, which is 'today' for
    exactly one day."""
    old = ezy2229(dep_time="2020-01-01 18:20", dep_time_utc="2020-01-01 17:20")
    assert airlabs.shape(old)["stale"] is True


def test_date_is_judged_in_the_departure_timezone_not_utc():
    """A late departure from Auckland is today locally while UTC has not got
    there yet. Judging in UTC would call it stale."""
    assert airlabs.is_today(today_at("23:30", offset_hours=13)) is True


def test_unknown_offset_is_not_treated_as_stale():
    # Absent evidence is not evidence of staleness; marking a good record stale
    # is worse than missing a stale one.
    assert airlabs.is_today(ezy2229(dep_time_utc=None)) is True


# --------------------------------------------------------------------------
# Envelope handling


def test_not_found_is_distinct_from_an_outage(monkeypatch):
    """A coverage gap must fall through to the other source; an outage is a
    different thing and the caller reports it differently."""
    import io
    import json as _json

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    body = _json.dumps(
        {"error": {"message": "Flight not found", "code": "not_found"}}
    ).encode()
    monkeypatch.setattr(
        airlabs.urllib.request, "urlopen", lambda *a, **k: FakeResponse(body)
    )
    with pytest.raises(airlabs.NotFound):
        airlabs.fetch("ZZ999", key="k")


def test_an_empty_response_object_is_not_found(monkeypatch):
    import io
    import json as _json

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        airlabs.urllib.request,
        "urlopen",
        lambda *a, **k: FakeResponse(_json.dumps({"response": {}}).encode()),
    )
    with pytest.raises(airlabs.NotFound):
        airlabs.fetch("ZZ999", key="k")


# --------------------------------------------------------------------------
# The lookup chain


@pytest.fixture
def both_sources(tmp_path, monkeypatch):
    monkeypatch.setenv("AIRLABS_KEY", "airlabs-key")
    monkeypatch.setenv("AVIATIONSTACK_KEY", "aviationstack-key")
    previous = flight.store
    flight.store = flight_store.FlightStore(str(tmp_path / "flights.json"))
    yield TestClient(app)
    flight.store = previous


def test_airlabs_is_preferred_and_aviationstack_is_not_called(both_sources, monkeypatch):
    monkeypatch.setattr(airlabs, "fetch", lambda number, *, key: ezy2229())

    def must_not_run(number, *, key):  # pragma: no cover
        raise AssertionError("aviationstack called while airlabs was answering")

    monkeypatch.setattr(flight, "_fetch", must_not_run)

    body = both_sources.get("/flight/EZY2229").json()
    assert body["departure"]["gate"] == "A3"
    assert flight.store.usage()["providers"]["airlabs"]["used"] == 1
    assert flight.store.usage()["providers"]["aviationstack"]["used"] == 0


def test_falls_back_to_aviationstack_when_airlabs_has_no_record(both_sources, monkeypatch):
    def missing(number, *, key):
        raise airlabs.NotFound("Flight not found")

    monkeypatch.setattr(airlabs, "fetch", missing)
    monkeypatch.setattr(
        flight, "_fetch", lambda number, *, key: [
            {
                "flight_date": "2026-08-20",
                "flight_status": "scheduled",
                "departure": {"iata": "MAN", "timezone": None, "scheduled": "2026-08-20T18:20:00+00:00"},
                "arrival": {"iata": "PRG"},
                "airline": {"name": "easyJet"},
                "flight": {"iata": "U22229"},
            }
        ],
    )
    body = both_sources.get("/flight/U22229").json()
    assert body["flight_iata"] == "U22229"
    assert flight.store.usage()["providers"]["aviationstack"]["used"] == 1


def test_falls_back_when_airlabs_is_down(both_sources, monkeypatch):
    def down(number, *, key):
        raise airlabs.Unavailable("airlabs unreachable")

    monkeypatch.setattr(airlabs, "fetch", down)
    monkeypatch.setattr(
        flight, "_fetch", lambda number, *, key: [
            {
                "flight_date": "2026-08-20",
                "flight_status": "scheduled",
                "departure": {"iata": "MAN", "timezone": None},
                "arrival": {"iata": "PRG"},
                "flight": {"iata": "U22229"},
            }
        ],
    )
    assert both_sources.get("/flight/U22229").status_code == 200


def test_both_sources_down_is_a_502_not_a_404(both_sources, monkeypatch):
    monkeypatch.setattr(
        airlabs, "fetch", lambda number, *, key: (_ for _ in ()).throw(airlabs.Unavailable("x"))
    )
    monkeypatch.setattr(
        flight,
        "_fetch",
        lambda number, *, key: (_ for _ in ()).throw(flight.FlightUnavailable("down")),
    )
    # Telling a user their flight number is wrong when both providers are down
    # sends them to re-check a boarding pass that was right all along.
    assert both_sources.get("/flight/U22229").status_code == 502


def test_airlabs_budget_exhaustion_falls_through_to_aviationstack(both_sources, monkeypatch):
    flight.store.spend_all("airlabs")

    def must_not_run(number, *, key):  # pragma: no cover
        raise AssertionError("airlabs called with no budget left")

    monkeypatch.setattr(airlabs, "fetch", must_not_run)
    monkeypatch.setattr(
        flight, "_fetch", lambda number, *, key: [
            {
                "flight_date": "2026-08-20",
                "flight_status": "scheduled",
                "departure": {"iata": "MAN", "timezone": None},
                "arrival": {"iata": "PRG"},
                "flight": {"iata": "U22229"},
            }
        ],
    )
    assert both_sources.get("/flight/U22229").status_code == 200


def test_a_stored_result_beats_both_sources(both_sources, monkeypatch):
    monkeypatch.setattr(airlabs, "fetch", lambda number, *, key: ezy2229())
    both_sources.get("/flight/EZY2229")

    def must_not_run(number, *, key):  # pragma: no cover
        raise AssertionError("upstream called while a fresh result was stored")

    monkeypatch.setattr(airlabs, "fetch", must_not_run)
    assert both_sources.get("/flight/EZY2229").status_code == 200
    assert flight.store.usage()["providers"]["airlabs"]["used"] == 1
