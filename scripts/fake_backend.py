"""Run the real FastAPI proxy with a fake vehicle provider.

For simulator/dev testing without a Connected Services account. Serves on
:8787 and accepts ANY credentials — every account shares the one fake car.
Commands mutate the fake car so re-polls show the change.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import uvicorn

from app.main import app
from app.providers.base import ClimateSettings, VehicleStatus
from app.rate_limit import ThrottleRegistry
from app.session_cache import SessionCache


class FakeProvider:
    def __init__(self):
        self.locked = True
        self.climate_on = False
        self.charging = True
        self.limit_ac, self.limit_dc = 80, 90

    def _status(self):
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
        warnings_file = os.environ.get("FAKE_WARNINGS_FILE")
        raw = os.environ.get("FAKE_WARNINGS", "")
        if warnings_file and os.path.exists(warnings_file):
            with open(warnings_file, encoding="utf-8") as f:
                raw = f.read().strip()
        warnings = [w.strip() for w in raw.split(",") if w.strip()]
        phev = os.environ.get("FAKE_PHEV") == "1"
        return VehicleStatus(
            powertrain="PHEV" if phev else "EV",
            warnings=warnings,
            fuel_level_percent=60 if phev else None,
            fuel_range=340 if phev else None,
            soc_percent=82 if not phev else 55,
            range_value=317 if not phev else 25,
            range_unit="mi",
            locked=self.locked,
            charging=self.charging,
            charge_eta_minutes=95 if self.charging else None,
            charge_limit_ac=self.limit_ac,
            charge_limit_dc=self.limit_dc,
            climate_on=self.climate_on,
            doors_open=[],
            latitude=None if os.environ.get('FAKE_NO_COORDS') else 51.5072,
            longitude=None if os.environ.get('FAKE_NO_COORDS') else -0.1276,
            # FAKE_PARKED_MINUTES_AGO drives the car finder's staleness line
            # ("parked 2h ago", shown past 30 min) without waiting for time to
            # pass. Unset = parked just now, so the line stays hidden.
            location_last_updated=datetime.now(timezone.utc)
            - timedelta(minutes=int(os.environ.get("FAKE_PARKED_MINUTES_AGO", "0"))),
            last_updated=datetime.now(timezone.utc),
        )

    def get_cached_status(self):
        return self._status()

    def force_refresh(self):
        return self._status()

    def get_raw_fields(self):
        return {
            "fields": {
                "VIN": "KMTG341ABC1234567",
                "model": "GV70",
                "location_latitude": 51.5072,
                "ev_battery_percentage": 82,
                "is_locked": self.locked,
            },
            "raw": {"vehicleStatus": {"evStatus": {"batteryStatus": 82}}},
        }

    def lock(self):
        self.locked = True
        print("FAKE: lock command received", flush=True)

    def unlock(self):
        self.locked = False
        print("FAKE: unlock command received", flush=True)

    def set_climate(self, req: ClimateSettings):
        self.climate_on = req.on
        print(f"FAKE: climate command received: {req}", flush=True)

    def start_charge(self):
        self.charging = True
        print("FAKE: start charge command received", flush=True)

    def stop_charge(self):
        self.charging = False
        print("FAKE: stop charge command received", flush=True)

    def set_charge_limits(self, ac: int, dc: int):
        self.limit_ac, self.limit_dc = ac, dc
        print(f"FAKE: charge limits received: ac={ac} dc={dc}", flush=True)


provider = FakeProvider()
# One shared fake car no matter what credentials the app sends.
app.state.cache = SessionCache(factory=lambda creds: provider)
app.state.refresh_throttles = ThrottleRegistry(min_interval_seconds=5, daily_cap=100)

uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
