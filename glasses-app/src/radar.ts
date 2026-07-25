/**
 * The phone finder's radar — the companion surface to the glasses arrow.
 *
 * The glasses can only say "that way, 140m" one coarse arrow at a time; the
 * phone has a canvas, so it draws the whole picture: the user at the centre,
 * the car as a dot at its true bearing and distance, range rings for scale, an
 * accuracy halo, and — the shared cue with the glasses — a rim arrowhead at the
 * SAME quantised relative angle the glasses arrow shows, so "walk this way"
 * reads identically on both.
 *
 * It renders from the shared FinderFrame (finder-engine.ts), so it is never a
 * second source of truth: one loop, one course, two pictures. Stationary is
 * north-up with an N tick (a heading to read); walking is course-up (the map
 * turns so "ahead" is up), using the same travel course the glasses arrow is
 * quantised from — the arrowhead then orbits at the top and fades out the
 * moment the user stops, because with no course there is no "this way" to point.
 *
 * All the geometry (ring scaling, the car dot, the arrowhead) is pure and
 * unit-tested; only drawScene touches a canvas.
 */

import type { FinderFrame } from "./finder-engine";

const toRad = (deg: number) => (deg * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Range-ring scaling
//
// The rings exist so distance is legible at a glance, and the car should sit
// well out on the radar (~60–80% of the way to the rim) rather than crammed at
// the centre or clipped at the edge. We pick a "nice" ring step (1/2/5 × 10ⁿ)
// and a ring count so the outermost ring lands the car in that band — round
// steps keep the picture readable and would survive a future numeric label.

export interface NiceRange {
  /** Metres at the outermost ring. */
  maxRange: number;
  /** Metres between rings (the nice step). */
  ringStep: number;
  /** How many concentric rings. */
  ringCount: number;
}

const MANTISSAS = [1, 2, 5];
const RING_COUNTS = [2, 3, 4];
/** Car should land in this fraction-of-rim band; 0.7 is the ideal. */
const FRAC_LO = 0.6;
const FRAC_HI = 0.8;
const FRAC_IDEAL = 0.7;

/** Every nice step (m × 10ⁿ) whose magnitude could possibly matter here. */
function niceSteps(distanceM: number): number[] {
  const steps: number[] = [];
  // From 1m up to comfortably past the distance itself.
  const maxExp = Math.max(1, Math.ceil(Math.log10(Math.max(distanceM, 10))) + 1);
  for (let e = 0; e <= maxExp; e++) {
    for (const m of MANTISSAS) steps.push(m * 10 ** e);
  }
  return steps;
}

/**
 * Choose ring step + count so the car sits ~60–80% out. Falls back to the
 * smallest nice outer range that keeps the car at/under 75% when nothing lands
 * cleanly in the band (very small or awkward distances), so the car is always
 * on-screen and never dead-centre.
 */
export function niceRange(distanceM: number): NiceRange {
  const d = distanceM > 0 ? distanceM : 0;
  if (d === 0) return { maxRange: 20, ringStep: 10, ringCount: 2 };

  let best: (NiceRange & { frac: number }) | null = null;
  for (const step of niceSteps(d)) {
    for (const count of RING_COUNTS) {
      const maxRange = step * count;
      const frac = d / maxRange;
      if (frac < FRAC_LO || frac > FRAC_HI) continue;
      const score = Math.abs(frac - FRAC_IDEAL);
      if (!best || score < Math.abs(best.frac - FRAC_IDEAL)) {
        best = { maxRange, ringStep: step, ringCount: count, frac };
      }
    }
  }
  if (best) {
    return {
      maxRange: best.maxRange,
      ringStep: best.ringStep,
      ringCount: best.ringCount,
    };
  }

  // Fallback: smallest nice step whose 3-ring range keeps the car ≤ 75% out.
  const target = d / FRAC_HI; // outer ≥ this ⇒ frac ≤ 0.8
  for (const step of niceSteps(d)) {
    const maxRange = step * 3;
    if (maxRange >= target) return { maxRange, ringStep: step, ringCount: 3 };
  }
  // Unreachable given niceSteps' range, but never return something degenerate.
  const step = 10 ** Math.ceil(Math.log10(d));
  return { maxRange: step * 3, ringStep: step, ringCount: 3 };
}

// ---------------------------------------------------------------------------
// Scene geometry (pure)

export interface RadarLayout {
  /** CSS px; the canvas is assumed square. */
  size: number;
  cx: number;
  cy: number;
  /** Pixel radius of the outermost range ring. */
  radius: number;
}

export function layoutFor(size: number): RadarLayout {
  // The outermost range ring IS the edge of the radar element; the rim
  // arrowhead and the N marker sit outside it and are allowed to overflow.
  return { size, cx: size / 2, cy: size / 2, radius: size / 2 };
}

export interface RadarScene {
  /** True while walking: the scene is rotated so the travel course points up. */
  courseUp: boolean;
  /** Draw the north tick at the top (stationary/north-up only). */
  showN: boolean;
  /** Pixel radii of the range rings, inner→outer. */
  ringRadii: number[];
  /** The car marker, or null when there's no position to place it. */
  car: { x: number; y: number } | null;
  /** Accuracy-halo radius in px (0 = none/omit). */
  accuracyRadiusPx: number;
  /** Screen angle (deg CW from up) of the rim arrowhead, or null when hidden
   *  (stationary: no course ⇒ no "this way"). */
  arrowheadDeg: number | null;
}

/** Where a world bearing lands on screen, given the scene's rotation. */
function screenPoint(
  layout: RadarLayout,
  radiusPx: number,
  screenBearingDeg: number,
): { x: number; y: number } {
  const a = toRad(screenBearingDeg);
  return {
    x: layout.cx + radiusPx * Math.sin(a),
    y: layout.cy - radiusPx * Math.cos(a),
  };
}

/**
 * Turn a frame into everything drawScene needs — no canvas, no I/O. Walking
 * rotates the whole scene by the travel course (course-up); stationary leaves
 * north up. The car dot and the rim arrowhead therefore share the same frame of
 * reference, so a precise dot and a coarse arrowhead always agree.
 */
export function computeScene(
  frame: FinderFrame,
  layout: RadarLayout,
): RadarScene {
  const courseUp = frame.course != null;
  const rotationDeg = frame.course ?? 0;
  const nice = niceRange(frame.distanceM ?? 0);
  const ringRadii = Array.from(
    { length: nice.ringCount },
    (_, i) => ((i + 1) / nice.ringCount) * layout.radius,
  );

  let car: RadarScene["car"] = null;
  if (frame.distanceM != null && frame.bearingToCar != null) {
    const screenBearing = frame.bearingToCar - rotationDeg;
    // niceRange keeps the car ≤80% out, so this only ever bites as pure
    // defence: the dot never touches the rim (where it would fuse with the
    // arrowhead) or leave the radar.
    const frac = Math.min(frame.distanceM / nice.maxRange, 0.95);
    car = screenPoint(layout, frac * layout.radius, screenBearing);
  }

  let accuracyRadiusPx = 0;
  if (frame.fix && Number.isFinite(frame.fix.accuracy)) {
    accuracyRadiusPx = Math.min(
      layout.radius,
      (frame.fix.accuracy / nice.maxRange) * layout.radius,
    );
  }

  // The rim arrowhead is the shared cue with the glasses: the SAME quantised
  // relative octant. Walking only — with no course there is nothing to be
  // relative to, so it fades and the radar carries the direction alone.
  const arrowheadDeg =
    courseUp && frame.view.octant != null ? frame.view.octant * 45 : null;

  return {
    courseUp,
    showN: !courseUp,
    ringRadii,
    car,
    accuracyRadiusPx,
    arrowheadDeg,
  };
}

// There is no drawing code here any more. The radar is DOM + CSS (see
// `bindPhoneFinder` in main.ts): the car dot and the rim arrowhead have to
// glide between updates rather than jump, and a CSS `transform` transition
// does that — and honours prefers-reduced-motion — for free, where a canvas
// would need its own tween loop. This module stays what it always was: the
// pure geometry, testable without a rendering surface of any kind.
