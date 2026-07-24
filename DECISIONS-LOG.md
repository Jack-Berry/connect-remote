# Decisions log

Significant product/architecture decisions, newest first. One entry per
decision: what changed, why, and what it rules out.

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
- Hosting: DigitalOcean VPS, Ubuntu 24.04, Docker Compose (Caddy for TLS +
  the FastAPI proxy, internal-only).
