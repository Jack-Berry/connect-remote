// Sensor wiring. Every start* function is safe to call twice, reports its own
// failures into ProbeState rather than throwing, and hands back a stop
// function — a leaked GPS watcher drains the phone in the user's pocket, so
// the probe practises the discipline the finder will need.

import type { MotionState, OrientationState, ProbeState } from "./probe";

// iOS 13+ gates both event families behind a static requestPermission() that
// must be called from a user-gesture handler. Neither is in lib.dom.
type PermissionState = "granted" | "denied" | "prompt" | "default";
interface PermissionGate {
  requestPermission?: () => Promise<PermissionState>;
}

// If a permission resolves faster than this, no dialog can plausibly have
// been drawn and dismissed — record it as evidence for NO-PROMPT. The user's
// own observation is the authority; this is corroboration.
const PROMPT_FLOOR_MS = 400;

// How long to wait for the first event after permission is granted before
// calling it NO-EVENTS. iOS delivers orientation within a frame or two when
// it works at all; 3s is generous.
const EVENT_WATCHDOG_MS = 3000;

// Rolling window for the update-rate measurement.
const HZ_WINDOW_MS = 2000;

function gate(ctor: unknown): PermissionGate | null {
  return typeof ctor === "function" || typeof ctor === "object"
    ? (ctor as PermissionGate)
    : null;
}

// Tracks event arrival times to derive Hz over a short rolling window.
class RateMeter {
  private stamps: number[] = [];

  tick(now: number): number | null {
    this.stamps.push(now);
    while (this.stamps.length && now - this.stamps[0] > HZ_WINDOW_MS) {
      this.stamps.shift();
    }
    if (this.stamps.length < 2) return null;
    const span = now - this.stamps[0];
    return span > 0 ? ((this.stamps.length - 1) * 1000) / span : null;
  }
}

// ---------------------------------------------------------------------------
// Geolocation

export function startGeolocation(
  state: ProbeState,
  onChange: () => void,
): () => void {
  const g = state.geo;

  if (!("geolocation" in navigator)) {
    g.verdict = "NOT-SUPPORTED";
    g.detail = "navigator.geolocation is undefined in this WebView";
    onChange();
    return () => {};
  }

  g.verdict = "REQUESTING";
  g.detail = "watchPosition started — waiting for first fix";
  g.fixes = 0;
  onChange();

  const started = performance.now();
  const meter = new RateMeter();
  let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    watchdog = null;
    // Still nothing after 20s: on iOS a permission dialog that was never
    // answered looks exactly like this, which is itself the finding.
    if (g.fixes === 0 && g.verdict === "REQUESTING") {
      g.verdict = "NO-EVENTS";
      g.detail =
        "no fix and no error after 20s — prompt unanswered, or GPS never resolved";
      onChange();
    }
  }, 20_000);

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = performance.now();
      const c = pos.coords;
      if (g.fixes === 0) g.firstFixMs = Math.round(now - started);
      g.gapMs = g.lastFixAt === null ? null : Math.round(now - g.lastFixAt);
      g.lastFixAt = now;
      g.fixes++;
      g.latitude = c.latitude;
      g.longitude = c.longitude;
      g.accuracy = c.accuracy;
      g.altitude = c.altitude;
      g.altitudeAccuracy = c.altitudeAccuracy;
      g.heading = c.heading;
      g.speed = c.speed;
      g.verdict = "OK";
      g.detail =
        g.fixes === 1
          ? `first fix in ${g.firstFixMs}ms`
          : `${g.fixes} fixes, updating`;
      meter.tick(now);
      onChange();
    },
    (err) => {
      // PERMISSION_DENIED (1) is the only one that means the user (or the
      // WebView policy) said no. POSITION_UNAVAILABLE and TIMEOUT are
      // environmental and say nothing about permission.
      g.verdict = err.code === err.PERMISSION_DENIED ? "DENIED" : "ERROR";
      g.detail = `code ${err.code}: ${err.message || "(no message)"}`;
      onChange();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );

  return () => {
    if (watchdog) clearTimeout(watchdog);
    navigator.geolocation.clearWatch(watchId);
  };
}

// ---------------------------------------------------------------------------
// Shared permission request

async function requestGate(
  ctor: unknown,
  target: OrientationState | MotionState,
  label: string,
): Promise<boolean> {
  const g = gate(ctor);
  if (!g) {
    target.verdict = "NOT-SUPPORTED";
    target.detail = `${label} is undefined in this WebView`;
    return false;
  }

  // No requestPermission at all: Android, older iOS, or a WebView that does
  // not gate the sensors. Not a failure — listen and see if events arrive.
  if (typeof g.requestPermission !== "function") {
    target.permission = "n/a";
    target.detail = `${label}.requestPermission is not a function — no gate on this platform; listening directly`;
    return true;
  }

  const started = performance.now();
  try {
    const result = await g.requestPermission();
    target.requestMs = Math.round(performance.now() - started);
    target.permission = result;
    if (result !== "granted") {
      target.verdict = "DENIED";
      target.detail = `requestPermission() returned "${result}" after ${target.requestMs}ms`;
      return false;
    }
    target.detail =
      target.requestMs < PROMPT_FLOOR_MS
        ? `granted in ${target.requestMs}ms — too fast for a dialog; already granted or auto-granted`
        : `granted after ${target.requestMs}ms — a dialog was almost certainly shown`;
    return true;
  } catch (err) {
    target.requestMs = Math.round(performance.now() - started);
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    // NotAllowedError here almost always means the call did not originate
    // from a user gesture — a probe bug, not a platform verdict. Say so
    // rather than recording a false DENIED.
    target.verdict = name === "NotAllowedError" ? "NO-PROMPT" : "ERROR";
    target.detail =
      name === "NotAllowedError"
        ? `${name}: ${message} — rejected without prompting (needs a user gesture, or the WebView blocks it)`
        : `${name}: ${message}`;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orientation / compass — the headline unknown

export async function startOrientation(
  state: ProbeState,
  onChange: () => void,
): Promise<() => void> {
  const o = state.orientation;
  o.verdict = "REQUESTING";
  o.detail = "requesting permission…";
  onChange();

  const ok = await requestGate(
    (globalThis as Record<string, unknown>).DeviceOrientationEvent,
    o,
    "DeviceOrientationEvent",
  );
  onChange();
  if (!ok) return () => {};

  const meter = new RateMeter();
  const handler = (raw: Event) => {
    const e = raw as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    const now = performance.now();
    o.events++;
    o.hz = meter.tick(now);
    o.alpha = e.alpha;
    o.beta = e.beta;
    o.gamma = e.gamma;
    o.absolute = e.absolute ?? null;
    // The field being present but null/undefined is a meaningfully different
    // answer from the field not existing at all — track both.
    o.hasCompassField = "webkitCompassHeading" in e;
    o.compassHeading =
      typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : null;
    o.compassAccuracy =
      typeof e.webkitCompassAccuracy === "number"
        ? e.webkitCompassAccuracy
        : null;
    if (o.verdict !== "OK") {
      o.verdict = "OK";
      const how =
        o.compassHeading !== null
          ? "absolute compass heading available"
          : o.absolute
            ? "absolute orientation, no webkitCompassHeading"
            : "relative orientation only — no absolute north";
      o.detail = `${o.detail} | events flowing: ${how}`;
    }
    onChange();
  };

  // deviceorientationabsolute is the Android route to true north; plain
  // deviceorientation is iOS's (with webkitCompassHeading bolted on).
  window.addEventListener("deviceorientation", handler);
  window.addEventListener("deviceorientationabsolute", handler);

  const watchdog = setTimeout(() => {
    if (o.events === 0) {
      o.verdict = "NO-EVENTS";
      o.detail = `${o.detail} | permission resolved but no deviceorientation event in ${EVENT_WATCHDOG_MS}ms`;
      onChange();
    }
  }, EVENT_WATCHDOG_MS);

  return () => {
    clearTimeout(watchdog);
    window.removeEventListener("deviceorientation", handler);
    window.removeEventListener("deviceorientationabsolute", handler);
  };
}

// ---------------------------------------------------------------------------
// Motion — free answer to the tilt-controller question

export async function startMotion(
  state: ProbeState,
  onChange: () => void,
): Promise<() => void> {
  const m = state.motion;
  m.verdict = "REQUESTING";
  m.detail = "requesting permission…";
  onChange();

  const ok = await requestGate(
    (globalThis as Record<string, unknown>).DeviceMotionEvent,
    m,
    "DeviceMotionEvent",
  );
  onChange();
  if (!ok) return () => {};

  const meter = new RateMeter();
  const handler = (e: DeviceMotionEvent) => {
    const now = performance.now();
    m.events++;
    m.hz = meter.tick(now);
    m.interval = e.interval ?? null;
    m.ax = e.acceleration?.x ?? null;
    m.ay = e.acceleration?.y ?? null;
    m.az = e.acceleration?.z ?? null;
    m.gx = e.accelerationIncludingGravity?.x ?? null;
    m.gy = e.accelerationIncludingGravity?.y ?? null;
    m.gz = e.accelerationIncludingGravity?.z ?? null;
    m.rateAlpha = e.rotationRate?.alpha ?? null;
    m.rateBeta = e.rotationRate?.beta ?? null;
    m.rateGamma = e.rotationRate?.gamma ?? null;
    if (m.verdict !== "OK") {
      m.verdict = "OK";
      const linear =
        m.ax !== null
          ? "gravity-free acceleration present"
          : "only accelerationIncludingGravity — no linear acceleration";
      m.detail = `${m.detail} | events flowing: ${linear}`;
    }
    onChange();
  };

  window.addEventListener("devicemotion", handler);

  const watchdog = setTimeout(() => {
    if (m.events === 0) {
      m.verdict = "NO-EVENTS";
      m.detail = `${m.detail} | permission resolved but no devicemotion event in ${EVENT_WATCHDOG_MS}ms`;
      onChange();
    }
  }, EVENT_WATCHDOG_MS);

  return () => {
    clearTimeout(watchdog);
    window.removeEventListener("devicemotion", handler);
  };
}
