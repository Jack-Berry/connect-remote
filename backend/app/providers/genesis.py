"""Genesis Connected Services provider via hyundai_kia_connect_api.

Genesis EU: region=1 (EU), brand=3 (Genesis). Direct username/password login
works from lib v4.8.1. This is the most fragile part of the stack — if login
breaks after a lib update, check the repo's Genesis EU issues first.
"""

import dataclasses
import logging
import threading
import time

from hyundai_kia_connect_api import ClimateRequestOptions, VehicleManager
from pydantic import ValidationError

from .base import ClimateSettings, ProviderDataError, UpstreamError, VehicleStatus

logger = logging.getLogger(__name__)

REGION_EU = 1
BRAND_GENESIS = 3


class GenesisProvider:
    """Implements both StatusProvider and CommandProvider.

    VehicleManager is not thread-safe and FastAPI runs sync endpoints in a
    threadpool, so every upstream call holds a lock.
    """

    def __init__(
        self,
        username: str,
        password: str,
        pin: str,
        region: int = REGION_EU,
        brand: int = BRAND_GENESIS,
    ):
        self._lock = threading.Lock()
        self._vm = VehicleManager(
            region=region,
            brand=brand,
            username=username,
            password=password,
            pin=pin,
        )
        self._vehicle_id: str | None = None

    def _prepare(self) -> str:
        """Refresh auth token (they expire — do this before every operation)
        and return the vehicle id.

        Fresh logins from a just-booted host fail transiently (the EU
        endpoints rate-limit/bot-check new sessions), so retry with backoff
        before giving up. Total worst case ~10s of sleep — well inside the
        glasses app's 65s request timeout."""
        last_exc: Exception | None = None
        for delay in (0, 3, 7):
            if delay:
                time.sleep(delay)
            try:
                return self._prepare_once()
            except UpstreamError:
                raise  # e.g. no vehicles on the account — retrying won't help
            except Exception as exc:
                last_exc = exc
                logger.warning("Genesis login/refresh failed, retrying: %s", exc)
        raise UpstreamError(f"Genesis login failed after 3 attempts: {last_exc}")

    def _prepare_once(self) -> str:
        t0 = time.monotonic()
        self._vm.check_and_refresh_token()
        logger.info("timing: token check/login %.1fs", time.monotonic() - t0)
        if self._vehicle_id is None:
            t1 = time.monotonic()
            self._vm.update_all_vehicles_with_cached_state()
            logger.info("timing: vehicle discovery %.1fs", time.monotonic() - t1)
            ids = list(self._vm.vehicles)
            if not ids:
                raise UpstreamError("no vehicles on this Genesis account")
            if len(ids) > 1:
                logger.warning("multiple vehicles found, using first: %s", ids)
            self._vehicle_id = ids[0]
        return self._vehicle_id

    def _to_status(self) -> VehicleStatus:
        v = self._vm.vehicles[self._vehicle_id]
        doors = [
            name
            for name, attr in (
                ("front_left", "front_left_door_is_open"),
                ("front_right", "front_right_door_is_open"),
                ("back_left", "back_left_door_is_open"),
                ("back_right", "back_right_door_is_open"),
                ("boot", "trunk_is_open"),
                ("bonnet", "hood_is_open"),
            )
            if getattr(v, attr, None)
        ]
        eta = getattr(v, "ev_estimated_current_charge_duration", None)
        try:
            return VehicleStatus(
                soc_percent=getattr(v, "ev_battery_percentage", None),
                range_value=getattr(v, "ev_driving_range", None),
                range_unit=getattr(v, "ev_driving_range_unit", None) or "km",
                locked=getattr(v, "is_locked", None),
                charging=getattr(v, "ev_battery_is_charging", None),
                charge_eta_minutes=eta if eta else None,
                climate_on=getattr(v, "air_control_is_on", None),
                doors_open=doors,
                charge_limit_ac=getattr(v, "ev_charge_limits_ac", None),
                charge_limit_dc=getattr(v, "ev_charge_limits_dc", None),
                latitude=getattr(v, "location_latitude", None),
                longitude=getattr(v, "location_longitude", None),
                last_updated=getattr(v, "last_updated_at", None),
            )
        except ValidationError as exc:
            raise ProviderDataError(
                f"Genesis returned data the backend can't parse: {exc}"
            ) from exc

    def get_cached_status(self) -> VehicleStatus:
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vehicle_id = self._prepare()
                t1 = time.monotonic()
                self._vm.update_vehicle_with_cached_state(vehicle_id)
                logger.info(
                    "timing status: lock wait %.1fs, login/prepare %.1fs, cached fetch %.1fs",
                    lock_wait, t1 - t0, time.monotonic() - t1,
                )
                return self._to_status()
            except (UpstreamError, ProviderDataError):
                raise
            except Exception as exc:  # lib raises assorted request/auth errors
                raise UpstreamError(str(exc)) from exc

    def force_refresh(self) -> VehicleStatus:
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vehicle_id = self._prepare()
                t1 = time.monotonic()
                self._vm.force_refresh_vehicle_state(vehicle_id)
                self._vm.update_vehicle_with_cached_state(vehicle_id)
                logger.info(
                    "timing refresh: lock wait %.1fs, login/prepare %.1fs, car refresh %.1fs",
                    lock_wait, t1 - t0, time.monotonic() - t1,
                )
                return self._to_status()
            except (UpstreamError, ProviderDataError):
                raise
            except Exception as exc:
                raise UpstreamError(str(exc)) from exc

    def get_raw_fields(self) -> dict:
        """Everything the lib knows about the car: dataclass fields, derived
        properties, and the untouched upstream payload. Deliberately does not
        build a VehicleStatus — this is the tool for diagnosing a car whose
        data VehicleStatus can't parse."""
        with self._lock:
            try:
                vehicle_id = self._prepare()
                self._vm.update_vehicle_with_cached_state(vehicle_id)
                v = self._vm.vehicles[vehicle_id]
            except UpstreamError:
                raise
            except Exception as exc:
                raise UpstreamError(str(exc)) from exc

        fields = {
            f.name: getattr(v, f.name, None)
            for f in dataclasses.fields(v)
            if f.name != "data"  # the raw payload, returned separately below
        }
        properties = {}
        for name in dir(type(v)):
            if not isinstance(getattr(type(v), name, None), property):
                continue
            try:
                properties[name] = getattr(v, name)
            except Exception as exc:  # a broken property is itself a finding
                properties[name] = f"<error: {exc}>"
        return {"fields": fields, "properties": properties, "raw": v.data}

    def lock(self) -> None:
        self._command("lock", lambda vid: self._vm.lock(vid))

    def unlock(self) -> None:
        self._command("unlock", lambda vid: self._vm.unlock(vid))

    def start_charge(self) -> None:
        self._command("start_charge", lambda vid: self._vm.start_charge(vid))

    def stop_charge(self) -> None:
        self._command("stop_charge", lambda vid: self._vm.stop_charge(vid))

    def set_charge_limits(self, ac: int, dc: int) -> None:
        self._command("charge_limits", lambda vid: self._vm.set_charge_limits(vid, ac, dc))

    def set_climate(self, req: ClimateSettings) -> None:
        def run(vid: str) -> None:
            if req.on:
                self._vm.start_climate(
                    vid,
                    ClimateRequestOptions(
                        set_temp=req.temp,
                        climate=True,
                        defrost=req.defrost,
                        # 1 = steering wheel + rear window/mirror heat
                        heating=1 if req.heating else 0,
                        duration=req.duration_minutes,
                    ),
                )
            else:
                self._vm.stop_climate(vid)

        self._command("climate", run)

    def _command(self, name: str, fn) -> None:
        # Timing split answers "why was the first command slow": lock wait is
        # time blocked behind the warm-up thread's login, login/prepare is our
        # own Genesis auth, and the command call is Genesis relaying to the car
        # over the mobile network — only the last one is physics, not fixable.
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vid = self._prepare()
                t1 = time.monotonic()
                fn(vid)
                logger.info(
                    "timing command %s: lock wait %.1fs, login/prepare %.1fs, command call %.1fs",
                    name, lock_wait, t1 - t0, time.monotonic() - t1,
                )
            except UpstreamError:
                raise
            except Exception as exc:
                raise UpstreamError(str(exc)) from exc
