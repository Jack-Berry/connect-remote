"""Genesis / Kia / Hyundai Connected Services provider via
hyundai_kia_connect_api.

Region/brand codes follow the lib's const module (brand: 1=Kia 2=Hyundai
3=Genesis; region: 1=EU 2=CA 3=US 5=AU …). Direct username/password login
works from lib v4.8.1. This is the most fragile part of the stack — if login
breaks after a lib update, check the lib repo's issues for your brand/region
first.
"""

import dataclasses
import logging
import re
import threading
import time
from collections.abc import Sequence

from hyundai_kia_connect_api import ClimateRequestOptions, VehicleManager
from hyundai_kia_connect_api.const import BRANDS, OTP_NOTIFY_TYPE, REGIONS
from hyundai_kia_connect_api.exceptions import (
    AuthenticationError,
    AuthenticationOTPRequired,
    PINMissingError,
)
from hyundai_kia_connect_api.Token import Token
from pydantic import ValidationError

from .. import shape_capture, warning_counts, warnings as car_warnings
from ..climate_units import wire_temp, wire_unit
from .base import (
    AuthError,
    ClimateSettings,
    ProviderDataError,
    ReenrollRequired,
    UnknownVehicleError,
    UpstreamError,
    VehicleStatus,
)

logger = logging.getLogger(__name__)


def _has_genuine_fuel(v) -> bool:
    """True only on real fuel evidence. Every pure-EV payload in every region
    carries a vestigial ``fuelLevel: 0`` (present, not absent — see
    docs-internal/POWERTRAIN-FIELDS.md), so only a non-zero level or the
    low-fuel light counts. Cost: a fuel car on a truly empty tank shows no
    fuel evidence — detection therefore leads with engine_type, and this is
    only the cross-check / last resort."""
    fuel_level = getattr(v, "fuel_level", None)
    if isinstance(fuel_level, (int, float)) and fuel_level > 0:
        return True
    return getattr(v, "fuel_level_is_low", None) is True


def _detect_powertrain(v) -> str:
    """Classify a lib Vehicle as EV / PHEV / HEV / ICE / UNKNOWN.

    Rules derived from the lib's own fixtures and parser source (evidence in
    docs-internal/POWERTRAIN-FIELDS.md): lead with the lib's engine_type
    (authoritative from the EU vehicle list; inferred from evStatus presence
    on Kia-US), cross-check it against field evidence, and return UNKNOWN on
    conflict — never guess. Absent, null and zero-valued fields are three
    different things here: ev_battery_percentage None means "no EV battery
    reported", while fuel_level 0 means nothing at all (EVs report it too).

    Known limitation: a Kia-US HEV arrives from the lib classified as ICE
    (no evStatus block -> ICE in the lib's inference). The app degrades
    HEV and ICE identically, so the mislabel is cosmetic until a real
    tester's /debug/fields dump settles what Kia-US HEVs actually report.
    """
    raw = getattr(v, "engine_type", None)
    # ENGINE_TYPES enum, plain string, or None depending on region/lib path.
    lib_type = getattr(raw, "value", raw)
    has_ev_battery = getattr(v, "ev_battery_percentage", None) is not None
    has_fuel = _has_genuine_fuel(v)

    if lib_type == "EV":
        return "EV" if has_ev_battery and not has_fuel else "UNKNOWN"
    if lib_type == "PHEV":
        return "PHEV" if has_ev_battery else "UNKNOWN"
    if lib_type == "HEV":
        # Only ever set from an authoritative vehicle-list type ('HV'), and
        # no HEV fixture exists to cross-check against — trust it.
        return "HEV"
    if lib_type == "ICE":
        return "ICE" if not has_ev_battery else "UNKNOWN"
    # engine_type missing entirely: infer only the one unambiguous case.
    # Fuel-only evidence can't separate HEV from ICE, and ev-battery + fuel
    # can't be confirmed as PHEV — both stay UNKNOWN.
    # (This was documented as "AU/CN never set it"; the 2026-08-03 production
    # dump shows Kia:Australia:EV *does* carry an ENGINE_TYPES enum, so this
    # branch is now a defensive fallback rather than the AU path.)
    if has_ev_battery and not has_fuel:
        return "EV"
    return "UNKNOWN"


def _powertrain_evidence(v) -> str:
    """The three inputs _detect_powertrain branches on, rendered for a log
    line: two booleans and an engine-type name, never a field value — the
    same disclosure standard as the shape capture.

    Exists because UNKNOWN is otherwise undiagnosable. In the 2026-08-03
    production dump a Hyundai:USA:UNKNOWN appeared whose populated field set
    was a strict *subset* of Hyundai:USA:EV's, so the shapes could not say
    which conflict produced it (lib EV + genuine fuel, or lib ICE + an EV
    battery). Settling that from shapes is impossible by construction —
    shapes hold no values — and /debug/fields needs the user's credentials.
    These three flags distinguish the branches and identify nobody."""
    raw = getattr(v, "engine_type", None)
    lib_type = getattr(raw, "value", raw)
    has_ev_battery = getattr(v, "ev_battery_percentage", None) is not None
    return (
        f"lib_type={lib_type!r} has_ev_battery={has_ev_battery} "
        f"has_fuel={_has_genuine_fuel(v)}"
    )


class GenesisProvider:
    """Implements both StatusProvider and CommandProvider.

    VehicleManager is not thread-safe and FastAPI runs sync endpoints in a
    threadpool, so every upstream call holds a lock.
    """

    # Login retry backoff — see _prepare.
    RETRY_DELAYS = (0, 3, 7)

    def __init__(
        self,
        username: str,
        password: str,
        pin: str,
        region: int,
        brand: int,
        device_token: dict | None = None,
    ):
        self._lock = threading.Lock()
        # If a stored device token is provided (Kia-US OTP flow), seed the
        # VehicleManager with it so check_and_refresh_token() can reuse the
        # device_id + rmtoken and skip the OTP challenge. Update username/
        # password to current values — the token may have been stored when the
        # credentials were different.
        stored_token: Token | None = None
        if device_token:
            stored_token = Token.from_dict(device_token)
            stored_token.username = username
            stored_token.password = password
            stored_token.pin = pin or stored_token.pin
        self._vm = VehicleManager(
            region=region,
            brand=brand,
            username=username,
            password=password,
            pin=pin,
            token=stored_token,
        )
        # Vehicle discovery runs once per provider life; after that the VM's
        # vehicles dict is the list. One account can hold several cars, so the
        # chosen car is a per-call argument rather than provider state.
        self._vehicles_loaded = False
        # Decides the wire unit for climate targets — US wants Fahrenheit.
        self._region = region
        # Classified on the first status fetch of this provider's life (== one
        # proxy session — the session cache owns provider lifetime), then
        # reused: a mid-session data blip must not flip the classification.
        # Keyed by vehicle id: one account can pair an EV with an ICE, and
        # classifying one must never leak onto the other.
        self._powertrains: dict[str, str] = {}
        # For shape capture keys — names, since ints would rot if the lib
        # renumbered.
        self._brand_name = BRANDS.get(brand, str(brand))
        self._region_name = REGIONS.get(region, str(region))
        # For _scrub: the lib embeds raw upstream response bodies / redirect
        # URLs in AuthenticationError messages (e.g. KiaUvoApiEU signin puts
        # resp.text[:300] in the message), and the upstream may echo the
        # submitted account back. Longest-first so overlapping values can't
        # leave fragments behind.
        self._scrub_values = sorted(
            (v for v in (username, password, pin) if v), key=len, reverse=True
        )

    def _scrub(self, exc: Exception) -> str:
        """Exception text safe for logs and error details: any occurrence of
        the submitted credentials is replaced, case-insensitively."""
        text = str(exc)
        for value in self._scrub_values:
            text = re.sub(re.escape(value), "<credential>", text, flags=re.IGNORECASE)
        return text

    def _prepare(self, requested: str | None = None) -> str:
        """Refresh auth token (they expire — do this before every operation)
        and return the vehicle id to operate on.

        Fresh logins fail transiently on the EU endpoints (they
        rate-limit/bot-check new sessions — a Hyundai/Kia quirk, independent
        of where the proxy is hosted), so retry with backoff before giving
        up. Total worst case ~10s of sleep — well inside the app's request
        timeout.

        AuthenticationError is retried too: the transient rejections are not
        reliably distinguishable from a genuinely wrong password. Only when it
        persists across all attempts do we classify it as AuthError (-> 401 +
        session eviction upstairs). PINMissingError is config, not transient —
        no retry."""
        last_exc: Exception | None = None
        for delay in self.RETRY_DELAYS:
            if delay:
                time.sleep(delay)
            try:
                return self._prepare_once(requested)
            except UpstreamError:
                raise  # e.g. no vehicles on the account — retrying won't help
            except UnknownVehicleError:
                raise  # the id will still not be on the account next attempt
            except PINMissingError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except AuthenticationOTPRequired:
                # Kia-US: device trust missing or expired. Not transient —
                # retrying won't help, and it must NOT be classified as an
                # auth failure (credentials are fine, only device trust is
                # absent). Raise immediately; the proxy maps this to 409.
                raise ReenrollRequired(
                    "This account requires device enrollment (Kia-US OTP). "
                    "Complete enrollment via /kia-us/enroll/start and "
                    "/kia-us/enroll/verify."
                )
            except Exception as exc:
                last_exc = exc
                logger.warning("login/refresh failed, retrying: %s", self._scrub(exc))
        detail = f"login failed after {len(self.RETRY_DELAYS)} attempts: {self._scrub(last_exc)}"
        if isinstance(last_exc, AuthenticationError):
            raise AuthError(detail) from last_exc
        raise UpstreamError(detail)

    def _prepare_once(self, requested: str | None = None) -> str:
        t0 = time.monotonic()
        self._vm.check_and_refresh_token()
        logger.info("timing: token check/login %.1fs", time.monotonic() - t0)
        if not self._vehicles_loaded:
            t1 = time.monotonic()
            self._vm.update_all_vehicles_with_cached_state()
            logger.info("timing: vehicle discovery %.1fs", time.monotonic() - t1)
            self._vehicles_loaded = True
        ids = list(self._vm.vehicles)
        if not ids:
            raise UpstreamError("no vehicles on this Genesis account")
        if requested is None:
            # No selector: the account's first car, exactly as before multi-car
            # support existed. Clients that never send one are unaffected —
            # though on a multi-car account this is upstream list order, which
            # isn't guaranteed stable, so the client is better off picking.
            if len(ids) > 1:
                logger.info("no vehicle selected, using first of %d", len(ids))
            return ids[0]
        if requested not in self._vm.vehicles:
            # Static message: the id isn't secret, but nothing about the
            # account belongs in an error string that may be logged upstairs.
            raise UnknownVehicleError("vehicle not found on this account")
        return requested

    # -- Kia-US OTP enrollment -----------------------------------------
    # These are called only by the /kia-us/enroll/* endpoints.
    # The same GenesisProvider instance (same VehicleManager, same device_id)
    # must handle both start and verify — the session cache guarantees this.

    def _safe_token_dict(self) -> dict:
        """Return the VM's token as a dict safe for phone storage: strip
        username/password/PIN since (a) the phone already stores those in
        settings, (b) a stale embedded password would be confusing, and
        (c) the provider re-injects current credentials on every request
        anyway. Only device_id + refresh_token + access_token + valid_until
        actually matter."""
        d = self._vm.token.to_dict()
        d.pop("username", None)
        d.pop("password", None)
        d.pop("pin", None)
        return d

    def start_enrollment(self, notify_type: str) -> dict:
        """Kick off the OTP flow: login → OTPRequest → send code.

        Returns destinations for the UI (masked email/phone). If the account
        is already trusted on this device (no OTP needed), returns
        ``{"enrolled": True}`` with the token so the phone can store it.
        """
        with self._lock:
            try:
                result = self._vm.login()
            except AuthenticationError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:
                raise UpstreamError(self._scrub(exc)) from exc

            if result is True:
                # Already trusted (has a valid rmtoken) — no OTP needed.
                return {"enrolled": True, "device_token": self._safe_token_dict()}

            # result stored an OTPRequest on self._vm.otp_request
            otp_type = (
                OTP_NOTIFY_TYPE.EMAIL
                if notify_type.upper() == "EMAIL"
                else OTP_NOTIFY_TYPE.SMS
            )
            try:
                self._vm.send_otp(otp_type)
            except Exception as exc:
                raise UpstreamError(
                    f"failed to send OTP: {self._scrub(exc)}"
                ) from exc

            otp_req = self._vm.otp_request
            return {
                "enrolled": False,
                "destinations": {
                    "has_email": getattr(otp_req, "has_email", False),
                    "has_sms": getattr(otp_req, "has_sms", False),
                    "email": getattr(otp_req, "email", None),
                    "sms": getattr(otp_req, "sms", None),
                },
            }

    def verify_enrollment(self, code: str) -> dict:
        """Verify the OTP code and return the device token for phone storage."""
        with self._lock:
            if self._vm.otp_request is None:
                # Session cache expired between /enroll/start and /verify —
                # the VehicleManager no longer holds the in-flight OTPRequest.
                raise ReenrollRequired(
                    "Enrollment session expired. Please restart enrollment "
                    "via /kia-us/enroll/start."
                )
            try:
                self._vm.verify_otp_and_complete_login(code)
            except AuthenticationError as exc:
                raise AuthError(
                    f"OTP verification failed: {self._scrub(exc)}"
                ) from exc
            except Exception as exc:
                raise UpstreamError(
                    f"OTP verification error: {self._scrub(exc)}"
                ) from exc

            return {"device_token": self._safe_token_dict()}

    def _to_status(self, vehicle_id: str) -> VehicleStatus:
        v = self._vm.vehicles[vehicle_id]
        powertrain = self._powertrains.get(vehicle_id)
        if powertrain is None:
            powertrain = _detect_powertrain(v)
            self._powertrains[vehicle_id] = powertrain
            # UNKNOWN means the evidence conflicted and the car is running on
            # degraded output — surface it at WARNING with the branch inputs,
            # so a real one is diagnosable from logs alone.
            emit = logger.warning if powertrain == "UNKNOWN" else logger.info
            emit(
                "powertrain classified: %s (%s/%s) [%s]",
                powertrain,
                self._brand_name,
                self._region_name,
                _powertrain_evidence(v),
            )
        # Names + types only, never values; never raises (see shape_capture).
        shape_capture.store.record(
            self._brand_name, self._region_name, powertrain, v
        )
        # Per-car opt-in, proven from this car's own payload; suppressed
        # wholesale when the car's data is older than warnings.MAX_WARNING_AGE
        # (see app/warnings.py). Never raises.
        active_warnings = car_warnings.evaluate(v)
        # Anonymous count of WHICH warning types fire in the wild — no account
        # link, no values, no timestamps. Every specimen we hold is a healthy
        # car; this is how that changes. Never raises.
        warning_counts.store.record(
            self._brand_name, self._region_name, active_warnings
        )
        # Fuel fields are gated on the classification, not on field presence:
        # every EV reports fuelLevel 0, and Kia-US EVs get fuel_driving_range
        # populated with their EV range via a distanceToEmpty fallback. For
        # UNKNOWN, genuine fuel evidence (non-zero level / low-fuel light) is
        # required — better a missing fuel line than a bogus one.
        fuel_bearing = powertrain in ("PHEV", "HEV", "ICE") or (
            powertrain == "UNKNOWN" and _has_genuine_fuel(v)
        )
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
        # One unit covers all ranges (the account reports a single unit); for
        # fuel-only cars the EV unit is None and the fuel/total units are the
        # only ones set. _fuel_driving_range_unit is private in lib 4.15.0 —
        # there is no public property for it.
        range_unit = (
            getattr(v, "ev_driving_range_unit", None)
            or getattr(v, "_fuel_driving_range_unit", None)
            or getattr(v, "total_driving_range_unit", None)
            or "km"
        )
        try:
            return VehicleStatus(
                powertrain=powertrain,
                soc_percent=getattr(v, "ev_battery_percentage", None),
                range_value=getattr(v, "ev_driving_range", None),
                range_unit=range_unit,
                fuel_level_percent=(
                    getattr(v, "fuel_level", None) if fuel_bearing else None
                ),
                fuel_range=(
                    getattr(v, "fuel_driving_range", None) if fuel_bearing else None
                ),
                total_range=getattr(v, "total_driving_range", None),
                locked=getattr(v, "is_locked", None),
                charging=getattr(v, "ev_battery_is_charging", None),
                charge_eta_minutes=eta if eta else None,
                climate_on=getattr(v, "air_control_is_on", None),
                doors_open=doors,
                charge_limit_ac=getattr(v, "ev_charge_limits_ac", None),
                charge_limit_dc=getattr(v, "ev_charge_limits_dc", None),
                warnings=active_warnings,
                latitude=getattr(v, "location_latitude", None),
                longitude=getattr(v, "location_longitude", None),
                # NAME TRAP: the public property is location_last_updated_at.
                # `_location_last_set_time` is the private attribute behind it,
                # so getattr for that name returns None forever and the
                # "parked 2h ago" line would silently never appear.
                location_last_updated=getattr(v, "location_last_updated_at", None),
                last_updated=getattr(v, "last_updated_at", None),
                # Lets the client label the HUD when the account holds more
                # than one car. Model is the fallback for an unnamed car.
                vehicle_name=(
                    getattr(v, "name", None) or getattr(v, "model", None)
                ),
                vehicle_count=len(self._vm.vehicles),
            )
        except ValidationError as exc:
            raise ProviderDataError(
                f"Genesis returned data the backend can't parse: {exc}"
            ) from exc

    def get_cached_status(self, vehicle_id: str | None = None) -> VehicleStatus:
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vid = self._prepare(vehicle_id)
                t1 = time.monotonic()
                self._vm.update_vehicle_with_cached_state(vid)
                logger.info(
                    "timing status: lock wait %.1fs, login/prepare %.1fs, cached fetch %.1fs",
                    lock_wait, t1 - t0, time.monotonic() - t1,
                )
                return self._to_status(vid)
            except (UpstreamError, ProviderDataError, AuthError, UnknownVehicleError):
                raise
            except AuthenticationError as exc:  # token died mid-session
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:  # lib raises assorted request errors
                raise UpstreamError(self._scrub(exc)) from exc

    def force_refresh(self, vehicle_id: str | None = None) -> VehicleStatus:
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vid = self._prepare(vehicle_id)
                t1 = time.monotonic()
                self._vm.force_refresh_vehicle_state(vid)
                self._vm.update_vehicle_with_cached_state(vid)
                logger.info(
                    "timing refresh: lock wait %.1fs, login/prepare %.1fs, car refresh %.1fs",
                    lock_wait, t1 - t0, time.monotonic() - t1,
                )
                return self._to_status(vid)
            except (UpstreamError, ProviderDataError, AuthError, UnknownVehicleError):
                raise
            except AuthenticationError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:
                raise UpstreamError(self._scrub(exc)) from exc

    def get_raw_fields(self, vehicle_id: str | None = None) -> dict:
        """Everything the lib knows about the car: dataclass fields, derived
        properties, and the untouched upstream payload. Deliberately does not
        build a VehicleStatus — this is the tool for diagnosing a car whose
        data VehicleStatus can't parse."""
        with self._lock:
            try:
                vid = self._prepare(vehicle_id)
                self._vm.update_vehicle_with_cached_state(vid)
                v = self._vm.vehicles[vid]
            except (UpstreamError, AuthError, UnknownVehicleError):
                raise
            except AuthenticationError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:
                raise UpstreamError(self._scrub(exc)) from exc

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

    def list_vehicles(self) -> list[dict]:
        """Every car on the account. Logs nothing about them: names are
        owner-chosen and can be personal, and the proxy's whole posture is
        that account data passes through without being recorded.

        Always re-discovers rather than trusting the session's cached list:
        this is the endpoint whose entire job is answering "what cars do I
        have", and serving a garage up to a session-TTL out of date would
        hide a car the user just added — from the one screen built to show
        it. It is user-initiated and rare, so the extra fetch is affordable
        here in a way it would not be on the per-poll paths."""
        with self._lock:
            try:
                self._vehicles_loaded = False
                self._prepare()
                return [
                    {
                        "id": v.id,
                        "name": getattr(v, "name", None),
                        "model": getattr(v, "model", None),
                        "year": getattr(v, "year", None),
                    }
                    for v in self._vm.vehicles.values()
                ]
            except (UpstreamError, AuthError):
                raise
            except AuthenticationError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:
                raise UpstreamError(self._scrub(exc)) from exc

    def lock(self, vehicle_id: str | None = None) -> None:
        self._command("lock", lambda vid: self._vm.lock(vid), vehicle_id)

    def unlock(self, vehicle_id: str | None = None) -> None:
        self._command("unlock", lambda vid: self._vm.unlock(vid), vehicle_id)

    def start_charge(self, vehicle_id: str | None = None) -> None:
        self._command("start_charge", lambda vid: self._vm.start_charge(vid), vehicle_id)

    def stop_charge(self, vehicle_id: str | None = None) -> None:
        self._command("stop_charge", lambda vid: self._vm.stop_charge(vid), vehicle_id)

    def set_charge_limits(
        self, ac: int, dc: int, vehicle_id: str | None = None
    ) -> None:
        self._command(
            "charge_limits",
            lambda vid: self._vm.set_charge_limits(vid, ac, dc),
            vehicle_id,
        )

    def _temperature_range(self) -> Sequence[float] | None:
        """The current implementation's accepted temperature values, if it
        publishes a flat list. None for Canada (year-dependent ranges) and
        before login, where wire_temp falls back to a 0.5°C grid."""
        return getattr(getattr(self._vm, "api", None), "temperature_range", None)

    def set_climate(self, req: ClimateSettings, vehicle_id: str | None = None) -> None:
        def run(vid: str) -> None:
            if req.on:
                # req.temp is Celsius (the proxy's API contract); the library
                # wants whatever its region impl uses and converts nothing
                # itself. See app/climate_units.py.
                set_temp = wire_temp(
                    req.temp, self._region, self._temperature_range()
                )
                logger.info(
                    "climate target %.1f°C -> %s%s (region %s)",
                    req.temp,
                    set_temp,
                    wire_unit(self._region),
                    self._region_name,
                )
                self._vm.start_climate(
                    vid,
                    ClimateRequestOptions(
                        set_temp=set_temp,
                        climate=True,
                        defrost=req.defrost,
                        # 1 = steering wheel + rear window/mirror heat
                        heating=1 if req.heating else 0,
                        duration=req.duration_minutes,
                    ),
                )
            else:
                self._vm.stop_climate(vid)

        self._command("climate", run, vehicle_id)

    def _command(self, name: str, fn, vehicle_id: str | None = None) -> None:
        # Timing split answers "why was the first command slow": lock wait is
        # time blocked behind the warm-up thread's login, login/prepare is our
        # own Genesis auth, and the command call is Genesis relaying to the car
        # over the mobile network — only the last one is physics, not fixable.
        t_req = time.monotonic()
        with self._lock:
            lock_wait = time.monotonic() - t_req
            try:
                t0 = time.monotonic()
                vid = self._prepare(vehicle_id)
                t1 = time.monotonic()
                fn(vid)
                logger.info(
                    "timing command %s: lock wait %.1fs, login/prepare %.1fs, command call %.1fs",
                    name, lock_wait, t1 - t0, time.monotonic() - t1,
                )
            except (UpstreamError, AuthError, UnknownVehicleError):
                raise
            except AuthenticationError as exc:
                raise AuthError(self._scrub(exc)) from exc
            except Exception as exc:
                raise UpstreamError(self._scrub(exc)) from exc
