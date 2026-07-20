# Decisions log

Significant product/architecture decisions, newest first. One entry per
decision: what changed, why, and what it rules out.

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
