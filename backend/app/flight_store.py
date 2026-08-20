"""Disk-backed last-known-good flight data, and the monthly call budget.

WHY THIS EXISTS. The flight cache used to live only in process memory, which
made every `docker compose up -d --build` a silent tax: the cache went with the
old container and the next request paid a fresh upstream call. Three deploys in
one afternoon cost three of a hundred monthly requests, for data the server had
already fetched and thrown away. On a 100-request MONTHLY plan that is not a
rounding error — it is a working day's budget.

So results are written to a file on the server volume, and two things follow
from that which are worth stating plainly, because they are the whole point:

  **A stored result is used INSTEAD OF calling upstream, not as a fallback
  after one fails.** Inside the freshness window nothing touches the network.

  **A stored result is never discarded for being old.** Past the window we try
  to refresh, but if the refresh fails — or the monthly budget is spent — the
  stored copy is served with its real age attached. The alternative is an error
  screen for a traveller who had perfectly good gate information a moment ago.

THE BUDGET is the other half. A bug, a retry loop, or an enthusiastic tester
can spend a month's quota in minutes, and the failure mode is invisible until
every lookup starts answering 503. `reserve()` is the single choke point that
every upstream call must pass through, it persists across restarts, and it
rolls over on the calendar month. Set it below the plan's real ceiling so
there is always something left for the day of travel.

AGE, NOT FRESHNESS, is what goes on the wire. `fetched_at` records when the
proxy actually spoke to the upstream, so the glasses can print an honest
"Updated 14:02" for a payload retrieved at 14:02 and served from disk at 18:30.
Letting the client stamp its own receive time would turn every cache hit into a
quiet lie about how current the gate number is.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# How long a stored result is served without even considering a refresh.
# Matches the glasses app's expectations: a user tapping repeatedly while
# watching for a gate costs one upstream call per flight per window.
DEFAULT_FRESH_SECONDS = 300

# Upstream calls allowed per calendar month, PER PROVIDER. Two providers with
# very different ceilings — AirLabs is generous, aviationstack's free tier is
# 100 — so one shared counter would either waste AirLabs headroom or blow
# through aviationstack's. Each is deliberately under its provider's real
# ceiling so a runaway loop hits ours, which we can see and reset, rather than
# theirs, which gives no warning and takes a month to clear.
DEFAULT_MONTHLY_BUDGET = 90
DEFAULT_BUDGETS: dict[str, int] = {"airlabs": 1000, "aviationstack": 90}


def _now() -> float:
    """Wall clock, not monotonic: these timestamps outlive the process."""
    return datetime.now(timezone.utc).timestamp()


def _month_key(at: float | None = None) -> str:
    return datetime.fromtimestamp(at if at is not None else _now(), timezone.utc).strftime("%Y-%m")


def iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="seconds")


class Entry:
    """One stored lookup: the trimmed payload and when it was really fetched."""

    __slots__ = ("payload", "fetched_at")

    def __init__(self, payload: dict, fetched_at: float) -> None:
        self.payload = payload
        self.fetched_at = fetched_at

    def age_seconds(self, at: float | None = None) -> float:
        return max(0.0, (at if at is not None else _now()) - self.fetched_at)

    def is_fresh(self, fresh_seconds: float, at: float | None = None) -> bool:
        return self.age_seconds(at) < fresh_seconds

    def to_json(self) -> dict:
        return {"payload": self.payload, "fetched_at": self.fetched_at}

    @classmethod
    def from_json(cls, raw: Any) -> "Entry | None":
        if not isinstance(raw, dict):
            return None
        payload = raw.get("payload")
        fetched_at = raw.get("fetched_at")
        if not isinstance(payload, dict) or not isinstance(fetched_at, (int, float)):
            return None
        return cls(payload, float(fetched_at))


class FlightStore:
    """Flight results and the month's call count, persisted to one JSON file.

    Thread-safe: FastAPI runs these endpoints in a threadpool, so two requests
    for different flights genuinely run at once. One lock covers both the
    entries and the counter — they are written together and the file is one
    document.

    Never raises on I/O. A store that cannot write is a store that costs extra
    upstream calls; it is not a reason to fail a lookup, so failures degrade to
    memory-only and say so loudly at boot.
    """

    def __init__(
        self,
        path: str | None = None,
        *,
        fresh_seconds: float = DEFAULT_FRESH_SECONDS,
        budgets: dict[str, int] | None = None,
    ) -> None:
        self._path = path
        self._fresh_seconds = fresh_seconds
        self._budgets = dict(budgets if budgets is not None else DEFAULT_BUDGETS)
        self._lock = threading.RLock()
        self._entries: dict[str, Entry] = {}
        self._month = _month_key()
        self._calls: dict[str, int] = {name: 0 for name in self._budgets}
        self._load()
        self._check_persistence()

    # -- persistence -------------------------------------------------------

    def _load(self) -> None:
        if not self._path or not os.path.exists(self._path):
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError(f"expected a JSON object, got {type(loaded).__name__}")

            entries = loaded.get("entries")
            if isinstance(entries, dict):
                for key, raw in entries.items():
                    entry = Entry.from_json(raw)
                    # Skip unreadable rows rather than rejecting the whole file:
                    # one bad entry must not cost every other flight its cache.
                    if entry is not None:
                        self._entries[str(key).upper()] = entry

            usage = loaded.get("usage")
            if isinstance(usage, dict):
                month = usage.get("month")
                if isinstance(month, str):
                    self._month = month
                calls = usage.get("calls")
                if isinstance(calls, dict):
                    for name, count in calls.items():
                        if isinstance(count, int):
                            self._calls[str(name)] = max(0, count)
                elif isinstance(calls, int):
                    # Pre-multi-provider file: one flat counter, which was
                    # aviationstack's. Migrated rather than discarded — losing
                    # it would silently hand back a month's already-spent quota.
                    self._calls["aviationstack"] = max(0, calls)

            self._roll_month_locked()
            logger.info(
                "flight store: loaded %d entries from %s; %s used in %s",
                len(self._entries), self._path, self._usage_summary(), self._month,
            )
        except ValueError as exc:
            quarantine = self._path + ".corrupt"
            logger.warning(
                "flight store: corrupt %s (%s) — quarantining to %s",
                self._path, exc, quarantine,
            )
            try:
                os.replace(self._path, quarantine)
            except OSError as exc2:
                logger.warning("flight store: could not quarantine: %s", exc2)
        except OSError as exc:
            logger.warning("flight store: could not load %s: %s", self._path, exc)

    def _check_persistence(self) -> None:
        """Probe the path once and REMEMBER the verdict.

        The verdict is stored rather than only logged because this runs at
        import time — before `main.py` reaches `logging.basicConfig`, so the
        record goes to an unconfigured root logger and is dropped. The first
        deploy of this store proved it: `/data` was writable, the store was
        working, and the boot line was nowhere in the logs. A safety
        announcement nobody can see is not a safety announcement, so
        `log_status()` replays it once logging is actually configured.
        """
        if not self._path:
            self._status_level = logging.INFO
            self._status = (
                "flight store: memory-only (FLIGHT_STORE_PATH unset) — "
                "cached results will NOT survive a restart"
            )
        else:
            try:
                probe = self._path + ".probe"
                with open(probe, "w", encoding="utf-8"):
                    pass
                os.remove(probe)
                self._status_level = logging.INFO
                self._status = f"flight store persistence ACTIVE: {self._path}"
            except OSError as exc:
                self._status_level = logging.WARNING
                self._status = (
                    f"flight store persistence DEGRADED (memory-only): "
                    f"cannot write {self._path}: {exc} — "
                    "every restart will cost fresh upstream calls"
                )
        logger.log(self._status_level, "%s", self._status)

    def log_status(self) -> str:
        """Replay the persistence verdict and the month's usage. Call this from
        application startup, once logging is configured. Returns the line so a
        test can assert on it without capturing logs."""
        usage = self.usage()
        line = (
            f"{self._status} | {self._usage_summary()} calls used in "
            f"{usage['month']}, {len(usage['stored_flights'])} flights stored"
        )
        logger.log(self._status_level, "%s", line)
        return line

    def _usage_summary(self) -> str:
        return ", ".join(
            f"{name} {self._calls.get(name, 0)}/{budget}"
            for name, budget in sorted(self._budgets.items())
        )

    def _dump_locked(self) -> None:
        if not self._path:
            return
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "entries": {k: v.to_json() for k, v in self._entries.items()},
                        "usage": {"month": self._month, "calls": self._calls},
                    },
                    f,
                    indent=2,
                    sort_keys=True,
                )
            # Atomic: a torn write here would quarantine itself on next boot
            # and cost a full re-fetch of every flight.
            os.replace(tmp, self._path)
        except OSError as exc:
            logger.warning("flight store: could not write %s: %s", self._path, exc)

    # -- budget ------------------------------------------------------------

    def _roll_month_locked(self) -> None:
        current = _month_key()
        if current != self._month:
            logger.info(
                "flight store: new month %s (was %s, %s) — budgets reset",
                current, self._month, self._usage_summary(),
            )
            self._month = current
            self._calls = {name: 0 for name in self._budgets}

    def reserve(self, provider: str) -> bool:
        """Claim one upstream call from `provider`'s budget. False means spent.

        Counted BEFORE the request goes out, not after it succeeds: a call that
        times out still consumed the provider's quota, and a counter that only
        incremented on success would drift under exactly the conditions that
        make drift dangerous.
        """
        with self._lock:
            self._roll_month_locked()
            budget = self._budgets.get(provider, 0)
            used = self._calls.get(provider, 0)
            if used >= budget:
                logger.warning(
                    "flight store: %s budget spent (%d/%d in %s) — "
                    "no more calls to it this month",
                    provider, used, budget, self._month,
                )
                return False
            self._calls[provider] = used + 1
            self._dump_locked()
            logger.info(
                "flight store: %s call %d/%d this month (%s)",
                provider, used + 1, budget, self._month,
            )
            return True

    def usage(self) -> dict:
        with self._lock:
            self._roll_month_locked()
            providers = {
                name: {
                    "used": self._calls.get(name, 0),
                    "budget": budget,
                    "remaining": max(0, budget - self._calls.get(name, 0)),
                }
                for name, budget in sorted(self._budgets.items())
            }
            return {
                "month": self._month,
                "providers": providers,
                "stored_flights": sorted(self._entries),
                "persistent": bool(self._path),
            }

    # -- entries -----------------------------------------------------------

    def get(self, number: str) -> Entry | None:
        with self._lock:
            return self._entries.get(number.upper())

    def put(self, number: str, payload: dict, fetched_at: float | None = None) -> Entry:
        entry = Entry(payload, fetched_at if fetched_at is not None else _now())
        with self._lock:
            self._entries[number.upper()] = entry
            self._dump_locked()
        return entry

    def is_fresh(self, entry: Entry, at: float | None = None) -> bool:
        return entry.is_fresh(self._fresh_seconds, at)

    @property
    def fresh_seconds(self) -> float:
        return self._fresh_seconds

    def spend_all(self, provider: str) -> None:
        """Tests only: mark `provider`'s budget as exhausted."""
        with self._lock:
            self._calls[provider] = self._budgets.get(provider, 0)

    def clear(self) -> None:
        """Tests only."""
        with self._lock:
            self._entries.clear()
            self._calls = {name: 0 for name in self._budgets}
            self._month = _month_key()
            self._dump_locked()


def build_store() -> FlightStore:
    def _int(name: str, default: int) -> int:
        try:
            return int(os.environ[name])
        except (KeyError, ValueError):
            return default

    return FlightStore(
        os.environ.get("FLIGHT_STORE_PATH") or None,
        fresh_seconds=_int("FLIGHT_FRESH_SECONDS", DEFAULT_FRESH_SECONDS),
        budgets={
            "airlabs": _int("AIRLABS_MONTHLY_BUDGET", DEFAULT_BUDGETS["airlabs"]),
            "aviationstack": _int(
                "AVIATIONSTACK_MONTHLY_BUDGET", DEFAULT_BUDGETS["aviationstack"]
            ),
        },
    )
