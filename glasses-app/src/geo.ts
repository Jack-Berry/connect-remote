/**
 * Phone position for the car finder — the only place this app touches
 * geolocation.
 *
 * Two responsibilities:
 *  1. Wrap `navigator.geolocation.watchPosition` so the rest of the app sees
 *     plain `Fix` objects and a small set of named problems.
 *  2. Guarantee the watch can be stopped, loudly. A leaked GPS watch drains
 *     the user's phone in their pocket long after they've walked away, so
 *     every stop path logs a line and every caller has exactly one function
 *     to call. (Handoff §4.6 — the log line is the proof.)
 *
 * A DEV-only fake walker lives at the bottom: real geolocation only works in
 * Even Hub builds (never QR sideload), so without it every finder state would
 * cost an upload-and-walk-outside cycle to look at.
 */

import type { Fix, FinderProblem, LatLon } from "./finder";

export interface WatchHandlers {
  onFix(fix: Fix): void;
  /** Called instead of onFix when there is no position to be had. */
  onProblem(problem: FinderProblem): void;
}

export interface PositionWatch {
  /** Idempotent. `reason` is logged — it's the audit trail for "did it stop?" */
  stop(reason: string): void;
}

// enableHighAccuracy: this is a walk-to-your-car aid; coarse network location
// would be worthless. maximumAge 0: a cached fix from when the user parked is
// the one answer guaranteed to be wrong.
const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 30_000,
};

export function startPositionWatch(
  handlers: WatchHandlers,
  car: LatLon | null,
): PositionWatch {
  // Constant-folded away in production builds, so none of the fake walker
  // below ships in a packed .ehpk.
  if (import.meta.env.DEV && import.meta.env.VITE_FAKE_GPS) {
    return startFakeWatch(handlers, car, String(import.meta.env.VITE_FAKE_GPS));
  }
  return startRealWatch(handlers);
}

function startRealWatch(handlers: WatchHandlers): PositionWatch {
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
        at: pos.timestamp || Date.now(),
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
// `VITE_FAKE_GPS=denied` and `=unavailable` reproduce the two failure screens.

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
  emit();

  let stopped = false;
  return {
    stop(reason) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      console.log(`finder: GPS watch stopped (${reason})`);
    },
  };
}
