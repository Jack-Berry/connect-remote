# Connect Remote: control Genesis, Kia and Hyundai vehicles on Even Realities G2 glasses

Remote status + control for your car on Even Realities G2 glasses: state of charge, range, lock state, charging, climate, plus lock/unlock, climate control and charge limits.

Vehicle access goes through [`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api), so any car that library supports should work: **Genesis, Kia (Kia Connect) and Hyundai (Bluelink)**, in Europe, Canada, the USA and Australia. Development and testing have been done on a **Genesis GV70 Electrified (EU)**; that's the configuration known to work end to end. Other brands and models are expected to work but are unverified; if a field doesn't parse on your car, see [Reporting a problem](#reporting-a-problem).

## How it works

```
glasses-app/   EvenHub G2 web app (Vite + TS + @evenrealities/even_hub_sdk)
backend/       FastAPI relay proxy, hosted at car-proxy.berrydev.co.uk
deploy/        VPS deployment: compose stack, Caddyfile, server runbook
```

You sign in with your Connected Services account **in the app's phone
settings screen**. The credentials are stored only in the Even app on your
phone and sent, over HTTPS, with each request to a small **stateless relay
proxy** run by the developer, which forwards them to the manufacturer's
platform and returns the result. The relay keeps nothing on disk: no
accounts, no database, no access logs (see [DECISIONS-LOG.md](DECISIONS-LOG.md)
for why a hosted relay rather than bring-your-own backend: the Even Hub store
whitelist needs one fixed domain).

Full privacy policy: **https://jack-berry.github.io/connect-remote/privacy/**
(source: [PRIVACY.md](PRIVACY.md))

> **GitHub Pages**: the site (landing page + privacy policy) is published by
> the legacy branch build from **`main`, root folder**. [index.md](index.md)
> and [PRIVACY.md](PRIVACY.md) go live automatically on every push to `main`
> ([_config.yml](_config.yml) controls what's excluded). If the architecture
> changes, update those two files in the same PR.

## Using the app

1. Install the app from the Even Hub store (or sideload; see below).
2. Open its settings on the phone: enter your Connected Services username,
   password, PIN (the code the official app asks for before lock/unlock) and
   account region.
3. **Test connection**, then **Save**. Status and controls are on the glasses.

- **Glasses display**: a glanceable HUD with brand / lock state / range / SoC across the top, and charging or transient notes bottom-centre. Double-tap opens the actions menu (context-aware: lock or unlock, climate on/off, charge start/stop, refresh, quit); a single tap on a menu item sends the command immediately, with no confirm step, including unlock. Single tap on the HUD hides/shows the display ("glasses off"); tap on a failed connect screen retries. The system exit dialog opens via the menu's **Quit** item, a double-tap in the menu, or a double-tap on any connect/error screen. Refresh reads the relay's cached status only; force refresh is deliberately not available from the glasses (use the API directly).
- **Phone screen**: settings for account sign-in, climate target temp, defrost/heat and charge limits. Saved to Even app storage; no credentials in the `.ehpk`.
- **R1 ring**: gestures arrive through the same events; no code changes needed when it arrives.

## The relay API

All car endpoints are `POST` with the account credentials in the JSON body;
the relay holds no account state. `GET /healthz` is an unauthenticated
liveness probe.

```json
{ "credentials": { "username": "you@example.com", "password": "…",
                   "pin": "1234", "region": 1, "brand": 3 } }
```

Region codes: `1` EU, `2` Canada, `3` USA, `5` Australia. Brand codes: `1`
Kia, `2` Hyundai, `3` Genesis (both straight from `hyundai_kia_connect_api`).

| Endpoint | Extra body fields | Notes |
|---|---|---|
| `/status` | — | Cached vehicle state. Serves last-known state marked `stale: true` if the upstream service is unreachable. |
| `/refresh` | — | Wakes the car. Throttled per account (15 min interval, 20/day) → `429` with `Retry-After`. |
| `/climate` | `"on", "temp" (14–30), "defrost", "heating"` | heating = steering wheel + rear window/mirror heat |
| `/charge` | `"on": bool` | Start/stop charging. |
| `/charge-limits` | `"ac": 50–100, "dc": 50–100` | Sets the car's charge targets (percent). |
| `/lock`, `/unlock` | — | Fire-and-forget; the car applies it in 30–90 s. |
| `/debug/fields` | — | Redacted dump of every field your car reports; see below. |

Requests are rate-limited per IP (30/min general; 5/min on `/refresh` and
`/debug/fields`). Wrong credentials return `401`.

### Reporting a problem

If the app shows a **parse error**, or you're running a car other than the
Genesis GV70 it was developed against (different models report different
field names, and that's the most likely thing to break), run:

```bash
curl -s https://car-proxy.berrydev.co.uk/debug/fields \
  -H 'Content-Type: application/json' \
  -d '{"credentials":{"username":"you@example.com","password":"…","pin":"1234","region":1,"brand":3}}'
```

You'll get every field your car reports, pretty-printed, and it works even
when `/status` fails to parse; that's the point of it. **Copy all of it into
a GitHub issue.** The VIN, the car's location and other identifying values are
replaced with `<redacted>` before you see them, so the output is safe to post
in public. Skim it anyway before you paste: if something identifying got
through, redact it and please flag it in the issue.

## Siri Shortcuts

Each action is one **"Get Contents of URL"** step: URL from the table above,
method **POST**, request body **JSON** including the `credentials` object plus
any extra fields. Note the credentials then live inside the Shortcut, so only do
this on a device you trust, and think twice before giving `/unlock` a voice
phrase: anyone near your unlocked phone can say it.

## Development

### Backend

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
.venv/bin/python -m pytest      # tests
```

The vehicle integration lives behind `StatusProvider`/`CommandProvider`
protocols ([backend/app/providers/base.py](backend/app/providers/base.py)), so
an official manufacturer API can later replace the status source without
touching commands. `hyundai_kia_connect_api` is pinned; see the comment in
[backend/pyproject.toml](backend/pyproject.toml) before bumping it.

### Deployment

The production stack (Caddy + proxy via Docker Compose) and the full VPS
runbook live in [deploy/README.md](deploy/README.md). Short version, on the
server:

```bash
git pull
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

### Glasses app

```bash
cd glasses-app
npm install
npm run dev            # Vite on :5173
npm run simulate       # desktop simulator
npx @evenrealities/evenhub-cli qr --url http://<your-ip>:5173   # QR sideload to real glasses
```

Sideloading needs developer mode enabled in the Even Hub companion app. On iOS the QR
scan can hang the first time. That's the local-network permission prompt; allow it for
Even Hub in Settings and rescan. Phone and dev machine must be on the same network, and
the `--url` must be your machine's LAN IP, not `localhost`.

### Simulator testing against a fake car

```bash
# terminal 1 — real proxy, fake vehicle (accepts any credentials)
backend/.venv/bin/python scripts/fake_backend.py
# terminal 2 — VITE_BACKEND_URL overrides the fixed proxy URL (dev only!)
cd glasses-app && VITE_BACKEND_URL=http://127.0.0.1:8787 npx vite
# terminal 3
cd glasses-app && node node_modules/@evenrealities/evenhub-simulator/bin/index.js http://localhost:5173 --automation-port 9898
```

Enter any username/password in the simulator's phone panel; the fake backend
accepts everything and serves one shared fake car.

### Building for another brand

The glasses app is packed **one app per brand**. Brand is a build-time value;
everything brand-specific (the app name, the setup copy, and the numeric
brand code sent to the relay) comes from a single config in
[glasses-app/src/brand.ts](glasses-app/src/brand.ts), keyed off `VITE_BRAND`:

```bash
npm run build                  # genesis (the default)
VITE_BRAND=kia npm run build   # or hyundai
```

Brand-specific copy in `index.html` is marked `data-brand="<key>"` and filled from that
config at boot, so a new brand-specific string needs no code change: add the attribute
and the field. Adding a brand outright means one new entry in `BRANDS`.

`package_id` and `name` in [glasses-app/app.json](glasses-app/app.json) are per-app
identity and are **not** driven by `VITE_BRAND`; set them per brand before packing
(`npx @evenrealities/evenhub-cli pack`). Never set `VITE_BACKEND_URL` when packing:
production builds must talk to the fixed, whitelisted relay only.
