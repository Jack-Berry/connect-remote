/** The shared finder loop.
 *
 *  Until this module existed the orchestration was untestable I/O glue in
 *  main.ts, and every regression in it cost a walk outside to find. These tests
 *  pin the behaviours those walks taught us: one GPS watch shared by both
 *  surfaces, provably stopped when the last one leaves, restarted (not resumed)
 *  on screen-wake, auto-started when the car position turns up late, terminal on
 *  arrival — and the first-run permission honesty layered on top.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Fix, LatLon } from "./finder";
import {
  FINDER_NOTE_MS,
  type FinderEngineDeps,
  type FinderFrame,
  FinderEngine,
} from "./finder-engine";
import type { PermissionProbe } from "./location-permission";
import type { PositionWatch, WatchHandlers } from "./geo";

const CAR: LatLon = { lat: 51.5072, lon: -0.1276 };

function offset(from: LatLon, bearing: number, metres: number): LatLon {
  const rad = (bearing * Math.PI) / 180;
  return {
    lat: from.lat + (metres * Math.cos(rad)) / 111_320,
    lon:
      from.lon +
      (metres * Math.sin(rad)) / (111_320 * Math.cos((from.lat * Math.PI) / 180)),
  };
}
function fixAt(pos: LatLon, at: number, extra: Partial<Fix> = {}): Fix {
  return { lat: pos.lat, lon: pos.lon, accuracy: 8, at, ...extra };
}

/** A controllable position source standing in for geo.ts. Records stop reasons
 *  and lets a test deliver fixes/problems through whatever handlers the current
 *  watch registered. Re-created on every startWatch, exactly like the real one. */
function makeSource() {
  let handlers: WatchHandlers | null = null;
  const starts: LatLon[] = [];
  const stops: string[] = [];
  const start = (h: WatchHandlers, car: LatLon | null): PositionWatch => {
    handlers = h;
    starts.push(car as LatLon);
    let stopped = false;
    return {
      stop(reason) {
        if (stopped) return;
        stopped = true;
        stops.push(reason);
      },
    };
  };
  return {
    start,
    starts,
    stops,
    fix: (f: Fix) => handlers?.onFix(f),
    problem: (p: "denied" | "unavailable" | "no-car") => handlers?.onProblem(p),
    get startCount() {
      return starts.length;
    },
  };
}

function makeRenderer() {
  const frames: FinderFrame[] = [];
  return {
    frames,
    render(f: FinderFrame) {
      frames.push(f);
    },
    get last(): FinderFrame | undefined {
      return frames[frames.length - 1];
    },
  };
}

describe("FinderEngine", () => {
  let clock: number;
  let car: LatLon | null;
  let grantedOnce: boolean;
  let permission: PermissionProbe;
  let source: ReturnType<typeof makeSource>;

  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  function makeEngine(over: Partial<FinderEngineDeps> = {}) {
    const deps: FinderEngineDeps = {
      getCar: () => car,
      getMeta: () => ({ unit: "km", parkedAt: null }),
      startWatch: source.start,
      loadGrantedOnce: async () => grantedOnce,
      saveGrantedOnce: async () => {
        grantedOnce = true;
      },
      probePermission: async () => permission,
      now: () => clock,
      onError: () => {},
      ...over,
    };
    return new FinderEngine(deps);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1000;
    car = CAR;
    grantedOnce = true; // default: an already-granted phone (no walkthrough)
    permission = "granted";
    source = makeSource();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a session and paints the first frame on the first attach", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    engine.attach(glasses);
    await flush();
    expect(glasses.frames.length).toBeGreaterThan(0);
    // Car present ⇒ the watch was started with the car position.
    expect(source.startCount).toBe(1);
    expect(engine.isRunning()).toBe(true);
  });

  it("shares one watch across two surfaces and stops it only when both leave", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    const phone = makeRenderer();
    engine.attach(glasses);
    await flush();
    expect(source.startCount).toBe(1);

    // Phone joins the SAME session — no second watch, and it gets the current
    // frame immediately.
    engine.attach(phone);
    expect(phone.frames.length).toBe(1);
    expect(source.startCount).toBe(1);

    // One leaves: watch stays up for the other.
    engine.detach(glasses);
    expect(source.stops.length).toBe(0);
    expect(engine.isRunning()).toBe(true);

    // Last one leaves: watch provably stopped.
    engine.detach(phone);
    expect(source.stops.length).toBeGreaterThan(0);
    expect(engine.isRunning()).toBe(false);
  });

  it("delivers fixes to every attached renderer", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    const phone = makeRenderer();
    engine.attach(glasses);
    engine.attach(phone);
    await flush();
    source.fix(fixAt(offset(CAR, 225, 200), clock));
    expect(glasses.last?.fix).not.toBeNull();
    expect(phone.last?.fix).not.toBeNull();
    expect(glasses.last?.distanceM).toBeCloseTo(200, -1);
  });

  it("does not ask for GPS with no car, then auto-starts when it arrives late", async () => {
    car = null;
    const engine = makeEngine();
    const glasses = makeRenderer();
    engine.attach(glasses);
    await flush();
    // No car ⇒ no watch, and the screen explains the missing position.
    expect(source.startCount).toBe(0);
    expect(glasses.last?.view.mode).toBe("problem");
    expect(glasses.last?.view.headline).toBe("Car position unknown");

    // A later status poll supplies coordinates; the next tick starts the watch.
    car = CAR;
    advance(1000);
    expect(source.startCount).toBe(1);
  });

  it("ends the walk on arrival: watch stopped, frame frozen", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    engine.attach(glasses);
    await flush();
    // Two distinct qualifying fixes 8m out (radius max(10,1.5×8)=12m).
    source.fix(fixAt(offset(CAR, 45, 8), clock));
    advance(1000);
    source.fix(fixAt(offset(CAR, 45, 8), clock));
    expect(glasses.last?.view.mode).toBe("arrived");
    expect(source.stops).toContain("arrived");

    // Terminal: the tick has stopped, so no further frames pour out.
    const n = glasses.frames.length;
    advance(3000);
    expect(glasses.frames.length).toBe(n);
  });

  it("replaces (not resumes) the watch on screen-wake and re-shows the note", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    engine.attach(glasses);
    await flush();
    // Let the entry note lapse.
    advance(FINDER_NOTE_MS + 500);
    expect(glasses.last?.noteActive).toBe(false);

    engine.pokeVisible();
    await flush();
    // Old watch stopped, a fresh one started, resumes counted, note back.
    expect(source.startCount).toBe(2);
    expect(source.stops).toContain("restart");
    expect(engine.telemetry()?.resumes).toBe(1);
    expect(glasses.last?.noteActive).toBe(true);
  });

  it("shows the keep-unlocked note on entry, then repaints past it", async () => {
    const engine = makeEngine();
    const glasses = makeRenderer();
    engine.attach(glasses);
    await flush();
    source.fix(fixAt(offset(CAR, 225, 200), clock));
    expect(glasses.last?.noteActive).toBe(true);
    advance(FINDER_NOTE_MS + 500);
    expect(glasses.last?.noteActive).toBe(false);
  });

  describe("first-run permission", () => {
    it("says 'unlock your phone' on a first run with the prompt pending", async () => {
      grantedOnce = false;
      permission = "unknown"; // Even WebView has no Permissions API
      const engine = makeEngine();
      const glasses = makeRenderer();
      engine.attach(glasses);
      await flush(); // let loadGrantedOnce resolve
      // Watch started (car present), no fix yet, never granted ⇒ awaiting.
      expect(glasses.last?.view.mode).toBe("awaiting");
      expect(glasses.last?.view.headline).toBe("Unlock your phone");
    });

    it("flows into the radar and remembers the grant on the first fix", async () => {
      grantedOnce = false;
      permission = "unknown";
      const engine = makeEngine();
      const glasses = makeRenderer();
      engine.attach(glasses);
      await flush();
      expect(glasses.last?.view.mode).toBe("awaiting");

      source.fix(fixAt(offset(CAR, 225, 200), clock));
      expect(glasses.last?.view.mode).toBe("stationary");
      expect(grantedOnce).toBe(true); // persisted for next time
    });

    it("shows plain 'Locating…' on a since-granted phone, never a false alarm", async () => {
      grantedOnce = true;
      permission = "unknown";
      const engine = makeEngine();
      const glasses = makeRenderer();
      engine.attach(glasses);
      await flush();
      // No fix yet, but granted before ⇒ honest acquiring state.
      expect(glasses.last?.view.mode).toBe("locating");
    });

    it("surfaces a hard denial as the denied problem, not awaiting", async () => {
      grantedOnce = false;
      permission = "unknown";
      const engine = makeEngine();
      const glasses = makeRenderer();
      engine.attach(glasses);
      await flush();
      source.problem("denied");
      expect(glasses.last?.view.mode).toBe("problem");
      expect(glasses.last?.view.headline).toBe("Location not allowed");
    });
  });
});
