"""Run the real FastAPI proxy with a fake vehicle provider.

For simulator/dev testing without a Connected Services account. Serves on
:8787 and accepts ANY credentials — every account shares the same fake
garage. Commands mutate the fake car so re-polls show the change.

FAKE_VEHICLES=2 puts a second car on the account (an EV and a fuel-only
hybrid — the pair that differs most on screen), which is the only way to
exercise the car picker, the HUD car name, and the per-car powertrain
adaptation without a real two-car Bluelink account. Unset/1 keeps the
single-car behaviour every existing sim script relies on.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import uvicorn

from app.main import app
from app.providers.base import ClimateSettings, UnknownVehicleError, VehicleStatus
from app.rate_limit import ThrottleRegistry
from app.session_cache import SessionCache


class FakeCar:
    """One car's mutable state plus the identity the picker shows.

    `kind` None means "read the powertrain from the environment on every
    request" — that's the legacy single car, where FAKE_PHEV/FAKE_HEV can be
    flipped without a restart. Extra cars pin their kind instead.
    """

    def __init__(self, vid, name, model, year, kind=None):
        self.id = vid
        self.name = name
        self.model = model
        self.year = year
        self._kind = kind
        self.locked = True
        self.climate_on = False
        self.charging = True
        self.limit_ac, self.limit_dc = 80, 90

    @property
    def kind(self) -> str:
        if self._kind:
            return self._kind
        if os.environ.get("FAKE_HEV") == "1":
            return "HEV"
        if os.environ.get("FAKE_PHEV") == "1":
            return "PHEV"
        return "EV"


def _build_garage() -> list[FakeCar]:
    # The legacy car keeps id/name/model it always had, so a saved
    # selectedVehicleId from an earlier run still resolves.
    cars = [FakeCar("fake-1", "Test Car", "GV70", 2024)]
    if os.environ.get("FAKE_VEHICLES", "1") != "1":
        # Fuel-only, so switching to it flips the phone form to the fuel
        # layout and drops the charge actions from the glasses menu — the
        # visible proof that the selection reached the classification.
        cars.append(FakeCar("fake-2", "Runabout", "TUCSON", 2021, kind="HEV"))
    return cars


class FakeProvider:
    def __init__(self):
        self.cars = {c.id: c for c in _build_garage()}

    def _car(self, vehicle_id):
        """Resolve a selector the way the real provider does: None means the
        account's first car, an unknown id is a 404 rather than a crash."""
        if vehicle_id is None:
            return next(iter(self.cars.values()))
        if vehicle_id not in self.cars:
            raise UnknownVehicleError("vehicle not found on this account")
        return self.cars[vehicle_id]

    def _is_first(self, car) -> bool:
        return car.id == next(iter(self.cars))

    def _status(self, car):
        # FAKE_WARNINGS drives the car-reported warning line/banner — a comma
        # separated list of proxy keys, e.g.
        #   FAKE_WARNINGS=brake_fluid_low,washer_fluid_low
        # The real evaluator refuses to invent these (every field must be
        # proven from the car's own payload, and we hold no fault specimen),
        # so this is the only way to see the collision matrix on screen.
        # FAKE_PHEV=1 makes it a charging both-sides car: the band's hardest
        # case, where the warning has to stack above an EV line AND a
        # charging line without evicting either.
        # FAKE_WARNINGS_FILE points at a file re-read on every request, so a
        # warning can be made to arrive WHILE the app is in the menu, the
        # finder, a command confirmation or a hidden HUD — the precedence
        # collisions are all about timing, and a fixed env var can only ever
        # produce the easy one (a warning that is already there at launch).
        # Warnings land on the first car only: they are a property of that
        # car, and a warning that followed the user between cars would make
        # the per-car HUD look broken.
        warnings = []
        if self._is_first(car):
            warnings_file = os.environ.get("FAKE_WARNINGS_FILE")
            raw = os.environ.get("FAKE_WARNINGS", "")
            if warnings_file and os.path.exists(warnings_file):
                with open(warnings_file, encoding="utf-8") as f:
                    raw = f.read().strip()
            warnings = [w.strip() for w in raw.split(",") if w.strip()]
        # Shown in place of the brand word once the account holds 2+ cars.
        identity = dict(vehicle_name=car.name or car.model, vehicle_count=len(self.cars))
        parked = datetime.now(timezone.utc) - timedelta(
            minutes=int(os.environ.get("FAKE_PARKED_MINUTES_AGO", "0"))
        )
        coords = (
            (None, None)
            if os.environ.get("FAKE_NO_COORDS")
            else (51.5072, -0.1276)
        )
        # FAKE_HEV=1 is the fuel-only car: a hybrid that never plugs in, so
        # the EV fields are absent entirely and `charging` is None rather than
        # False — an HEV doesn't report a charging state at all, and False
        # would be the app being told something the car never said. That
        # absence is exactly what keeps the charge actions off the menu.
        if car.kind == "HEV":
            return VehicleStatus(
                powertrain="HEV",
                warnings=warnings,
                fuel_level_percent=62,
                fuel_range=310,
                range_unit="mi",
                locked=car.locked,
                charging=None,
                climate_on=car.climate_on,
                doors_open=[],
                latitude=coords[0],
                longitude=coords[1],
                # FAKE_PARKED_MINUTES_AGO drives the car finder's staleness
                # line ("parked 2h ago", shown past 30 min) without waiting
                # for time to pass. Unset = parked just now, line hidden.
                location_last_updated=parked,
                last_updated=datetime.now(timezone.utc),
                **identity,
            )
        phev = car.kind == "PHEV"
        return VehicleStatus(
            powertrain="PHEV" if phev else "EV",
            warnings=warnings,
            fuel_level_percent=60 if phev else None,
            fuel_range=340 if phev else None,
            soc_percent=82 if not phev else 55,
            range_value=317 if not phev else 25,
            range_unit="mi",
            locked=car.locked,
            charging=car.charging,
            charge_eta_minutes=95 if car.charging else None,
            charge_limit_ac=car.limit_ac,
            charge_limit_dc=car.limit_dc,
            climate_on=car.climate_on,
            doors_open=[],
            latitude=coords[0],
            longitude=coords[1],
            location_last_updated=parked,
            last_updated=datetime.now(timezone.utc),
            **identity,
        )

    def get_cached_status(self, vehicle_id=None):
        return self._status(self._car(vehicle_id))

    def force_refresh(self, vehicle_id=None):
        return self._status(self._car(vehicle_id))

    def list_vehicles(self):
        return [
            {"id": c.id, "name": c.name, "model": c.model, "year": c.year}
            for c in self.cars.values()
        ]

    def get_raw_fields(self, vehicle_id=None):
        car = self._car(vehicle_id)
        return {
            "fields": {
                "VIN": "KMTG341ABC1234567",
                "name": car.name,
                "model": car.model,
                "location_latitude": 51.5072,
                "ev_battery_percentage": 82,
                "is_locked": car.locked,
            },
            "raw": {"vehicleStatus": {"evStatus": {"batteryStatus": 82}}},
        }

    def lock(self, vehicle_id=None):
        car = self._car(vehicle_id)
        car.locked = True
        print(f"FAKE: lock command received [{car.id}]", flush=True)

    def unlock(self, vehicle_id=None):
        car = self._car(vehicle_id)
        car.locked = False
        print(f"FAKE: unlock command received [{car.id}]", flush=True)

    def set_climate(self, req: ClimateSettings, vehicle_id=None):
        car = self._car(vehicle_id)
        car.climate_on = req.on
        print(f"FAKE: climate command received [{car.id}]: {req}", flush=True)

    def start_charge(self, vehicle_id=None):
        car = self._car(vehicle_id)
        car.charging = True
        print(f"FAKE: start charge command received [{car.id}]", flush=True)

    def stop_charge(self, vehicle_id=None):
        car = self._car(vehicle_id)
        car.charging = False
        print(f"FAKE: stop charge command received [{car.id}]", flush=True)

    def set_charge_limits(self, ac: int, dc: int, vehicle_id=None):
        car = self._car(vehicle_id)
        car.limit_ac, car.limit_dc = ac, dc
        print(f"FAKE: charge limits received [{car.id}]: ac={ac} dc={dc}", flush=True)


provider = FakeProvider()
# One shared fake garage no matter what credentials the app sends.
app.state.cache = SessionCache(factory=lambda creds: provider)
app.state.refresh_throttles = ThrottleRegistry(min_interval_seconds=5, daily_cap=100)

print(
    f"FAKE: {len(provider.cars)} car(s): "
    + ", ".join(f"{c.id}={c.name} ({c.kind})" for c in provider.cars.values()),
    flush=True,
)

uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
