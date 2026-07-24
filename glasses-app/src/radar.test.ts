/** Phone radar geometry.
 *
 *  No canvas here — only the pure maths that decides where the car dot lands,
 *  how the rings scale, whether the map turns with the walk, and where the rim
 *  arrowhead points. The drawing is exercised in the simulator.
 */

import { describe, expect, it } from "vitest";

import type { Fix, FinderView } from "./finder";
import type { FinderFrame } from "./finder-engine";
import { computeScene, layoutFor, niceRange } from "./radar";

/** A nice number is m × 10ⁿ with m ∈ {1,2,5}. */
function isNiceNumber(v: number): boolean {
  if (v <= 0) return false;
  const e = Math.floor(Math.log10(v) + 1e-9);
  const m = v / 10 ** e;
  return [1, 2, 5].some((x) => Math.abs(m - x) < 1e-6);
}

function frame(over: Partial<FinderFrame> = {}): FinderFrame {
  const view: FinderView = {
    mode: "stationary",
    arrow: null,
    headline: "",
    detail: "",
    hint: "",
    octant: null,
    arrival: { streak: 0, lastFixAt: 0 },
  };
  return {
    view,
    fix: null,
    car: null,
    course: null,
    bearingToCar: null,
    distanceM: null,
    stale: false,
    noteActive: false,
    problem: null,
    telemetry: null,
    ...over,
  };
}

describe("niceRange", () => {
  it("places the car ~60–80% out with a nice ring step", () => {
    for (const d of [40, 100, 250, 600, 1000, 3000]) {
      const { maxRange, ringStep, ringCount } = niceRange(d);
      const frac = d / maxRange;
      expect(frac).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(frac).toBeLessThanOrEqual(0.8 + 1e-9);
      expect(ringStep * ringCount).toBeCloseTo(maxRange, 6);
      expect(isNiceNumber(ringStep)).toBe(true);
    }
  });

  it("never lets the car sit past the rim, across a wide sweep", () => {
    for (let d = 5; d <= 5000; d += 7) {
      const { maxRange, ringStep, ringCount } = niceRange(d);
      expect(d / maxRange).toBeLessThanOrEqual(0.8 + 1e-9);
      expect(ringCount).toBeGreaterThanOrEqual(2);
      expect(isNiceNumber(ringStep)).toBe(true);
    }
  });

  it("returns a sane radar even at zero distance", () => {
    const r = niceRange(0);
    expect(r.maxRange).toBeGreaterThan(0);
    expect(r.ringCount).toBeGreaterThanOrEqual(2);
  });
});

describe("computeScene", () => {
  const layout = layoutFor(240);

  it("is north-up with a tick and no arrowhead when stationary", () => {
    const scene = computeScene(
      frame({ course: null, bearingToCar: 90, distanceM: 100 }),
      layout,
    );
    expect(scene.courseUp).toBe(false);
    expect(scene.showN).toBe(true);
    expect(scene.arrowheadDeg).toBeNull();
    // Car due east ⇒ to the right of centre, level with it.
    expect(scene.car!.x).toBeGreaterThan(layout.cx);
    expect(scene.car!.y).toBeCloseTo(layout.cy, 5);
  });

  it("turns the map course-up while walking so 'ahead' is up", () => {
    // Car due east, walking due east ⇒ car is straight ahead ⇒ up on screen.
    const scene = computeScene(
      frame({
        course: 90,
        bearingToCar: 90,
        distanceM: 100,
        view: { ...frame().view, mode: "walking", octant: 0 },
      }),
      layout,
    );
    expect(scene.courseUp).toBe(true);
    expect(scene.showN).toBe(false);
    expect(scene.car!.y).toBeLessThan(layout.cy); // above centre
    expect(scene.car!.x).toBeCloseTo(layout.cx, 5);
  });

  it("orbits the rim arrowhead at the quantised relative octant, walking only", () => {
    const walking = computeScene(
      frame({
        course: 0,
        bearingToCar: 90,
        distanceM: 100,
        view: { ...frame().view, mode: "walking", octant: 2 },
      }),
      layout,
    );
    expect(walking.arrowheadDeg).toBe(90); // octant 2 × 45°

    // Same geometry but stationary (no course): arrowhead gone, radar carries it.
    const still = computeScene(
      frame({ course: null, bearingToCar: 90, distanceM: 100 }),
      layout,
    );
    expect(still.arrowheadDeg).toBeNull();
  });

  it("scales the accuracy halo against the outer range", () => {
    const fix: Fix = { lat: 0, lon: 0, accuracy: 30, at: 0 };
    const scene = computeScene(
      frame({ course: null, bearingToCar: 0, distanceM: 100, fix }),
      layout,
    );
    // maxRange for 100m is 150m ⇒ halo = 30/150 of the radar radius.
    expect(scene.accuracyRadiusPx).toBeCloseTo((30 / 150) * layout.radius, 3);
  });

  it("keeps the car dot inside the radar at any distance (auto-scaled rings)", () => {
    for (const d of [10, 100, 1000, 1e6]) {
      const scene = computeScene(
        frame({ course: null, bearingToCar: 0, distanceM: d }),
        layout,
      );
      const dist = Math.hypot(
        scene.car!.x - layout.cx,
        scene.car!.y - layout.cy,
      );
      expect(dist).toBeLessThanOrEqual(layout.radius + 1e-6);
    }
  });

  it("places no car dot without a position", () => {
    expect(computeScene(frame({ distanceM: null }), layout).car).toBeNull();
  });
});
