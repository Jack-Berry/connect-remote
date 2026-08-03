# Decisions log

Significant product/architecture decisions, newest first. One entry per
decision: what changed, why, and what it rules out.

## 2026-08-03 — Multi-car: the selector rides on credentials, one login per account

**Decision:** `Credentials` gains an optional `vehicle_id`, and a new
`POST /vehicles` lists the account's cars (`id`, `name`, `model`, `year` —
deliberately no VIN). Omitting the selector keeps the old behaviour exactly:
the account's first vehicle. The phone shows a picker in the Account section
only when the account holds 2+ cars, and the HUD swaps the brand word for the
car's name in that case. Requested by a Hyundai owner with two cars on one
Bluelink account.

**Why the selector is part of `Credentials` and not the session key:** it is a
per-request choice, not account identity — the same argument that keeps
`device_token` out of the key. Keying on it would mean a second full Connected
Services login per car, and the EU endpoints rate-limit fresh logins. Both
cars therefore share one `VehicleManager`, which in turn forces the two pieces
of genuinely per-car state to become per-car maps: `_powertrain` →
`_powertrains[vehicle_id]` (an account can pair an EV with an ICE, and one
cached classification would render the wrong HUD and suppress the wrong
fields) and `Session.last_known` → keyed by vehicle (serving car A's cached
status for a question about car B is a confidently wrong answer, and it would
arrive flagged `stale` as if it were about B).

**Unknown ids are 404, not 502, and never retried.** A sold car is
client-fixable — re-run Test connection — whereas the apps map 502 to "service
unreachable" and send users chasing credentials. Retrying a bad id would also
burn the ~10 s login backoff on something that cannot come right next attempt.

**Rules out / accepted costs:**
- **Force-refresh throttling stays per-account**, so refreshing car A blocks
  car B for 15 min and both share the 20/day cap. Upstream daily command
  budgets are account-scoped; splitting the throttle per car would quietly
  double what we ask of the upstream.
- **Vehicle discovery still fetches every car** once per provider life
  (`update_all_vehicles_with_cached_state`). Optimising it would change the
  known-good single-car path, which cannot be validated without a real
  two-car account.
- **No glasses-side car switching.** The menu is length-capped and priority
  trimmed; switching is a settings action, like region.
- **No VIN in `/vehicles`.** It is the most identifying field upstream holds
  and the client has no use for it.

Testable without a two-car account: `FAKE_VEHICLES=2 python
scripts/fake_backend.py` serves an EV plus a fuel-only hybrid.

## 2026-07-25 — Car-reported warnings: per-car opt-in, proven from the payload

**Decision:** `/status` gains `warnings: []` — stable, severity-ranked keys,
first cut exactly four: `brake_fluid_low` > `tyre_pressure_low` >
`smart_key_battery_low` > `washer_fluid_low`. A key is evaluated only when the
proxy can PROVE from that car's own raw payload that the car reports the flag
(`backend/app/warnings.py`); unprovable → the key silently does not exist for
that car, and an empty array is the normal answer. Flags are read truthily,
never `is True`; any type that isn't bool/int/float is treated as unsupported,
not as a warning. No warning is ever derived from a numeric reading or an
uncalibrated raw enum. Glasses show one line, highest severity, ~5 s, once per
launch; the phone lists all of them in a dismissible banner.

**Why:** each car reports a different subset of these fields (`windowOpen` is
present on a 2020 Kia-US Niro EV and `NoneType` on a 2026 Kia-US ICE — same
region, same parser), so presence must be proven per car rather than assumed
per region. The proof cannot come from the parsed value: `ApiImplType1` wraps
the tyre and smart-key flags in a bare `bool(...)`, and `KiaUvoApiEU` does the
same for the tyre flags (line 599 — a correction to WARNINGS-FIELDS.md, which
listed EU-legacy tyre as `int | None`), so `bool(None) → False` makes "not
supported" and "no warning" the same value. Raw-key presence in `vehicle.data`
is the proof; every parser stores its untouched payload there.

Warnings are suppressed wholesale when the car's own data is older than
30 minutes, and dropped from the cached copy served when upstream is down. A
warning is a claim about the car *right now*, and a cached payload can describe
a fault already dealt with. 30 min = two `/refresh` throttle windows, so
fresh data is always reachable inside it. The response explains the empty array
without a new field: `stale` and `last_updated` are already in it.

**Confidence ceiling, unchanged by shipping:** every specimen we hold is a
healthy car. The flag → dashboard-lamp correspondence is inferred from key
names, never observed firing. Hence copy that reports rather than diagnoses
("Car reports low brake fluid"), and `backend/app/warning_counts.py`: an
anonymous count per (brand, region, warning_key), no account link, no values,
no timestamps, so the first real-world fire in the wild gets captured.

**What it rules out:** warnings from readings or thresholds (12 V level, tyre
`Pressure`, SoC) — those are our diagnosis, not the car's; per-corner tyre
flags as an independent trigger (never parsed at all on Kia-US); `dtc_count`
until a non-zero specimen exists (`"0"` is truthy, and its type differs
per car within one region); and any copy that invites a tap, because a tap on
the HUD is the hide-HUD toggle.

**Glasses precedence, all pinned by tests and a simulator sweep:** transient
command notes and errors win absolutely and a warning arriving during one
re-queues behind them; the warning stacks ABOVE the PHEV both-sides EV line and
the charging line rather than evicting them (the band's box grew to three lines
at y=192 and is bottom-aligned, so existing one- and two-line content lands on
the same pixels as before); nothing paints while the HUD is hidden,
backgrounded, or in the finder; and the showing is pending-until-first-HUD-paint
rather than fire-on-status, because the launch `/status` routinely lands while
the user is still on the connecting page.

## 2026-07-25 — Save never commands the car; charge limits get a contextual send

**Decision:** Save persists local settings and nothing else — credentials,
region, unit, climate target, toggles, and the charge-limit *values*. No request
reaches the car because the user tapped Save. Pushing charge limits is its own
deliberate action: a button under the limit controls that appears only while the
form disagrees with what the car is known to hold, names the exact values
(`Send 80% / 90% to car`), carries its own sending/sent/failed line, and stays
put after a failure as the retry. One push at a time; a tap while in flight is
ignored, never queued. Genesis → 1.4.8.

**Why:** the phone-UI redesign folded the old standalone *Send limits to car*
button into Save, on the reasoning that "limits go with Save". That made a
preference write drive the vehicle as a side effect — a dropdown brushed by
accident became a command — and it is the only place in the app where a car
command isn't an explicit, separately labelled tap (climate, lock, charge all
are). It also quietly removed the retry path that matters most: the car takes
30–90 s to apply limits and is often asleep, so the first attempt failing is
routine, and the only way back was to change a dropdown and re-Save.

"What the car is known to hold" ranks a successful send above the car's own
reported `charge_limit_ac`/`dc` for a settle window (`CHARGE_LIMITS_SETTLE_MS`,
3 min) and below it after — otherwise a poll landing inside the apply window
re-raises the button seconds after a successful send, and a stale send record
would mask a limit changed in the manufacturer's own app forever. Unknown counts
as "offer the send": a car that reports no limits and has been sent none is the
one case with no other way to find out.

**What it rules out:** bundling any further car command into Save, or into any
control whose visible job is to record a preference. If a value is worth sending
to the car it gets its own labelled action and its own status line.

**Also pinned by tests, not just prose:** Save's disabled-until-dirty gate is fed
by one delegated `input`/`change` listener on `#app`, which is broad enough to
catch controls a hand-written field list would forget — but it means any control
that changes a persisted value without emitting a bubbling event leaves Save
permanently dead. Two on this form are that shape (the ± climate steppers, and
the C/F segmented switch writing to a hidden `<select>`); both synthesise
`bubbles: true` events, and `dirty-tracking.test.ts` now sweeps every control in
every state and brand so deleting that flag fails a test instead of a hardware
round.

## 2026-07-24 — All bridge calls go through `enqueue`; view transitions are atomic

**Decision:** two invariants, both now enforced in code after 1.4.0-TEST killed
glasses gestures app-wide on hardware. (1) **Every** bridge call goes through the
`enqueue` serialization chain — including the finder engine's KV
(`getLocalStorage`/`setLocalStorage`), which 1.4.0 called directly. (2) A `view`
transition commits **only once its page rebuild lands**, and rolls back if it
rejects (`commitView` in the new `glasses-input.ts`). The event router is
extracted from `main.ts` into that module as a pure function. Genesis → 1.4.2.

**Why:** unserialized bridge traffic jammed the BLE link, so the menu rebuild
never landed — but `view` had already been set to `"menu"`, leaving the router
reading a page that wasn't on screen. From there single taps matched no branch
and every double-tap fell through to the system exit dialog. The router itself
was byte-identical to the working build; the bug was entirely in the state it
read.

**What it rules out:** "the simulator sweep passed" is not evidence for anything
touching the bridge — there is no BLE there, so unserialized calls are invisible
by construction. That class must be prevented structurally, not observed. And a
green suite meant nothing here because the router was welded behind main.ts's
top-level await: the gesture matrix had zero coverage, and no test had ever
exercised a *rejecting* rebuild. Both closed — see
`docs-internal/QA-CARFINDER-GESTURE-FIX.md`.

## 2026-07-24 — Shared finder engine; phone radar; "Run background services" is portal-only

**Decision:** extract the car finder's loop into `finder-engine.ts` — one GPS
watch and state, any number of `FinderRenderer`s attached (ref-counted). The
glasses become one renderer; a new phone radar (`radar.ts`, standalone-capable)
is the other. Added an honest first-run permission state (`awaiting`, +
`location-permission.ts` with a granted-once bridge-KV flag). Genesis → 1.4.0.

**Why:**
- *Phone finder:* the phone already holds the car coords and talks to the proxy;
  a radar there works glasses-off and, when both are open, renders the same walk
  from one watch. "One loop, two renderers" avoids a second GPS session and any
  mode conflict, and made the orchestration unit-testable for the first time.
- *Permission honesty:* a field walk showed the iOS prompt sitting invisible on a
  locked phone while the glasses hung on "Locating…". `awaiting` says "Unlock your
  phone to allow location access" instead; the phone walkthrough/denied screens
  carry the recovery. Detection is opportunistic `navigator.permissions` + a
  granted-once heuristic (the WebView's Permissions-API support is unverified).

**"Run background services" — ruled out as a manifest permission.** The portal
checkbox is submission metadata, not an `app.json` string: `evenhub pack`
validates against a closed six-permission enum (network, location, g2-microphone,
phone-microphone, album, camera); anything else fails packing. The only
manifest-free background lever is the SDK `setBackgroundState`/`onBackgroundRestore`
keep-alive.

**Bridge-location test build — deferred, not shipped.** SDK 0.0.10 exposes no App
Location methods, so `FINDER_BRIDGE_LOCATION=true` is behaviour-identical to
release (falls back to webkit) — an inert, misleading artifact. Left the flag but
env-gated it (`VITE_BRIDGE_LOCATION=1`) so the flip is one step *after* an SDK
0.0.11+ bump. A real locked-pocket bridge walk needs all three: SDK bump (see the
2026-07-20 revert below), the flag, and the portal toggle enabled.

**Revisit when:** the owner enables the portal toggle and decides the SDK 0.0.11+
bridge walk is worth re-opening; and on a hardware walk, confirm WebView
`navigator.permissions` behaviour and bridge-KV persistence of the granted-once
flag.

## 2026-07-20 — Bridge-location experiment closed negative; SDK back to 0.0.10

**Decision:** revert to SDK 0.0.10 and WebView geolocation as the finder's
active position source. The bridge App Location path stays in `geo.ts`
behind `FINDER_BRIDGE_LOCATION = false`. The keepalive WebSocket experiment
(also negative) is REMOVED outright: app module, backend `/ws`, and the
`wss://` whitelist entry are gone.

**Why — the walk-5 verdict, both counts:**
- *No lock benefit:* the bridge source stalled under screen lock with the
  same suspension signature as WebView geolocation (34 fixes, 2 screen-wake
  restarts). The host may run CoreLocation, but suspended JS cannot receive
  the pushes. Navigaze presumably tolerates this the same way we now do —
  or its users keep the screen on in a car mount.
- *Screen-on regression:* 1.3.3 delivered a worse fix cadence than 1.3.2's
  webkit watch, and image pushes broke — the 0.0.12 SDK LZ4-compresses
  `updateImageRawData` payloads, which the currently shipped Even app host
  evidently cannot decode. The host reports that failure in the RESOLVED
  promise value (never rejects), which also exposed that our glyph fallback
  only armed on rejection — fixed: push results are now checked and a
  non-success result arms the fallback.
- Empirical ranking across rounds: 1.3.2's configuration was best. Reverting
  reproduces it with the fixes and release features on top.

**Revisit when:** an Even app update ships (re-test LZ4 image decode and
bridge-location delivery under lock — each is one flag/one npm install).

**Also learned:** entry "Locating" was never about the car coordinates (they
seed from cached /status instantly — simulator-verified); it was the phone
fix, worsened in 1.3.3 by the bridge path's silent 20s fallback window.
WebView watch now allows `maximumAge: 60s` so an OS-cached phone fix paints
the first frame immediately, while still excluding the hours-old parked-time
fix the original `maximumAge: 0` guarded against.

## 2026-07-20 — SDK bump to 0.0.12; car finder moves to the bridge location API

**Decision:** `@evenrealities/even_hub_sdk` 0.0.10 → 0.0.12, and the finder's
position source becomes `bridge.startAppLocationUpdates` /
`onAppLocationChanged` (the Even app's own iOS location session), with
`navigator.geolocation` kept as a runtime fallback for hosts that don't
answer the bridge call.

**This reverses the earlier "do not bump the SDK" position.** The original
rationale was distrust: the claimed reason to bump was fabricated, and an
unverified dependency bump right before a hardware round was pure risk. The
new rationale is a verified, sourced capability: SDK 0.0.11 (2026-06-22)
added App Location APIs — host-side CoreLocation pushed over the bridge —
which is the only mechanism by which Navigaze (a real EvenHub plugin,
`com.gaze.app`) can do live navigation with the phone locked, given our own
hardware walks proved WebView geolocation suspends on lock. Changelog and
types confirmed in the published package; usage confirmed in public plugin
source (drrobotk/glass-car-dash).

**What changed between 0.0.10 and 0.0.12** (from the package changelog and a
type-level diff): 0.0.11 adds App Location, album/camera pickers, MIC source
selection; 0.0.12 adds `zOrderIndex` container stacking and internal LZ4
compression of `updateImageRawData` payloads ("lower image update latency" —
free win for the finder's arrow frames).

**Regression sweep** (simulator, post-bump): proto3 CLICK elision, partial
text upgrades, exit dialog flow, image pushes — all pass. Two findings:
- **`zOrderIndex` must NOT be sent**: the simulator's (and potentially older
  hosts') strict PB decoder rejects it as an unknown field and the whole
  page build dies. Do not adopt until the fleet's minimum host version is
  known to accept it.
- The sweep also surfaced a latent DEV-only recursion (fake walker's
  synchronous first fix re-entering the watch setup) — fixed; real GPS
  always delivered asynchronously, which is why no hardware walk ever hit it.

## 2026-07-14 — Hosted stateless proxy replaces bring-your-own backend

**Decision:** the app talks to a single hosted proxy at
`car-proxy.berrydev.co.uk` (our VPS). Users enter their Connected Services
credentials (username, password, PIN, region) in the app's phone settings;
they are stored only in the Even app's local storage on the phone and sent
per-request to the proxy. The proxy is stateless apart from a short-lived
in-memory session cache (10 min TTL, keyed by a SHA-256 of the credentials,
never persisted, never logged). The self-hosted Render "deploy your own
backend" flow is retired.

**Why:** the Even Hub store's `network` permission whitelist requires
exact-match domains — no wildcards, no per-user hostnames (confirmed via
community docs). A BYO backend gives every user a different Render URL, which
cannot be whitelisted, so the store model forces a fixed domain. All approved
car apps in the store use the same pattern: hosted proxy + credentials stored
locally on the phone.

**Consequences:**
- `app.json` whitelists exactly one domain: `car-proxy.berrydev.co.uk`.
- The static bearer token and env-var credentials are gone; auth is the
  Connected Services credentials themselves, per request over HTTPS.
- The proxy never writes credentials to disk or logs; a proxy restart just
  means the next request does a full login.
- Render deployment (`render.yaml`, cold-start wake logic in the app) is
  removed. Transient EU-endpoint login-rejection retries stay — that is a
  Hyundai/Kia platform quirk, not a Render one.
- Hosting: a Linux VPS running Docker Compose (Caddy for TLS + the FastAPI
  proxy, internal-only). See `deploy/README.md`.
