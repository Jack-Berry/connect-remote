"""One-off diagnostic: log in to Genesis EU with the real credentials from
backend/.env, fetch CACHED vehicle state (does not wake the car), and dump
every Vehicle field so the StatusProvider mapping can be verified.

Run:  backend/.venv/bin/python backend/scripts/dump_fields.py

The raw upstream payload (v.data) is written to backend/scripts/raw_data.json
(gitignored) — it contains the VIN and other identifiers.
"""

import dataclasses
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402

settings = Settings(_env_file=BACKEND / ".env")

from hyundai_kia_connect_api import VehicleManager  # noqa: E402

vm = VehicleManager(
    region=settings.region,
    brand=settings.brand,
    username=settings.username,
    password=settings.password,
    pin=settings.pin,
)

print("Logging in / refreshing token…")
vm.check_and_refresh_token()
print("Fetching cached vehicle state…")
vm.update_all_vehicles_with_cached_state()

for vid, v in vm.vehicles.items():
    print(f"\n=== vehicle {vid} ===")
    for f in sorted(dataclasses.fields(v), key=lambda f: f.name):
        if f.name == "data":
            continue  # raw payload goes to raw_data.json
        print(f"{f.name} = {getattr(v, f.name)!r}")
    # properties aren't dataclass fields — list them too
    props = [
        n for n in dir(type(v))
        if isinstance(getattr(type(v), n, None), property)
    ]
    for n in sorted(props):
        try:
            print(f"[property] {n} = {getattr(v, n)!r}")
        except Exception as exc:
            print(f"[property] {n} = <error: {exc}>")

    out = Path(__file__).parent / "raw_data.json"
    out.write_text(json.dumps(v.data, indent=2, default=str))
    print(f"\nraw payload written to {out}")
