# Connect Remote — control Genesis, Kia and Hyundai vehicles on Even Realities G2 glasses

Remote status + control for your car on Even Realities G2 glasses and via Siri: state of charge, range, lock state, charging, climate — plus lock/unlock, climate presets and charge limits.

Vehicle access goes through [`hyundai_kia_connect_api`](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api), so any car that library supports should work: **Genesis, Kia (Kia Connect) and Hyundai (Bluelink)**, across its supported regions. Development and testing have been done on a **Genesis GV70 Electrified (EU)** — that's the configuration known to work end to end, and it's the default in the deploy blueprint. Other brands and models are expected to work but are unverified; if a field doesn't parse on your car, see [Reporting a problem](#reporting-a-problem) — that's exactly what it's for.

You bring your own backend: deploy it to Render (or any VPS/Docker host), and it becomes the only thing holding your Connected Services credentials. The glasses app and your Siri Shortcuts talk to it over HTTPS with a bearer token.

```
backend/       FastAPI wrapper around Hyundai/Kia/Genesis Connected Services
glasses-app/   EvenHub G2 web app (Vite + TS + @evenrealities/even_hub_sdk)
```

## Backend

### Deploy to Render (recommended)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jack-berry/connect-remote)

1. Click the button and enter the **username, password and PIN** for your car's Connected Services account — Genesis, Kia Connect or Bluelink, whichever you use (they're stored only in Render, marked `sync: false` in [render.yaml](render.yaml) — never in this repo).
2. Render **generates the API token** for you. After the first deploy, copy it from the service's **Environment** tab (`CONNECT_REMOTE_API_TOKEN`).
3. Note the service's HTTPS URL (`https://<your-service>.onrender.com`).
4. Paste the **URL + token** into the glasses app settings (and your Siri Shortcuts).

### Choosing your brand and region

The blueprint defaults to **Genesis in Europe** — the verified configuration. Two settings control this, both in Render's **Environment** tab (or your `.env`):

| Variable | Meaning | Default |
|---|---|---|
| `CONNECT_REMOTE_BRAND` | Brand code — `3` is Genesis. Must match the app build you installed. | `3` |
| `CONNECT_REMOTE_REGION` | Region code — `1` is Europe. Must match the region your account is registered in. | `1` |

Both are passed straight through to `hyundai_kia_connect_api`; take the values for other brands and regions from that library's `Brand` and `Region` enums, which are the source of truth. Getting either wrong tends to surface as a confusing login failure rather than a clear error, so check them first if authentication won't go through.

**Region is the one most people need to change** — the same Genesis app build serves EU, US, Canada and Australia owners, and the region has to match the account. Brand you generally leave alone: it pairs with the app build you installed (see [Building for another brand](#building-for-another-brand)).

The blueprint uses the **free** plan, which sleeps after ~15 min idle — the first request after that takes up to a minute while it wakes. Upgrade the plan if that's annoying.

### Local development

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env         # fill in Connected Services credentials + API token
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Run tests: `.venv/bin/python -m pytest`

### Docker (self-host / VPS)

```bash
cd backend
cp .env.example .env         # fill in Connected Services credentials + API token
docker build -t connect-remote-backend .
docker run -d --name connect-remote --restart unless-stopped \
  --env-file .env -p 127.0.0.1:8000:8000 connect-remote-backend
```

Same app, same pinned `hyundai_kia_connect_api==4.15.0`. Bind to `127.0.0.1` and put HTTPS in front (see [VPS deployment](#vps-deployment)) — never expose port 8000 directly.

Endpoints (all require `Authorization: Bearer <token>`, except `GET /healthz` — an unauthenticated liveness probe for Render/Docker health checks):

| Endpoint | Method | Notes |
|---|---|---|
| `/status` | GET | Cached vehicle state. Serves last-known state marked `stale: true` if the upstream service is unreachable. |
| `/refresh` | POST | Wakes the car. Throttled server-side (default: 15 min interval, 20/day) → `429` with `Retry-After`. |
| `/climate` | POST | `{"on": bool, "temp": 14–30, "defrost": bool, "heating": bool}` — heating = steering wheel + rear window/mirror heat |
| `/presets/{cool,warm,defrost}` | POST | No body — fixed climate presets for Siri (17° / 24° / 24°+defrost+heat). Edit `CLIMATE_PRESETS` in [backend/app/main.py](backend/app/main.py) to taste. |
| `/charge-limits` | POST | `{"ac": 50–100, "dc": 50–100}` — sets the car's charge targets (percent) |
| `/lock`, `/unlock` | POST | No body. Fire-and-forget — car applies in 30–90 s. |
| `/debug`, `/debug/fields` | GET | Redacted dump of every field your car reports — see [Reporting a problem](#reporting-a-problem). |

The vehicle integration lives behind `StatusProvider`/`CommandProvider` protocols
([backend/app/providers/base.py](backend/app/providers/base.py)), so an official
manufacturer API can later replace the status source without touching commands.

### Reporting a problem

If the app shows a **parse error**, or you're running a **car other than the Genesis GV70 it was developed against** — different brands and models report different field names, and that's the most likely thing to break — open this page in a browser:

```
https://<your-backend-url>/debug
```

Paste your API token into the box and press **Show fields**. You'll get every field your car reports, pretty-printed. **Copy all of it into a GitHub issue** — it's what tells us which field names your model uses. (From a terminal, `curl -H "Authorization: Bearer <your-token>" https://<your-backend-url>/debug/fields` gives the same thing.)

This works even when `/status` fails to parse — that's the point of it: it never goes through the model that's failing.

The VIN, the car's location and other identifying values are replaced with `<redacted>` before you see them, so the output is safe to post in public. Skim it anyway before you paste — if something identifying got through, redact it and please flag it in the issue. Your token stays in a request header, so it never lands in the URL, your browser history, or the server's logs.

### VPS deployment

1. Reverse-proxy with HTTPS — bearer token over plain HTTP is car theft waiting to happen. Caddy does it in two lines:
   ```
   car.example.com {
       reverse_proxy 127.0.0.1:8000
   }
   ```
2. Run uvicorn under systemd with `EnvironmentFile=` pointing at the `.env` — restarts never prompt for credentials; upstream tokens refresh automatically before every operation.
3. Verify your manufacturer's own app (Genesis, Kia Connect or Bluelink) works before blaming the backend — the car needs an active Connected Services subscription.

## Glasses app

```bash
cd glasses-app
npm install
npm run dev            # Vite on :5173
npm run simulate       # desktop simulator
npx @evenrealities/evenhub-cli qr --url http://<your-ip>:5173   # QR sideload to real glasses
```

Sideloading needs developer mode enabled in the Even Hub companion app. On iOS the QR
scan can hang the first time — that's the local-network permission prompt; allow it for
Even Hub in Settings and rescan. Phone and dev machine must be on the same network, and
the `--url` must be your machine's LAN IP, not `localhost`.

- **Glasses display**: status (SoC / range / lock / charging / climate) on top, action bar below. Swipe cycles actions (refresh, force refresh, climate on/off, lock, unlock), single tap sends, double tap exits. Unlock takes two taps (arm + confirm).
- **Phone screen**: settings — backend URL, API token, climate target temp, defrost. Saved to Even app storage; no credentials in the `.ehpk`.
- **R1 ring**: gestures arrive through the same events; no code changes needed when it arrives.

Before packing a distributable (`npx @evenrealities/evenhub-cli pack`), put your real
backend hostname in the `network` permission whitelist in
[glasses-app/app.json](glasses-app/app.json).

### Building for another brand

The glasses app is packed **one app per brand**. Brand is a build-time value; everything
the user sees that names a manufacturer — the app name, the setup guide, the service it
tells you to sign in to — comes from a single config in
[glasses-app/src/brand.ts](glasses-app/src/brand.ts), keyed off `VITE_BRAND`:

```bash
npm run build                  # genesis (the default)
VITE_BRAND=kia npm run build   # or hyundai
```

Brand-specific copy in `index.html` is marked `data-brand="<key>"` and filled from that
config at boot, so a new brand-specific string needs no code change — add the attribute
and the field. Adding a brand outright means one new entry in `BRANDS`.

Two things to keep in step when you pack a non-Genesis build:

- The backend's `CONNECT_REMOTE_BRAND` must be the matching brand code — the app's build-time
  brand drives copy only, and deliberately doesn't carry the API's numeric code, so the two
  can't silently disagree about the credentials the backend logs in with.
- `package_id` and `name` in [glasses-app/app.json](glasses-app/app.json) are per-app identity
  and are **not** driven by `VITE_BRAND` — set them per brand before packing.

### Simulator testing against a fake car

```bash
# terminal 1 — real backend, fake vehicle (no Connected Services account needed)
backend/.venv/bin/python scripts/fake_backend.py
# terminal 2
cd glasses-app && VITE_BACKEND_URL=http://127.0.0.1:8787 VITE_API_TOKEN=test-token npx vite
# terminal 3
cd glasses-app && node node_modules/@evenrealities/evenhub-simulator/bin/index.js http://localhost:5173 --automation-port 9898
```

## Siri Shortcuts

One shortcut per action in the Shortcuts app, each a single **"Get Contents of URL"** step:

1. URL: `https://car.example.com/presets/warm` (or any endpoint below)
2. Method: **POST**
3. Headers: `Authorization` → `Bearer <your token>`
4. Name it with the phrase you'll say: e.g. **"Warm my car"**.

The `/presets/*` routes need no request body, which keeps the Shortcut to a
single step. Suggested set:

| Phrase | Endpoint | Body |
|---|---|---|
| "Warm my car" | `POST /presets/warm` | — (24 °C) |
| "Cool my car" | `POST /presets/cool` | — (17 °C) |
| "Defrost my car" | `POST /presets/defrost` | — (24 °C + defrost + rear/steering heat) |
| "Climate off" | `POST /climate` | `{"on": false}` |
| "Lock the car" | `POST /lock` | — |
| "Car status" | `GET /status` | — (add "Show Result" step) |

Think twice before giving `/unlock` a voice phrase — anyone near your unlocked phone can say it.
