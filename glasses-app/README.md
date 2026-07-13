# Genesis Remote — G2 glasses app

EvenHub web app showing vehicle status (SoC / range / lock / charging / climate)
with TouchBar-driven actions: refresh, force refresh, climate on/off, lock, unlock.
Settings (backend URL, API token, climate temp/defrost) are entered on the phone
screen and stored in the Even app.

See the repo root [README.md](../README.md) for full setup, including deploying the
backend and running against a fake backend.

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
| `index.html` | Phone-side settings screen (backend URL, token, climate prefs). |
| `src/main.ts` | Glasses page, event handling, action execution, phone UI binding. |
| `src/display.ts` | Container definitions, action list, status/action-bar formatting. |
| `src/api.ts` | Backend REST client with timeouts. |
| `src/settings.ts` | Settings persistence via Even app bridge storage. |
| `app.json` | Even Hub manifest — set your backend host in the `network` whitelist. |

## Pack for distribution

Put your real backend hostname in the `network` permission whitelist in `app.json`, then:

```bash
npm run pack
```

Never bake Connected Services credentials into the package — the `.ehpk` is shareable and
WebView storage is not secure. The bearer token is entered on the phone screen
and lives only in Even app storage.
