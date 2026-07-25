# Sensor Probe — throwaway

Stage 0 of the car finder (`docs-internal/CARFINDER-HANDOFF.md` §5). Answers the
phone-sensor unknowns on real hardware so the Option A / Option B fork can be
chosen on evidence. **Not a product** — separate `package_id`
(`com.jackberry.sensorprobe`), private build only, never submitted to the store.
Delete this folder once `PROBE-RESULTS-STAGE0.md` is folded into
`even-stat-hub/Reference/G2-CAPABILITIES.md`.

## Run it

```bash
npm install
npm run build && npm run pack   # → sensor-probe.ehpk
```

Upload the `.ehpk` as a **private build** and OTA it to the glasses.
Geolocation does not work from a QR sideload — a Hub build is mandatory, so
there is no shortcut here.

Simulator (`npm run dev`, then point `evenhub-simulator` at
`http://localhost:5173`) is useful for layout only: it has no GPS, no compass,
and no iOS permission model. Note that a Vite hot-reload leaves the simulator's
startup page stale and the app will log `Startup page creation failed (1)` and
exit — restart the simulator rather than reloading.

## What it does

Three answers, one screen each on the phone, all mirrored to the glasses:

1. **Geolocation** — `watchPosition` with `enableHighAccuracy`. Prints lat/long,
   accuracy, fix count, inter-fix gap, and GPS `heading`/`speed` (the Option B
   "which way am I walking" fallback).
2. **Motion + compass** — `requestPermission()` on both `DeviceOrientationEvent`
   and `DeviceMotionEvent`, fired from inside the button's click handler because
   iOS rejects the call from anywhere else. Prints the permission result and how
   long it took to settle, `webkitCompassHeading`/`Accuracy`, `absolute`,
   alpha/beta/gamma, acceleration (with and without gravity), and rotation rate.
3. **Arrow glyphs** — measures the handoff's `↑↗→↘↓↙←↖` against the firmware font
   chain with `@evenrealities/pretext`, and prints the row on the glasses boot
   screen so the hardware confirms it visually.

### Verdicts

`OK` · `DENIED` · `NO-PROMPT` · `NO-EVENTS` · `NOT-SUPPORTED` · `ERROR`

The three-way split in the middle is the point. `DENIED` is the user (or policy)
saying no. `NO-PROMPT` is iOS rejecting the request without drawing anything —
in practice a `NotAllowedError`, meaning either a gesture-context problem or a
WebView policy wall. `NO-EVENTS` is the nastiest and the easiest to misread as
success: permission comes back `granted` and then no event ever fires. Each
implies a different response, so the probe never collapses them into "failed".

## Notes for whoever reads this later

- Glasses updates run through a 2 Hz latest-wins pump. Orientation events arrive
  at ~60 Hz and the panel sustains 4–8 fps; pushing every event would saturate
  the BLE link and make the numbers unreadable.
- All bridge calls go through one promise chain — concurrent calls can drop the
  link. Same discipline as the main app.
- Sensors are stopped on `SYSTEM_EXIT`/`ABNORMAL_EXIT` and by the Stop buttons.
  They are deliberately **left running** on `FOREGROUND_EXIT`, because "do fixes
  keep arriving while backgrounded?" is itself a finder-relevant question and
  the counters answer it on return. The finder itself must stop them there.
- The `location` permission in `app.json` carries no `whitelist` — that key is
  network-only, and the CLI validates it.
