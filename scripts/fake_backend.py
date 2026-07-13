"""Run the real FastAPI backend with a fake vehicle provider.

For simulator/dev testing without a Genesis account. Serves on :8787 with
token "test-token". Commands mutate the fake car so re-polls show the change.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

os.environ.update(
    CONNECT_REMOTE_USERNAME="fake",
    CONNECT_REMOTE_PASSWORD="fake",
    CONNECT_REMOTE_PIN="0000",
    CONNECT_REMOTE_API_TOKEN="test-token",
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import uvicorn

from app.main import AppState, app
from app.providers.base import ClimateSettings, VehicleStatus
from app.rate_limit import RefreshThrottle


class FakeProvider:
    def __init__(self):
        self.locked = True
        self.climate_on = False
        self.charging = True
        self.limit_ac, self.limit_dc = 80, 90

    def _status(self):
        return VehicleStatus(
            soc_percent=82,
            range_value=317,
            range_unit="mi",
            locked=self.locked,
            charging=self.charging,
            charge_eta_minutes=95 if self.charging else None,
            charge_limit_ac=self.limit_ac,
            charge_limit_dc=self.limit_dc,
            climate_on=self.climate_on,
            doors_open=[],
            latitude=51.5072,
            longitude=-0.1276,
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
app.state.wiring = AppState(
    status_provider=provider,
    command_provider=provider,
    throttle=RefreshThrottle(min_interval_seconds=5, daily_cap=100),
)

uvicorn.run(app, host="127.0.0.1", port=8787, log_level="info")
