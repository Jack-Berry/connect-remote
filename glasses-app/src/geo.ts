/**
 * Phone position for the car finder — the only place this app touches
 * location, from either of two sources:
 *
 *  1. `navigator.geolocation.watchPosition` — the ACTIVE source. Proven on
 *     hardware screen-on; suspends with the WebView on screen lock, which no
 *     JS-side source escapes (see below).
 *  2. The Even app's bridge App Location API (SDK 0.0.11+ hosts) — PARKED
 *     behind main.ts's FINDER_BRIDGE_LOCATION=false after the walk-5
 *     verdict: it stalled under screen lock exactly like WebView geolocation
 *     (the host may run CoreLocation, but suspended JS can't receive the
 *     pushes), and screen-on it delivered a worse fix cadence. Kept because
 *     the suspension behaviour is the HOST's choice — an Even app update
 *     could make this path win, and re-running the experiment is one flag.
 *
 * Both are wrapped so the rest of the app sees plain `Fix` objects and a
 * small set of named problems, plus which source is feeding it (telemetry).
 * Every stop path logs a line — a leaked location session drains the phone
 * in a pocket long after the user walked away (handoff §4.6).
 *
 * A DEV-only fake walker lives at the bottom: real location only works in
 * Even Hub builds (never QR sideload), so without it every finder state would
 * cost an upload-and-walk-outside cycle to look at.
 */

import type { Fix, FinderProblem, LatLon } from "./finder";

// Bridge App Location types, declared structurally rather than imported: the
// installed SDK is 0.0.10 (pre-location, deliberately — see DECISIONS-LOG
// 2026-07-20 revert entry), so these mirror the 0.0.11+ shapes for the day
// the experiment is worth re-running on a newer host.
export interface AppLocationLike {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp?: number;
}
export interface AppLocationUpdateOptions {
  /** "low" | "medium" | "high" — AppLocationAccuracy enum values. */
  accuracy?: string;
  timeoutMs?: number;
  distanceFilter?: number;
  intervalMs?: number;
}

/** Where fixes are coming from, for the debug strip and diagnostic report. */
export type PositionSource = "bridge" | "webkit" | "fake";

export interface WatchHandlers {
  onFix(fix: Fix): void;
  /** Called instead of onFix when there is no position to be had. */
  onProblem(problem: FinderProblem): void;
  /** Reports the active source; called again if a fallback switches it. */
  onSource?(source: PositionSource): void;
}

export interface PositionWatch {
  /** Idempotent. `reason` is logged — it's the audit trail for "did it stop?" */
  stop(reason: string): void;
}

/** The three bridge methods this module needs — structural, so tests can
 *  fake the host and main.ts can hand over the real EvenAppBridge as-is. */
export interface AppLocationBridge {
  startAppLocationUpdates(options?: AppLocationUpdateOptions): Promise<boolean>;
  stopAppLocationUpdates(): Promise<boolean>;
  onAppLocationChanged(
    callback: (location: AppLocationLike) => void,
  ): () => void;
}

// enableHighAccuracy: this is a walk-to-your-car aid; coarse network location
// would be worthless. maximumAge 60s: the OS's cached fix seeds the screen
// instantly at entry (a minute of walking is ≤~85m of error, corrected by the
// first live fix seconds later) while still excluding the fix cached from
// when the user PARKED — hours old, taken standing at the car, and therefore
// the one answer guaranteed to be wrong. That parked-fix hazard is why this
// was previously 0, at the cost of an every-entry "Locating…" wait.
const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 60_000,
  timeout: 30_000,
};

// High + 1 Hz, matching what the webkit path delivered. Deliberately NO
// distanceFilter: fixes must keep arriving while the user stands still, or
// the finder's stall watchdog would read stillness as a dead watch.
const BRIDGE_OPTIONS: AppLocationUpdateOptions = {
  accuracy: "high",
  intervalMs: 1000,
};

/** No bridge fix at all for this long after starting ⇒ this host's location
 *  path doesn't actually work (old Even app that defines the method but not
 *  the handler, permission quirk, …) ⇒ fall back to WebView geolocation.
 *  Shorter than the finder's 45s stall watchdog so the fallback wins the
 *  race and the watchdog never thrashes a watch that never worked. */
const BRIDGE_FIRST_FIX_TIMEOUT_MS = 20_000;

export function startPositionWatch(
  handlers: WatchHandlers,
  car: LatLon | null,
  bridge?: AppLocationBridge | null,
): PositionWatch {
  // Constant-folded away in production builds, so none of the fake walker
  // below ships in a packed .ehpk.
  if (import.meta.env.DEV && import.meta.env.VITE_FAKE_GPS) {
    handlers.onSource?.("fake");
    return startFakeWatch(handlers, car, String(import.meta.env.VITE_FAKE_GPS));
  }
  if (
    bridge &&
    typeof bridge.startAppLocationUpdates === "function" &&
    typeof bridge.stopAppLocationUpdates === "function" &&
    typeof bridge.onAppLocationChanged === "function"
  ) {
    return startBridgeWatch(handlers, bridge);
  }
  return startRealWatch(handlers);
}

/** pos.timestamp / AppLocation.timestamp is trusted only when it is plausibly
 *  "now". Embedded WebViews have shipped wrong epochs (seconds, 2001-based),
 *  and a wrong `at` silently kills the course: CourseTracker compares it
 *  against Date.now() and concludes every fix is ancient, so the arrow never
 *  appears. Arrival time is within a second of the fix time at walking pace,
 *  so it is a safe substitute. */
function saneAt(timestamp: unknown): number {
  const wallNow = Date.now();
  return typeof timestamp === "number" &&
    Math.abs(timestamp - wallNow) <= 60_000
    ? timestamp
    : wallNow;
}

/** Bridge AppLocation → Fix, or null when the coordinates are junk. Missing
 *  accuracy maps to Infinity — same honesty rule as the webkit path; if a
 *  host omits it the rejection is counted, visible, and one threshold away
 *  from a fix, rather than silently trusted. */
function fixFromAppLocation(loc: AppLocationLike): Fix | null {
  if (!Number.isFinite(loc?.latitude) || !Number.isFinite(loc?.longitude)) {
    return null;
  }
  return {
    lat: loc.latitude,
    lon: loc.longitude,
    accuracy:
      typeof loc.accuracy === "number" && loc.accuracy >= 0
        ? loc.accuracy
        : Infinity,
    at: saneAt(loc.timestamp),
    heading: typeof loc.heading === "number" ? loc.heading : null,
    speed: typeof loc.speed === "number" ? loc.speed : null,
  };
}

/**
 * Host-side location session. Failure handling is belt-and-braces because the
 * bridge has no error channel worth the name: `startAppLocationUpdates`
 * resolving false or rejecting falls back to webkit immediately, and a start
 * that "succeeds" but never delivers a fix falls back after 20s — the SDK
 * wrapper always defines these methods, so `typeof` checks cannot tell
 * whether the installed Even app actually implements them.
 */
function startBridgeWatch(
  handlers: WatchHandlers,
  bridge: AppLocationBridge,
): PositionWatch {
  let stopped = false;
  let gotFix = false;
  let fallback: PositionWatch | null = null;
  let firstFixTimer: ReturnType<typeof setTimeout> | null = null;

  handlers.onSource?.("bridge");

  const stopBridgeSide = () => {
    if (firstFixTimer) clearTimeout(firstFixTimer);
    firstFixTimer = null;
    unsubscribe();
    bridge.stopAppLocationUpdates().catch(() => undefined);
  };

  const fallBack = (why: string) => {
    if (stopped || fallback) return;
    console.log(`finder: bridge location ${why} — falling back to WebView geolocation`);
    stopBridgeSide();
    fallback = startRealWatch(handlers);
  };

  const unsubscribe = bridge.onAppLocationChanged((loc) => {
    if (stopped || fallback) return;
    const fix = fixFromAppLocation(loc);
    if (!fix) return;
    if (!gotFix) {
      gotFix = true;
      if (firstFixTimer) clearTimeout(firstFixTimer);
      firstFixTimer = null;
    }
    handlers.onFix(fix);
  });

  firstFixTimer = setTimeout(() => {
    firstFixTimer = null;
    if (!gotFix) fallBack(`delivered nothing in ${BRIDGE_FIRST_FIX_TIMEOUT_MS / 1000}s`);
  }, BRIDGE_FIRST_FIX_TIMEOUT_MS);

  bridge.startAppLocationUpdates(BRIDGE_OPTIONS).then(
    (ok) => {
      if (!ok) fallBack("refused to start");
    },
    (err) => {
      fallBack(`failed to start (${err})`);
    },
  );

  return {
    stop(reason) {
      if (stopped) return;
      stopped = true;
      if (fallback) {
        fallback.stop(reason);
        return;
      }
      stopBridgeSide();
      console.log(`finder: GPS watch stopped (${reason})`);
    },
  };
}

function startRealWatch(handlers: WatchHandlers): PositionWatch {
  handlers.onSource?.("webkit");
  if (!("geolocation" in navigator)) {
    handlers.onProblem("unavailable");
    return { stop: () => {} };
  }

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      handlers.onFix({
        lat: c.latitude,
        lon: c.longitude,
        // A platform that won't say how accurate it is gets treated as
        // useless rather than perfect — Infinity fails isUsableFix.
        accuracy: typeof c.accuracy === "number" ? c.accuracy : Infinity,
        at: saneAt(pos.timestamp),
        heading: typeof c.heading === "number" ? c.heading : null,
        speed: typeof c.speed === "number" ? c.speed : null,
      });
    },
    (err) => {
      // PERMISSION_DENIED is the only code that means "not allowed"; the other
      // two are environmental and say nothing about permission, so they must
      // not send the user into their settings app to fix a tunnel.
      handlers.onProblem(
        err.code === err.PERMISSION_DENIED ? "denied" : "unavailable",
      );
    },
    WATCH_OPTIONS,
  );

  let stopped = false;
  return {
    stop(reason) {
      if (stopped) return;
      stopped = true;
      navigator.geolocation.clearWatch(watchId);
      console.log(`finder: GPS watch stopped (${reason})`);
    },
  };
}

// ---------------------------------------------------------------------------
// DEV fake walker
//
// `VITE_FAKE_GPS=walk npm run dev` puts a scripted pedestrian on the map:
// stands still, walks off at an angle, turns towards the car, arrives. That
// covers stationary → walking → arrival without leaving the desk. Keyboard
// controls on the phone-side page take over the moment a key is pressed:
//
//   ↑ walk / stop      ← → turn 15°       c  jump to 15m from the car
//   f  jump to 400m from the car          x  toggle a GPS dropout
//
// `VITE_FAKE_GPS=denied`, `=unavailable` and `=awaiting` reproduce the failure
// and first-run-permission screens (awaiting also needs the DEV probe override
// in main.ts).

/** Where the fake car is when /status hasn't given us one (fake backend's). */
const FAKE_CAR: LatLon = { lat: 51.5072, lon: -0.1276 };
const FAKE_FIX_INTERVAL_MS = 1000;
/** Manual (keyboard) walking speed — a real pedestrian. */
const WALK_SPEED_MS = 1.4;
/** Scripted walking speed. Deliberately time-compressed: the point of the
 *  script is to reach every state in under a minute, not to be realistic. Any
 *  judgement about how the arrow *feels* has to be made on foot anyway. */
const SCRIPT_SPEED_MS = 9;

/** Metres → degrees, near enough for a few hundred metres of fake walking. */
function offsetBy(from: LatLon, bearingDeg: number, metres: number): LatLon {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / 111_320;
  const dLon =
    (metres * Math.sin(rad)) /
    (111_320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat: from.lat + dLat, lon: from.lon + dLon };
}

function bearingTo(from: LatLon, to: LatLon): number {
  const dLat = to.lat - from.lat;
  const dLon = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}

function startFakeWatch(
  handlers: WatchHandlers,
  car: LatLon | null,
  mode: string,
): PositionWatch {
  if (mode === "denied" || mode === "unavailable") {
    handlers.onProblem(mode);
    console.log(`finder: DEV fake GPS — reporting "${mode}"`);
    return { stop: (reason) => console.log(`finder: GPS watch stopped (${reason})`) };
  }

  // Delivers nothing on purpose: with the engine's probePermission forced to
  // "prompt" in DEV (main.ts), no fix + no error keeps it in the awaiting-
  // permission state, so the first-run walkthrough is inspectable without a
  // real iOS dialog.
  if (mode === "awaiting") {
    console.log('finder: DEV fake GPS — "awaiting permission" (no fixes)');
    return { stop: (reason) => console.log(`finder: GPS watch stopped (${reason})`) };
  }

  const target = car ?? FAKE_CAR;
  // Start 220m away to the south-west, so the first arrow has somewhere to
  // point and the distance has room to count down.
  let here = offsetBy(target, 225, 220);
  let heading = bearingTo(here, target) + 70; // deliberately off-target
  let walking = false;
  let dropout = false;
  let scripted = true;
  let elapsed = 0;

  const emit = () => {
    if (dropout) {
      handlers.onProblem("unavailable");
      return;
    }
    handlers.onFix({
      lat: here.lat,
      lon: here.lon,
      accuracy: 8,
      at: Date.now(),
      // The probe saw both null standing still and never got to test them
      // walking, so the fake withholds them: the derived-course path is the
      // one that has to work, and it's the one that gets exercised here.
      heading: null,
      speed: null,
    });
  };

  const tick = () => {
    elapsed += FAKE_FIX_INTERVAL_MS;
    if (scripted) {
      // 0–6s stand still · 6–18s walk off at an angle · then home in.
      walking = elapsed > 6000;
      if (elapsed > 18_000) heading = bearingTo(here, target);
    }
    if (walking) {
      const speed = scripted ? SCRIPT_SPEED_MS : WALK_SPEED_MS;
      here = offsetBy(here, heading, (speed * FAKE_FIX_INTERVAL_MS) / 1000);
    }
    emit();
  };

  const onKey = (e: KeyboardEvent) => {
    const takeOver = () => {
      if (scripted) {
        scripted = false;
        console.log("finder: DEV fake GPS — manual control");
      }
    };
    switch (e.key) {
      case "ArrowUp":
        takeOver();
        walking = !walking;
        break;
      case "ArrowLeft":
        takeOver();
        heading -= 15;
        break;
      case "ArrowRight":
        takeOver();
        heading += 15;
        break;
      case "c":
        takeOver();
        here = offsetBy(target, 40, 15);
        break;
      case "f":
        takeOver();
        here = offsetBy(target, 225, 400);
        break;
      case "x":
        takeOver();
        dropout = !dropout;
        break;
      default:
        return;
    }
    e.preventDefault();
    emit();
  };

  console.log(
    "finder: DEV fake GPS — scripted walk. ↑ walk/stop · ←→ turn · c close · f far · x dropout",
  );
  window.addEventListener("keydown", onKey);
  const timer = setInterval(tick, FAKE_FIX_INTERVAL_MS);
  // Async like every real source: a synchronous first fix re-enters the
  // finder's watch setup before it has finished (recursion, found by the
  // 1.3.3 simulator sweep). Real geolocation never delivers synchronously,
  // so the fake must not either.
  const firstEmit = setTimeout(emit, 0);

  let stopped = false;
  return {
    stop(reason) {
      if (stopped) return;
      stopped = true;
      clearTimeout(firstEmit);
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      console.log(`finder: GPS watch stopped (${reason})`);
    },
  };
}
