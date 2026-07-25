// Pure state + formatting for the sensor probe. Kept free of both the DOM and
// the Even bridge so the glasses summary can be reasoned about (and eyeballed
// in the dev server) without hardware.

import { getAdvW } from "@evenrealities/pretext";

// Per-capability verdict. The distinction that matters most for the car
// finder is NO-PROMPT vs NO-EVENTS: "iOS never asked" and "iOS said yes but
// the WebView delivers nothing" are different failures with different fixes.
export type Verdict =
  | "UNTESTED"
  | "REQUESTING"
  | "OK"
  | "DENIED"
  | "NO-PROMPT"
  | "NO-EVENTS"
  | "NOT-SUPPORTED"
  | "ERROR";

export interface GeoState {
  verdict: Verdict;
  detail: string;
  fixes: number;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  // GPS course/speed: the Option-B "which way am I walking" fallback when no
  // compass exists. Both are null while stationary on most hardware.
  heading: number | null;
  speed: number | null;
  firstFixMs: number | null;
  lastFixAt: number | null;
  gapMs: number | null;
}

export interface OrientationState {
  verdict: Verdict;
  detail: string;
  // How long requestPermission() took to settle. A near-instant resolve means
  // no prompt was drawn (already-granted, or auto-granted by the WebView) —
  // the evidence for a NO-PROMPT call that the user's own eyes then confirm.
  requestMs: number | null;
  permission: string | null;
  events: number;
  hz: number | null;
  // The whole question: iOS-only, absolute, 0=north, degrees clockwise.
  compassHeading: number | null;
  compassAccuracy: number | null;
  hasCompassField: boolean;
  absolute: boolean | null;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

export interface MotionState {
  verdict: Verdict;
  detail: string;
  requestMs: number | null;
  permission: string | null;
  events: number;
  hz: number | null;
  interval: number | null;
  // Gravity-free linear acceleration; null on hardware that only ever fills
  // accelerationIncludingGravity.
  ax: number | null;
  ay: number | null;
  az: number | null;
  gx: number | null;
  gy: number | null;
  gz: number | null;
  // Gyroscope — the other half of the tilt-controller answer.
  rateAlpha: number | null;
  rateBeta: number | null;
  rateGamma: number | null;
}

export interface ProbeState {
  geo: GeoState;
  orientation: OrientationState;
  motion: MotionState;
}

export function initialState(): ProbeState {
  return {
    geo: {
      verdict: "UNTESTED",
      detail: "not started",
      fixes: 0,
      latitude: null,
      longitude: null,
      accuracy: null,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      firstFixMs: null,
      lastFixAt: null,
      gapMs: null,
    },
    orientation: {
      verdict: "UNTESTED",
      detail: "not started",
      requestMs: null,
      permission: null,
      events: 0,
      hz: null,
      compassHeading: null,
      compassAccuracy: null,
      hasCompassField: false,
      absolute: null,
      alpha: null,
      beta: null,
      gamma: null,
    },
    motion: {
      verdict: "UNTESTED",
      detail: "not started",
      requestMs: null,
      permission: null,
      events: 0,
      hz: null,
      interval: null,
      ax: null,
      ay: null,
      az: null,
      gx: null,
      gy: null,
      gz: null,
      rateAlpha: null,
      rateBeta: null,
      rateGamma: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Glyph availability

// The handoff's 8-way arrow candidates, in compass order from north.
export const ARROW_CANDIDATES = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];

// Fallback shapes worth knowing about if the arrows turn out to be missing:
// solid/hollow triangles and corner wedges are a plausible 8-way set too.
export const ARROW_FALLBACKS = [
  "▲",
  "►",
  "▼",
  "◄",
  "△",
  "▷",
  "▽",
  "◁",
  "◤",
  "◥",
  "◢",
  "◣",
  "⬆",
  "⬈",
  "➤",
];

export interface GlyphResult {
  char: string;
  codepoint: string;
  advance: number;
  present: boolean;
}

// pretext walks the same font fallback chain the firmware does
// (evenroster -> evenroster_crylgrek -> cn -> evenemoji), so a zero advance
// width means the glyph is in none of them and the firmware will silently
// skip it. Verified against controls: U+E000 (private use) and U+10FFFD
// (noncharacter) both report 0; every ASCII letter reports non-zero.
export function checkGlyph(char: string): GlyphResult {
  const cp = char.codePointAt(0) ?? 0;
  const advance = getAdvW(cp);
  return {
    char,
    codepoint: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
    advance,
    present: advance > 0,
  };
}

export function checkGlyphs(chars: string[]): GlyphResult[] {
  return chars.map(checkGlyph);
}

// ---------------------------------------------------------------------------
// Formatting helpers

function num(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined || Number.isNaN(v)
    ? "—"
    : v.toFixed(digits);
}

export function fmtCoord(v: number | null): string {
  return v === null ? "—" : v.toFixed(5);
}

export function fmtTriple(
  a: number | null,
  b: number | null,
  c: number | null,
  digits = 2,
): string {
  return `${num(a, digits)}/${num(b, digits)}/${num(c, digits)}`;
}

// ---------------------------------------------------------------------------
// Glasses summary — 6 lines, readable at a glance while walking. Everything
// is short-form because the panel is 576px wide and the walker is looking at
// a car park, not a spreadsheet.

export function glassesSummary(
  s: ProbeState,
  arrows: GlyphResult[],
): string[] {
  const g = s.geo;
  const o = s.orientation;
  const m = s.motion;

  const acc = g.accuracy === null ? "—" : `${Math.round(g.accuracy)}m`;
  const age =
    g.gapMs === null ? "—" : `${(g.gapMs / 1000).toFixed(1)}s`;
  const spd = g.speed === null ? "—" : `${g.speed.toFixed(1)}m/s`;
  const gpsHdg = g.heading === null ? "—" : `${Math.round(g.heading)}°`;

  const cmp =
    o.compassHeading === null ? "—" : `${Math.round(o.compassHeading)}°`;
  const cmpAcc =
    o.compassAccuracy === null ? "" : ` ±${Math.round(o.compassAccuracy)}`;
  const oHz = o.hz === null ? "—" : `${o.hz.toFixed(0)}Hz`;
  const mHz = m.hz === null ? "—" : `${m.hz.toFixed(0)}Hz`;

  // Only render arrows the font actually has — a missing glyph is skipped by
  // the firmware, so printing all 8 unconditionally would misreport the very
  // thing this line exists to show.
  const arrowLine = arrows
    .filter((a) => a.present)
    .map((a) => a.char)
    .join(" ");

  return [
    `GPS ${g.verdict} ${acc} n=${g.fixes} ${age}`,
    `${fmtCoord(g.latitude)} ${fmtCoord(g.longitude)}`,
    `crs ${gpsHdg} spd ${spd}`,
    `CMP ${o.verdict} ${cmp}${cmpAcc} ${oHz} n=${o.events}`,
    `abg ${fmtTriple(o.alpha, o.beta, o.gamma, 0)}  MOT ${m.verdict} ${mHz}`,
    `acc ${fmtTriple(m.ax, m.ay, m.az)}  ${arrowLine || "NO ARROW GLYPHS"}`,
  ];
}
