"""Field-shape capture — the proxy's one disclosed piece of retention.

On each successful status fetch the provider records which fields the
vehicle exposes and their Python types — names and type names only, NEVER
values — keyed by (brand, region, powertrain). This is how support for
powertrains we have no fixtures for (HEV, PHEV, ICE) gets built on real
data instead of guesses: one tester's car teaches us its shape without
telling us anything about the tester.

Deliberately NOT keyed by account or credential hash: two testers with the
same model of car collapse into one entry, and nothing here links back to a
person. One shape per key, overwritten on change; a JSON dump is written to
SHAPE_CAPTURE_PATH (a droplet-volume file) whenever a shape appears or
changes, so shapes survive restarts. Unset path = in-memory only.

Disclosed in PRIVACY.md. record() never raises — shape capture must never
be the reason /status fails.
"""

import dataclasses
import json
import logging
import os
import threading

logger = logging.getLogger(__name__)


class ShapeStore:
    def __init__(self, path: str | None = None):
        self._path = path
        self._lock = threading.Lock()
        # key "Brand:Region:POWERTRAIN" -> {field_name: type_name}
        self._shapes: dict[str, dict[str, str]] = {}
        self._load()
        self._check_persistence()

    def _load(self) -> None:
        if not self._path or not os.path.exists(self._path):
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                loaded = json.load(f)
            if not isinstance(loaded, dict):
                raise ValueError(f"expected a JSON object, got {type(loaded).__name__}")
            self._shapes = loaded
            logger.info(
                "shape capture: loaded %d shapes from %s", len(self._shapes), self._path
            )
        except ValueError as exc:
            # Corrupt file: set it aside rather than leaving it in place for
            # the next dump to silently overwrite — the bytes may still be
            # recoverable, and the rename makes the incident visible.
            quarantine = self._path + ".corrupt"
            logger.warning(
                "shape capture: corrupt %s (%s) — quarantining to %s",
                self._path, exc, quarantine,
            )
            try:
                os.replace(self._path, quarantine)
            except OSError as exc2:
                logger.warning("shape capture: could not quarantine: %s", exc2)
        except OSError as exc:
            logger.warning("shape capture: could not load %s: %s", self._path, exc)

    def _check_persistence(self) -> None:
        """One unmissable boot line: is capture persistence actually working?
        Prod wrote nothing 16–19 Jul (root-owned volume, every dump EACCES)
        while in-memory capture kept the logs looking healthy. Never raises —
        a failed probe must not stop startup, only announce degradation."""
        if not self._path:
            logger.info("shape capture: memory-only (SHAPE_CAPTURE_PATH unset)")
            return
        try:
            probe = self._path + ".probe"
            with open(probe, "w", encoding="utf-8"):
                pass
            os.remove(probe)
            logger.info("shape capture persistence ACTIVE: %s", self._path)
        except OSError as exc:
            logger.warning(
                "shape capture persistence DEGRADED (memory-only): cannot write %s: %s",
                self._path, exc,
            )

    def record(self, brand: str, region: str, powertrain: str, vehicle) -> None:
        """Record the field shape of a lib Vehicle (or any attribute bag).

        Types only: a value is looked at exactly long enough to call type()
        on it. The raw payload field ("data") is excluded — its type is
        always dict and listing it would only invite someone to widen this.
        """
        try:
            try:
                names = [f.name for f in dataclasses.fields(vehicle)]
            except TypeError:  # not a dataclass (tests use SimpleNamespace)
                names = list(vars(vehicle))
            shape = {
                name: type(getattr(vehicle, name, None)).__name__
                for name in names
                if name != "data"
            }
            key = f"{brand}:{region}:{powertrain}"
            with self._lock:
                if self._shapes.get(key) == shape:
                    return
                is_new = key not in self._shapes
                self._shapes[key] = shape
                logger.info(
                    "shape capture: %s key %s (%d fields)",
                    "new" if is_new else "changed",
                    key,
                    len(shape),
                )
                self._dump_locked()
        except Exception:
            # Never let capture break a status response.
            logger.warning("shape capture: record failed", exc_info=True)

    def _dump_locked(self) -> None:
        if not self._path:
            return
        try:
            tmp = self._path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._shapes, f, indent=2, sort_keys=True)
            os.replace(tmp, self._path)
        except OSError as exc:
            logger.warning("shape capture: could not write %s: %s", self._path, exc)

    def snapshot(self) -> dict[str, dict[str, str]]:
        with self._lock:
            return {k: dict(v) for k, v in self._shapes.items()}


# Module singleton used by the provider; tests construct their own ShapeStore.
store = ShapeStore(os.environ.get("SHAPE_CAPTURE_PATH") or None)
