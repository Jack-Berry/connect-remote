/**
 * The finder against a REAL-geolocation-shaped stream — the test the Genesis
 * 1.3.0 hardware walk showed was missing.
 *
 * The DEV fake walker injects fixes at the startPositionWatch seam, so it
 * proves the state machine while silently skipping the production path:
 * navigator.geolocation → startRealWatch → createFinderWatch → CourseTracker
 * → finderView. These tests drive that exact chain with a stubbed
 * navigator.geolocation delivering what real hardware delivers — async
 * callbacks off timers, jittery 5–35m accuracies, null heading/speed, and
 * (in one test) a broken timestamp epoch. The DEV walker cannot green-light
 * this class of bug again because nothing here uses it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ArrivalProgress,
  CourseTracker,
  type Fix,
  type FinderProblem,
  type LatLon,
  finderView,
} from "./finder";
import {
  STALL_RESTART_MS,
  createFinderTelemetry,
  createFinderWatch,
} from "./finder-watch";
import { type WatchHandlers, startPositionWatch } from "./geo";

const CAR: LatLon = { lat: 51.5072, lon: -0.1276 };

function offset(from: LatLon, bearingDeg: number, metres: number): LatLon {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    lat: from.lat + (metres * Math.cos(rad)) / 111_320,
    lon:
      from.lon +
      (metres * Math.sin(rad)) /
        (111_320 * Math.cos((from.lat * Math.PI) / 180)),
  };
}

/**
 * navigator.geolocation with the surface startRealWatch uses. Fixes are
 * emitted from fake-timer callbacks, so delivery is asynchronous relative to
 * the code under test — the same shape as WebKit's delivery.
 */
class FakeGeolocation {
  success: PositionCallback | null = null;
  error: PositionErrorCallback | null = null;
  watchCalls = 0;
  cleared: number[] = [];

  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
  ): number {
    this.watchCalls++;
    this.success = success;
    this.error = error ?? null;
    return this.watchCalls;
  }

  clearWatch(id: number): void {
    this.cleared.push(id);
    this.success = null;
    this.error = null;
  }

  emit(
    pos: LatLon,
    accuracy: number,
    extra: { timestamp?: number; heading?: number | null; speed?: number | null } = {},
  ): void {
    this.success?.({
      coords: {
        latitude: pos.lat,
        longitude: pos.lon,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: extra.heading ?? null,
        speed: extra.speed ?? null,
      },
      timestamp: extra.timestamp ?? Date.now(),
    } as GeolocationPosition);
  }

  emitError(code: number, message = ""): void {
    this.error?.({
      code,
      message,
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError);
  }
}

let geo: FakeGeolocation;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
  geo = new FakeGeolocation();
  vi.stubGlobal("navigator", { geolocation: geo });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Everything main.ts keeps per fix, minus the bridge. */
function finderHarness() {
  const course = new CourseTracker();
  const state = {
    fix: null as Fix | null,
    problem: null as FinderProblem | null,
    octant: null as number | null,
    arrival: null as ArrivalProgress | null,
  };
  const frames: { mode: string; headline: string }[] = [];
  const handlers: WatchHandlers = {
    onFix(fix) {
      state.problem = null;
      state.fix = fix;
      course.push(fix);
      render();
    },
    onProblem(problem) {
      state.problem = problem;
      render();
    },
  };
  function render() {
    const v = finderView({
      car: CAR,
      fix: state.fix,
      course: course.course(Date.now()),
      now: Date.now(),
      unit: "km",
      prevOctant: state.octant,
      arrival: state.arrival,
      problem: state.problem,
    });
    state.octant = v.octant;
    state.arrival = v.arrival;
    frames.push({ mode: v.mode, headline: v.headline });
  }
  return { handlers, frames };
}

describe("finder against a real-geolocation-shaped stream", () => {
  it("consumes a two-minute walk end to end: stationary → walking → arrived", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    // Default `start` = the production startPositionWatch. VITE_FAKE_GPS is
    // unset under vitest, so this exercises startRealWatch for real.
    const watch = createFinderWatch(handlers, CAR, telemetry);
    expect(geo.watchCalls).toBe(1);

    // 150m out, walking at 1.4 m/s straight at the car, one fix per second,
    // deterministic accuracy jitter between 6 and 22m, heading/speed null —
    // what the Stage 0 probe saw from the real platform.
    const fixCount = 110;
    for (let i = 0; i < fixCount; i++) {
      setTimeout(
        () => {
          const along = Math.min(150, 1.4 * (i + 1));
          const jitter = 14 + 8 * Math.sin(i * 2.399);
          geo.emit(offset(CAR, 180, 150 - along), jitter);
          watch.poke(Date.now());
        },
        (i + 1) * 1000,
      );
    }
    await vi.advanceTimersByTimeAsync(fixCount * 1000 + 500);

    expect(telemetry.rawFixes).toBe(fixCount);
    expect(telemetry.usableFixes).toBe(fixCount);
    // The watchdog must never fire while fixes are flowing.
    expect(telemetry.restarts).toBe(0);
    expect(geo.watchCalls).toBe(1);

    const modes = frames.map((f) => f.mode);
    // First fix: no course yet, so absolute text.
    expect(modes[0]).toBe("stationary");
    // A travel course forms once there's ≥12m of baseline — the arrow state.
    expect(modes).toContain("walking");
    // 150m at 1.4 m/s crosses the 22m arrival radius well inside the walk.
    expect(modes).toContain("arrived");
    // The screen must actually count down, not freeze at the first reading —
    // the 1.3.0 failure. Distinct headlines ⇒ repeated real updates.
    const headlines = new Set(frames.map((f) => f.headline));
    expect(headlines.size).toBeGreaterThan(5);
    expect(frames[0].headline).toMatch(/^Car: 150m/);

    watch.stop("test done");
    expect(geo.cleared).toHaveLength(1);
  });

  it("keeps updating the distance on mediocre urban accuracy without inventing a course", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    // 40–60m accuracy: too vague for a course (>35m), plenty for a distance
    // (<100m). The multi-storey scenario the feature exists for.
    for (let i = 0; i < 30; i++) {
      setTimeout(
        () => geo.emit(offset(CAR, 180, 150 - i * 1.4), 40 + (i % 3) * 10),
        (i + 1) * 1000,
      );
    }
    await vi.advanceTimersByTimeAsync(31_000);

    expect(telemetry.usableFixes).toBe(30);
    expect(frames.every((f) => f.mode === "stationary")).toBe(true);
    expect(new Set(frames.map((f) => f.headline)).size).toBeGreaterThan(1);
    watch.stop("test done");
  });

  it("survives a platform timestamp in the wrong epoch: course still forms", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    // pos.timestamp in seconds instead of milliseconds — the classic embedded
    // WebView quirk. Untreated, CourseTracker would see every fix as aeons
    // old and the arrow would never appear (while the distance still updated,
    // masking the bug on a quick glance).
    for (let i = 0; i < 40; i++) {
      setTimeout(
        () =>
          geo.emit(offset(CAR, 180, 150 - i * 1.4), 8, {
            timestamp: Math.floor(Date.now() / 1000),
          }),
        (i + 1) * 1000,
      );
    }
    await vi.advanceTimersByTimeAsync(41_000);

    expect(frames.map((f) => f.mode)).toContain("walking");
    watch.stop("test done");
  });

  it("counts rejected fixes instead of silently dropping them", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    setTimeout(() => geo.emit(offset(CAR, 180, 150), 250), 1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(telemetry.rawFixes).toBe(1);
    expect(telemetry.usableFixes).toBe(0);
    expect(telemetry.lastRejectedAccuracy).toBe(250);
    expect(frames).toHaveLength(0); // never reached the finder
    watch.stop("test done");
  });

  it("maps geolocation errors to problems and counts them", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    setTimeout(() => geo.emitError(3, "timeout"), 1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(telemetry.problems).toBe(1);
    expect(telemetry.lastProblem).toBe("unavailable");
    expect(frames.at(-1)?.mode).toBe("problem");
    watch.stop("test done");
  });
});

describe("stall watchdog", () => {
  it("replaces a watch that stops delivering without an error", async () => {
    const { handlers, frames } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    // Three good fixes, then total silence — the 1.3.0 signature.
    for (let i = 0; i < 3; i++) {
      setTimeout(() => geo.emit(offset(CAR, 180, 150 - i), 10), (i + 1) * 1000);
    }
    await vi.advanceTimersByTimeAsync(3500);
    expect(telemetry.usableFixes).toBe(3);

    // Just inside the stall window: leave the watch alone.
    await vi.advanceTimersByTimeAsync(STALL_RESTART_MS - 2000);
    watch.poke(Date.now());
    expect(telemetry.restarts).toBe(0);
    expect(geo.watchCalls).toBe(1);

    // Past it: the old watch is cleared and a fresh one started.
    await vi.advanceTimersByTimeAsync(4000);
    watch.poke(Date.now());
    expect(telemetry.restarts).toBe(1);
    expect(geo.cleared).toHaveLength(1);
    expect(geo.watchCalls).toBe(2);

    // The replacement is live: new fixes flow again.
    setTimeout(() => geo.emit(offset(CAR, 180, 100), 10), 1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(telemetry.usableFixes).toBe(4);
    expect(frames.at(-1)?.mode).not.toBe("problem");

    watch.stop("test done");
    expect(geo.cleared).toHaveLength(2);
  });

  it("leaves an alive-but-erroring watch alone", async () => {
    const { handlers } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);

    // TIMEOUT errors every 30s (the platform's own cadence with our watch
    // options) prove the watch is alive; restarting it would help nothing.
    for (let i = 0; i < 4; i++) {
      setTimeout(() => geo.emitError(3, "timeout"), (i + 1) * 30_000);
    }
    for (let i = 0; i < 120; i++) {
      setTimeout(() => watch.poke(Date.now()), (i + 1) * 1000);
    }
    await vi.advanceTimersByTimeAsync(121_000);

    expect(telemetry.problems).toBe(4);
    expect(telemetry.restarts).toBe(0);
    expect(geo.watchCalls).toBe(1);
    watch.stop("test done");
  });

  it("does nothing after stop", async () => {
    const { handlers } = finderHarness();
    const telemetry = createFinderTelemetry(Date.now());
    const watch = createFinderWatch(handlers, CAR, telemetry);
    watch.stop("test done");
    watch.stop("again"); // idempotent
    await vi.advanceTimersByTimeAsync(STALL_RESTART_MS * 2);
    watch.poke(Date.now());
    expect(telemetry.restarts).toBe(0);
    expect(geo.watchCalls).toBe(1);
    expect(geo.cleared).toHaveLength(1);
  });
});

describe("startPositionWatch production shape", () => {
  it("reports 'unavailable' when the WebView has no geolocation at all", () => {
    vi.stubGlobal("navigator", {});
    const problems: FinderProblem[] = [];
    const watch = startPositionWatch(
      { onFix: () => {}, onProblem: (p) => problems.push(p) },
      CAR,
    );
    expect(problems).toEqual(["unavailable"]);
    watch.stop("test done"); // must not throw
  });

  it("maps PERMISSION_DENIED to 'denied' and everything else to 'unavailable'", async () => {
    const problems: FinderProblem[] = [];
    const watch = startPositionWatch(
      { onFix: () => {}, onProblem: (p) => problems.push(p) },
      CAR,
    );
    geo.emitError(1, "denied by user");
    geo.emitError(2, "position unavailable");
    expect(problems).toEqual(["denied", "unavailable"]);
    watch.stop("test done");
  });
});

// ---------------------------------------------------------------------------
// Bridge App Location source (Round 4): the Navigaze path. geo.ts must prefer
// the host's location session, map AppLocation → Fix faithfully, and fall
// back to WebView geolocation on hosts where the bridge is a dead letter.

import type { AppLocationBridge } from "./geo";

class FakeLocationBridge implements AppLocationBridge {
  cb: ((loc: never) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  unsubscribes = 0;
  startResult: () => Promise<boolean> = () => Promise.resolve(true);

  startAppLocationUpdates(): Promise<boolean> {
    this.startCalls++;
    return this.startResult();
  }
  stopAppLocationUpdates(): Promise<boolean> {
    this.stopCalls++;
    return Promise.resolve(true);
  }
  onAppLocationChanged(cb: (loc: never) => void): () => void {
    this.cb = cb as never;
    return () => {
      this.unsubscribes++;
      this.cb = null;
    };
  }
  emit(loc: Record<string, unknown>): void {
    (this.cb as unknown as ((l: unknown) => void) | null)?.(loc);
  }
}

function bridgeWatch(host: FakeLocationBridge) {
  const { handlers, frames } = finderHarness();
  const telemetry = createFinderTelemetry(Date.now());
  const watch = createFinderWatch(handlers, CAR, telemetry, (h, c) =>
    startPositionWatch(h, c, host),
  );
  return { watch, telemetry, frames };
}

describe("bridge location source", () => {
  it("prefers the bridge and maps AppLocation into Fix (heading/speed included)", async () => {
    const host = new FakeLocationBridge();
    const { watch, telemetry, frames } = bridgeWatch(host);
    expect(telemetry.source).toBe("bridge");
    expect(host.startCalls).toBe(1);
    expect(geo.watchCalls).toBe(0); // webkit untouched

    const here = offset(CAR, 180, 150);
    host.emit({
      latitude: here.lat,
      longitude: here.lon,
      accuracy: 7,
      speed: 1.4,
      heading: 0, // walking due north, straight at the car
      timestamp: Date.now(),
    });
    expect(telemetry.usableFixes).toBe(1);
    // Device heading + speed above the gate ⇒ instant course ⇒ walking mode
    // on the very first fix — the opportunistic upgrade the bridge enables.
    expect(frames.at(-1)?.mode).toBe("walking");

    watch.stop("test done");
    expect(host.unsubscribes).toBe(1);
    expect(host.stopCalls).toBe(1);
  });

  it("treats missing accuracy as Infinity and counts the rejection", async () => {
    const host = new FakeLocationBridge();
    const { watch, telemetry } = bridgeWatch(host);
    const here = offset(CAR, 180, 150);
    host.emit({ latitude: here.lat, longitude: here.lon, timestamp: Date.now() });
    expect(telemetry.rawFixes).toBe(1);
    expect(telemetry.usableFixes).toBe(0);
    expect(telemetry.lastRejectedAccuracy).toBe(Infinity);
    watch.stop("test done");
  });

  it("sanitises a wrong-epoch bridge timestamp", async () => {
    const host = new FakeLocationBridge();
    const { watch, frames } = bridgeWatch(host);
    // Seconds epoch + walking fixes: course must still form.
    for (let i = 0; i < 40; i++) {
      const p = offset(CAR, 180, 150 - i * 1.4);
      host.emit({
        latitude: p.lat,
        longitude: p.lon,
        accuracy: 8,
        timestamp: Math.floor(Date.now() / 1000),
      });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(frames.map((f) => f.mode)).toContain("walking");
    watch.stop("test done");
  });

  it("ignores junk coordinates without crashing", async () => {
    const host = new FakeLocationBridge();
    const { watch, telemetry } = bridgeWatch(host);
    host.emit({ latitude: NaN, longitude: -0.12, accuracy: 5 });
    host.emit({});
    expect(telemetry.rawFixes).toBe(0);
    watch.stop("test done");
  });

  it("falls back to webkit when the host refuses to start", async () => {
    const host = new FakeLocationBridge();
    host.startResult = () => Promise.resolve(false);
    const { watch, telemetry } = bridgeWatch(host);
    await vi.advanceTimersByTimeAsync(0); // let the start promise settle
    expect(telemetry.source).toBe("webkit");
    expect(host.unsubscribes).toBe(1);
    expect(host.stopCalls).toBe(1); // bridge side torn down
    expect(geo.watchCalls).toBe(1); // webkit watch took over

    geo.emit(offset(CAR, 180, 100), 10);
    expect(telemetry.usableFixes).toBe(1);
    watch.stop("test done");
    expect(geo.cleared).toHaveLength(1); // stop reaches the fallback watch
  });

  it("falls back to webkit when the start call rejects", async () => {
    const host = new FakeLocationBridge();
    host.startResult = () => Promise.reject(new Error("Flutter handler not available"));
    const { watch, telemetry } = bridgeWatch(host);
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetry.source).toBe("webkit");
    expect(geo.watchCalls).toBe(1);
    watch.stop("test done");
  });

  it("falls back to webkit when the bridge starts but never delivers", async () => {
    const host = new FakeLocationBridge();
    const { watch, telemetry } = bridgeWatch(host);
    expect(telemetry.source).toBe("bridge");
    // 20s of silence: the host said yes and did nothing (old app that
    // half-implements the handler). Must not wait for the 45s watchdog.
    await vi.advanceTimersByTimeAsync(20_500);
    expect(telemetry.source).toBe("webkit");
    expect(geo.watchCalls).toBe(1);

    geo.emit(offset(CAR, 180, 100), 10);
    expect(telemetry.usableFixes).toBe(1);
    watch.stop("test done");
  });

  it("does not fall back while bridge fixes are flowing", async () => {
    const host = new FakeLocationBridge();
    const { watch, telemetry } = bridgeWatch(host);
    for (let i = 0; i < 60; i++) {
      const p = offset(CAR, 180, 150 - i);
      host.emit({ latitude: p.lat, longitude: p.lon, accuracy: 8, timestamp: Date.now() });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(telemetry.source).toBe("bridge");
    expect(telemetry.usableFixes).toBe(60);
    expect(geo.watchCalls).toBe(0);
    watch.stop("test done");
  });
});
