"""Anonymous warning-fire counters — the second disclosed piece of retention.

Every warning specimen we hold is a HEALTHY car (WARNINGS-FIELDS.md's global
confidence ceiling): we have never observed one of these flags actually firing,
so the flag → dashboard-lamp correspondence is inferred, not proven. This
records the one fact that would settle it — *do these flags ever fire in the
wild* — while recording nothing about whose car fired them.

Exactly the shape_capture.py bargain, one step smaller:

    key   "Brand:Region:warning_key"  ->  count

No account link, no credential hash, no values, no timestamps, no vehicle
identifiers. Two testers whose cars report low washer fluid are one row that
says 2. There is deliberately no way back from a row to a person, a car, or a
moment in time — the count is the entire record.

Persisted next to the shapes file on the same droplet volume (a sibling of
SHAPE_CAPTURE_PATH, so ops has one thing to reason about); unset path = memory
only. Exposed via the token-gated GET /debug/shapes alongside the shapes.

Disclosed in PRIVACY.md. record() never raises — counting must never be the
reason /status fails.
"""

import json
import logging
import os
import threading

logger = logging.getLogger(__name__)


def default_path() -> str | None:
    """Sibling of the shapes file on the same volume.

    Derived rather than configured on purpose: the counters must land on the
    volume that already survives redeploys, and an extra env var is one more
    thing to forget on a deploy and then silently lose data to. An explicit
    WARNING_COUNTS_PATH still wins if one is ever set.
    """
    explicit = os.environ.get("WARNING_COUNTS_PATH")
    if explicit:
        return explicit
    shapes = os.environ.get("SHAPE_CAPTURE_PATH")
    if not shapes:
        return None
    return os.path.join(os.path.dirname(shapes) or ".", "warning-counts.json")


class WarningCountStore:
    def __init__(self, path: str | None = None):
        self._path = path
        self._lock = threading.Lock()
        # key "Brand:Region:warning_key" -> occurrences
        self._counts: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        if not self._path or not os.path.exists(self._path):
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError(f"expected a JSON object, got {type(loaded).__name__}")
            # Ints only: a corrupt entry must not poison the whole file, and
            # anything non-numeric here was never something we wrote.
            self._counts = {
                k: v
                for k, v in loaded.items()
                if isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool)
            }
            logger.info(
                "warning counts: loaded %d keys from %s",
                len(self._counts), self._path,
            )
        except ValueError as exc:
            # Same quarantine discipline as shape capture: set the bytes aside
            # rather than let the next dump overwrite them silently.
            quarantine = self._path + ".corrupt"
            logger.warning(
                "warning counts: corrupt %s (%s) — quarantining to %s",
                self._path, exc, quarantine,
            )
            try:
                os.replace(self._path, quarantine)
            except OSError as exc2:
                logger.warning("warning counts: could not quarantine: %s", exc2)
        except OSError as exc:
            logger.warning("warning counts: could not load %s: %s", self._path, exc)

    def record(self, brand: str, region: str, warning_keys) -> None:
        """Count one occurrence of each key this car is currently reporting.

        Called once per successful status fetch, so a car sitting with a live
        fault counts once per poll. That is intentional and harmless: the
        question this data answers is "has this key EVER fired", and a big
        number means one persistent fault, not many cars.
        """
        try:
            if not warning_keys:
                return
            with self._lock:
                first = False
                for key in warning_keys:
                    full = f"{brand}:{region}:{key}"
                    if full not in self._counts:
                        first = True
                        logger.info("warning counts: FIRST fire of %s", full)
                    self._counts[full] = self._counts.get(full, 0) + 1
                # Dump on every fire: these are rare by construction (a healthy
                # car writes nothing), and losing the first-ever specimen to an
                # unlucky restart would cost months of waiting.
                self._dump_locked()
                if first:
                    logger.info("warning counts: %d keys tracked", len(self._counts))
        except Exception:
            # Never let counting break a status response.
            logger.warning("warning counts: record failed", exc_info=True)

    def _dump_locked(self) -> None:
        if not self._path:
            return
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._counts, f, indent=2, sort_keys=True)
            os.replace(tmp, self._path)
        except OSError as exc:
            logger.warning("warning counts: could not write %s: %s", self._path, exc)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counts)


# Module singleton used by the provider; tests construct their own store.
store = WarningCountStore(default_path())
