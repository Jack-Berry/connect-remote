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
      problem: state.problem,
    });
    state.octant = v.octant;
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
// Keepalive socket (Round 3 spike): the socket's only job is existing, so the
// whole contract is lifecycle — open, survive drops with backoff, stop dead.

import {
  type SocketLike,
  createSocketTelemetry,
  openKeepaliveSocket,
} from "./finder-socket";

class FakeWebSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  drop(code: number): void {
    this.onclose?.({ code });
  }
}

function socketFactory() {
  const sockets: FakeWebSocket[] = [];
  const make = () => {
    const s = new FakeWebSocket();
    sockets.push(s);
    return s;
  };
  return { sockets, make };
}

describe("keepalive socket lifecycle", () => {
  it("opens, drops, backs off, reconnects — and counts all of it", async () => {
    const { sockets, make } = socketFactory();
    const telemetry = createSocketTelemetry();
    const socket = openKeepaliveSocket("wss://example/ws", telemetry, make);

    expect(sockets).toHaveLength(1);
    expect(telemetry.state).toBe("connecting");
    sockets[0].open();
    expect(telemetry.state).toBe("open");
    expect(telemetry.opens).toBe(1);

    // Network drop: closed, one reconnect scheduled 5s out.
    sockets[0].drop(1006);
    expect(telemetry.state).toBe("closed");
    expect(telemetry.lastCloseCode).toBe(1006);
    expect(telemetry.reconnects).toBe(1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);

    // Recovery resets the backoff ladder.
    sockets[1].open();
    expect(telemetry.opens).toBe(2);
    expect(telemetry.state).toBe("open");

    socket.stop("test done");
  });

  it("escalates the backoff on consecutive failures and never gives up", async () => {
    const { sockets, make } = socketFactory();
    const telemetry = createSocketTelemetry();
    const socket = openKeepaliveSocket("wss://example/ws", telemetry, make);

    // Fail every attempt without ever opening: delays 5, 10, 20, 30, 30…
    const expectAfter = async (ms: number, count: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      expect(sockets).toHaveLength(count);
    };
    sockets[0].drop(1006);
    await expectAfter(5_000, 2);
    sockets[1].drop(1006);
    await expectAfter(10_000, 3);
    sockets[2].drop(1006);
    await expectAfter(20_000, 4);
    sockets[3].drop(1006);
    await expectAfter(30_000, 5);
    sockets[4].drop(1006);
    await expectAfter(30_000, 6); // capped, still trying
    expect(telemetry.reconnects).toBe(5);

    socket.stop("test done");
  });

  it("stop closes the socket, cancels the retry, and ignores the echo", async () => {
    const { sockets, make } = socketFactory();
    const telemetry = createSocketTelemetry();
    const socket = openKeepaliveSocket("wss://example/ws", telemetry, make);
    sockets[0].open();

    socket.stop("finder exit");
    socket.stop("again"); // idempotent
    expect(sockets[0].closed).toBe(true);
    expect(telemetry.state).toBe("stopped");

    // The close event caused by our own close() must not count as a drop,
    // and no reconnect may ever fire again.
    sockets[0].drop(1000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(telemetry.reconnects).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("treats a constructor throw as a drop and retries", async () => {
    const { sockets, make } = socketFactory();
    let failFirst = true;
    const flaky = () => {
      if (failFirst) {
        failFirst = false;
        throw new Error("blocked scheme");
      }
      return make();
    };
    const telemetry = createSocketTelemetry();
    const socket = openKeepaliveSocket("wss://example/ws", telemetry, flaky);

    expect(telemetry.state).toBe("closed");
    expect(telemetry.reconnects).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(telemetry.state).toBe("open");

    socket.stop("test done");
  });
});

// ---------------------------------------------------------------------------
// Image direction indicator: frame selection, no-op skipping, and the live
// glyph fallback when the host rejects a push (the unverified-over-BLE case).

import type { ArrowFrames } from "./arrow-frames";
import { createImageIndicator } from "./direction";
import { ARROWS } from "./finder";

function stubFrames(): ArrowFrames {
  return {
    // Tag frames so a test can read back exactly what was pushed:
    // [octant|98=ring, dim] and [255] for blank.
    get: (octant, dim) => [octant ?? 98, dim ? 1 : 0],
    blank: () => [255],
    renderMs: 0,
  };
}

function indicatorHarness(opts: { failPushes?: boolean; failRender?: boolean } = {}) {
  const pushes: number[][] = [];
  const glyphs: string[] = [];
  const indicator = createImageIndicator(
    async (_ids, data) => {
      if (opts.failPushes) throw new Error("host rejected image");
      pushes.push(data);
    },
    async (_ids, content) => {
      glyphs.push(content);
    },
    () => {
      if (opts.failRender) throw new Error("no canvas");
      return stubFrames();
    },
  );
  return { indicator, pushes, glyphs };
}

describe("image direction indicator", () => {
  it("pushes on change only, and encodes ring/dim/blank states", async () => {
    const { indicator, pushes } = indicatorHarness();
    indicator.prepare?.();

    await indicator.update(null, { ring: true, dim: false }); // locating: ring
    await indicator.update(null, { ring: true, dim: false }); // no-op
    expect(pushes).toEqual([[98, 0]]);

    await indicator.update(2, { ring: true, dim: false }); // walking east
    await indicator.update(2, { ring: true, dim: false }); // no-op
    expect(pushes).toEqual([[98, 0], [2, 0]]);

    await indicator.update(2, { ring: true, dim: true }); // stale → dim
    expect(pushes.at(-1)).toEqual([2, 1]);

    await indicator.update(null, { ring: false, dim: false }); // problem → blank
    expect(pushes.at(-1)).toEqual([255]);
  });

  it("re-pushes after reset (page rebuilt underneath)", async () => {
    const { indicator, pushes } = indicatorHarness();
    indicator.prepare?.();
    await indicator.update(3, { ring: true, dim: false });
    indicator.reset();
    await indicator.update(3, { ring: true, dim: false });
    expect(pushes).toEqual([[3, 0], [3, 0]]);
  });

  it("falls back to the glyph cell when the host rejects a push", async () => {
    const { indicator, pushes, glyphs } = indicatorHarness({ failPushes: true });
    indicator.prepare?.();

    await indicator.update(4, { ring: true, dim: false });
    expect(pushes).toHaveLength(0);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toContain(ARROWS[4]); // ↓

    // Fallback keeps diffing like the real glyph renderer.
    await indicator.update(4, { ring: true, dim: false });
    expect(glyphs).toHaveLength(1);
    await indicator.update(6, { ring: true, dim: false });
    expect(glyphs).toHaveLength(2);
    expect(glyphs[1]).toContain(ARROWS[6]); // ←
  });

  it("falls back to the glyph when the canvas render itself fails", async () => {
    const { indicator, glyphs } = indicatorHarness({ failRender: true });
    indicator.prepare?.(); // must not throw
    await indicator.update(0, { ring: true, dim: false });
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toContain(ARROWS[0]); // ↑
  });
});
