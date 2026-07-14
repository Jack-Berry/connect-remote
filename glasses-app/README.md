# Genesis Remote — G2 glasses app

EvenHub web app showing vehicle status (SoC / range / lock / charging / climate)
on a glanceable HUD. Double-tap opens the actions menu: lock/unlock, climate
on/off, charge start/stop, refresh (cached status only — no force refresh from
the glasses) and Quit. Menu actions fire on a single tap; the system exit dialog
opens via Quit, a double-tap in the menu, or a double-tap on any connect/error
screen. Settings (Connected Services sign-in, climate temp/defrost, charge
limits) are entered on the phone screen and stored in the Even app; every
request carries the credentials to the hosted relay proxy at
`car-proxy.berrydev.co.uk` — the app's one whitelisted host.

See the repo root [README.md](../README.md) for full setup, including running
against a fake backend.

## Run

```bash
npm install
npm run dev
```

Then either:
- **Simulator:** `npm run simulate`
- **Real glasses:** `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Hub companion app.

## Layout

| File | Purpose |
|---|---|
| `index.html` | Phone-side settings screen (account sign-in, climate prefs). |
| `src/main.ts` | Glasses page, event handling, action execution, phone UI binding. |
| `src/display.ts` | Container definitions, context-aware menu items, HUD/menu formatting. |
| `src/api.ts` | Relay REST client — POST with credentials in body, fixed base URL. |
| `src/settings.ts` | Settings persistence via Even app bridge storage. |
| `src/brand.ts` | Build-time brand: copy + the numeric brand code sent to the relay. |
| `app.json` | Even Hub manifest — whitelist is exactly the relay host. |

## Pack for distribution

```bash
npm run pack
```

Never bake credentials into the package — the `.ehpk` is shareable and WebView
storage is not secure. Credentials are entered on the phone screen and live
only in Even app storage. Never set `VITE_BACKEND_URL` when building a
distributable: production builds must talk to the fixed, whitelisted relay.
