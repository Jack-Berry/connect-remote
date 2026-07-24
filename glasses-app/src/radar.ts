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
  // Leave a margin for the orbiting rim arrowhead and the N tick.
  return { size, cx: size / 2, cy: size / 2, radius: size * 0.4 };
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

// ---------------------------------------------------------------------------
// Drawing (the only part that needs a canvas)

// Phone dark-theme palette (index.html: #232323 surface, #E5E5E5 text), with a
// soft green accent echoing the glasses' green panel for the car + arrowhead.
const COL_BG = "#232323";
const COL_RING = "#3a3a3a";
const COL_USER = "#E5E5E5";
const COL_HALO = "rgba(122, 208, 143, 0.10)";
const COL_ACCENT = "#7ad08f";
const COL_TICK = "#9a9a9a";

export function drawScene(
  ctx: CanvasRenderingContext2D,
  layout: RadarLayout,
  scene: RadarScene,
): void {
  const { cx, cy, radius } = layout;
  ctx.clearRect(0, 0, layout.size, layout.size);
  ctx.fillStyle = COL_BG;
  ctx.fillRect(0, 0, layout.size, layout.size);

  // Range rings.
  ctx.strokeStyle = COL_RING;
  ctx.lineWidth = 1.5;
  for (const r of scene.ringRadii) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // North tick (stationary only) — a small mark and 'N' at the top of the rim.
  if (scene.showN) {
    ctx.strokeStyle = COL_TICK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius - 2);
    ctx.lineTo(cx, cy - radius - 12);
    ctx.stroke();
    ctx.fillStyle = COL_TICK;
    ctx.font = "600 13px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("N", cx, cy - radius - 15);
  }

  // Accuracy halo, under the user dot.
  if (scene.accuracyRadiusPx > 1) {
    ctx.fillStyle = COL_HALO;
    ctx.beginPath();
    ctx.arc(cx, cy, scene.accuracyRadiusPx, 0, Math.PI * 2);
    ctx.fill();
  }

  // User dot at the centre.
  ctx.fillStyle = COL_USER;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  // Car dot.
  if (scene.car) {
    ctx.fillStyle = COL_ACCENT;
    ctx.beginPath();
    ctx.arc(scene.car.x, scene.car.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rim arrowhead (walking) — a filled triangle just outside the rim, pointing
  // outward along the relative direction.
  if (scene.arrowheadDeg != null) {
    drawArrowhead(ctx, layout, scene.arrowheadDeg);
  }
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  layout: RadarLayout,
  screenDeg: number,
): void {
  const { cx, cy, radius } = layout;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(toRad(screenDeg));
  ctx.fillStyle = COL_ACCENT;
  const tip = radius + 16;
  const base = radius + 4;
  ctx.beginPath();
  ctx.moveTo(0, -tip);
  ctx.lineTo(9, -base);
  ctx.lineTo(-9, -base);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Convenience: compute + draw in one call. */
export function drawRadar(
  ctx: CanvasRenderingContext2D,
  layout: RadarLayout,
  frame: FinderFrame,
): void {
  drawScene(ctx, layout, computeScene(frame, layout));
}
