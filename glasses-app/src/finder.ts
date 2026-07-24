/**
 * Car finder — all of the maths and none of the I/O.
 *
 * Every phone coordinate in this app starts and ends here: bearing and
 * distance are computed on the device from the car position that /status
 * already returned. Nothing in this file (or anything that calls it) puts a
 * phone coordinate into a request — that is the claim PRIVACY.md makes, and
 * it is meant to stay code-reviewable.
 *
 * Stage 1 = Option B of CARFINDER-HANDOFF.md. There is no compass: the Stage 0
 * probe found the Even WebView refuses DeviceOrientationEvent.requestPermission()
 * at policy level (denied in 0–5ms, no dialog drawn), so device orientation is
 * off the table. Relative guidance therefore comes from the *travel course*
 * derived from successive GPS fixes, which only exists while the user is
 * actually walking — hence the two-state UI below.
 */

/** One GPS fix, already stripped of everything we don't use. */
export interface Fix {
  lat: number;
  lon: number;
  /** Horizontal accuracy, metres. Infinity when the platform won't say. */
  accuracy: number;
  /** Epoch ms. */
  at: number;
  /** Device-reported course, degrees clockwise from north. Null when still. */
  heading?: number | null;
  /** Device-reported ground speed, m/s. Null when the platform won't say. */
  speed?: number | null;
}

export interface LatLon {
  lat: number;
  lon: number;
}

// ---------------------------------------------------------------------------
// Geometry

const R_EARTH_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Wrap any angle into [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed smallest difference a − b, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  return normalizeDeg(a - b + 180) - 180;
}

/** Great-circle distance in metres (haversine). */
export function distanceMetres(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

// ---------------------------------------------------------------------------
// 8-way quantisation
//
// Index 0 = straight ahead / north, then clockwise in 45° steps. The cardinal
// names and both arrow sets share that indexing, so a direction is one number
// everywhere below.

export const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Both sets are confirmed present in the firmware font on real hardware
// (PROBE-RESULTS-STAGE0.md §D — anything absent renders as *nothing*, so this
// is not a guess). The thin set is prettier; the chunky set has roughly double
// the ink and is easier to read at a glance while walking.
//
// >>> OPEN QUESTION: thin vs chunky is an owner judgement to be made on
// >>> hardware. Swapping the line below is the entire change.
export const ARROWS_THIN = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
export const ARROWS_CHUNKY = ["▲", "◥", "▷", "◢", "▼", "◣", "◁", "◤"];
export const ARROWS = ARROWS_THIN;

/** Nearest of the 8 directions to `deg`. */
export function octant(deg: number): number {
  return Math.round(normalizeDeg(deg) / 45) % 8;
}

// Extra degrees past the 22.5° sector edge that a direction must travel before
// the arrow is allowed to change. Without it, an angle sitting on a boundary
// flickers between two glyphs on every fix — and GPS noise guarantees one will
// sit on a boundary sooner or later.
const HYSTERESIS_DEG = 7;

/** `octant`, but sticky: keeps `prev` until `deg` is clearly out of its sector. */
export function octantWithHysteresis(deg: number, prev: number | null): number {
  if (prev == null) return octant(deg);
  const fromPrevCentre = Math.abs(angleDelta(deg, prev * 45));
  return fromPrevCentre <= 22.5 + HYSTERESIS_DEG ? prev : octant(deg);
}

export function cardinal(deg: number): string {
  return CARDINALS[octant(deg)];
}

// ---------------------------------------------------------------------------
// Travel course from successive fixes
//
// A GPS fix knows where you are, not which way you are facing. Two fixes far
// enough apart know which way you are *moving*, which is the same thing while
// walking and meaningless while standing still — so the course expires.

/** Fixes worse than this are junk; they'd poison distance as well as course. */
const MAX_FIX_ACCURACY_M = 100;
/** Fixes worse than this still give a usable distance, but not a course. */
const COURSE_MAX_ACCURACY_M = 35;
/** How far apart two fixes must be before the line between them means anything. */
const MIN_TRAVEL_M = 12;
/** Oldest fix eligible to anchor the course — a longer baseline is smoother. */
const TRAIL_MS = 15_000;
/** No qualifying movement for this long ⇒ stopped ⇒ back to cardinal text. */
const COURSE_STALE_MS = 6_000;
/** Below this the platform's own `heading` is noise, so we ignore it. */
const DEVICE_HEADING_MIN_SPEED = 0.7;

/** True when a fix is good enough to trust at all. */
export function isUsableFix(fix: Fix): boolean {
  return (
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lon) &&
    fix.accuracy <= MAX_FIX_ACCURACY_M
  );
}

export class CourseTracker {
  private trail: Fix[] = [];
  private courseDeg: number | null = null;
  private courseAt = 0;

  /** Feed a fix. Fixes too vague to trust are ignored for course purposes. */
  push(fix: Fix): void {
    if (!isUsableFix(fix) || fix.accuracy > COURSE_MAX_ACCURACY_M) return;

    // The platform's own course, when it offers one and we're moving fast
    // enough for it to mean something. Free and instant where available; the
    // probe saw it null standing still and never got to test it walking, so
    // it is an opportunistic bonus, never the thing we depend on.
    if (
      fix.heading != null &&
      Number.isFinite(fix.heading) &&
      (fix.speed ?? 0) >= DEVICE_HEADING_MIN_SPEED
    ) {
      this.courseDeg = normalizeDeg(fix.heading);
      this.courseAt = fix.at;
    }

    this.trail.push(fix);
    this.trail = this.trail.filter((f) => fix.at - f.at <= TRAIL_MS);

    // Oldest fix still far enough away wins: the longest available baseline
    // is the least noisy one.
    const anchor = this.trail.find(
      (f) => distanceMetres(f, fix) >= MIN_TRAVEL_M,
    );
    if (anchor) {
      this.courseDeg = bearingDeg(anchor, fix);
      this.courseAt = fix.at;
    }
  }

  /** Current travel course, or null when it has gone stale (user stopped). */
  course(now: number): number | null {
    if (this.courseDeg == null) return null;
    return now - this.courseAt <= COURSE_STALE_MS ? this.courseDeg : null;
  }

  reset(): void {
    this.trail = [];
    this.courseDeg = null;
    this.courseAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Distance and staleness formatting

/**
 * Honest rounding. GPS in the places this feature gets used (multi-storey car
 * parks, urban canyons) is worth ±10–30m, so a metre-precise number would be
 * a lie: nearest 10m below a kilometre, then one decimal in the account's own
 * range unit.
 *
 * Open question 5 of the handoff (yards for UK sub-0.1mi) is deliberately not
 * answered here — metres for everything short is the current behaviour and
 * this function is the only place that would change.
 */
export function formatDistance(metres: number, unit: string | null): string {
  // Round before the threshold test, so 999m becomes "1.0 km" and never the
  // absurd "1000m".
  const rounded = Math.round(metres / 10) * 10;
  if (rounded < 1000) return `${rounded}m`;
  const useMiles = (unit ?? "").toLowerCase().startsWith("mi");
  const value = useMiles ? metres / 1609.344 : metres / 1000;
  return `${value.toFixed(1)} ${useMiles ? "mi" : "km"}`;
}

/** Car positions older than this get an explicit age line. */
export const STALE_AFTER_MS = 30 * 60_000;

/**
 * "parked 2h ago", or null when the position is fresh, absent, or from an
 * older proxy that doesn't send the field at all. A future timestamp (clock
 * skew) says nothing useful, so it also renders nothing.
 */
export function formatParkedAge(
  parkedAtIso: string | null | undefined,
  now: number,
): string | null {
  if (!parkedAtIso) return null;
  const at = new Date(parkedAtIso).getTime();
  if (isNaN(at)) return null;
  const age = now - at;
  if (age < STALE_AFTER_MS) return null;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `parked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `parked ${hours}h ago`;
  return `parked ${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// The finder view model
//
// One pure function turns "where the car is, where the phone is, which way it
// is moving" into the exact strings on the glasses. The renderer only centres
// them; the state machine is entirely here, entirely testable.

// ---------------------------------------------------------------------------
// Arrival — accuracy-adaptive
//
// A fixed radius lies in both directions: with a 5m fix it gives up 22m from
// a car the user can see isn't there, with a 40m fix it can never trigger at
// all. So the radius follows the fix quality, and one noisy fix is never
// allowed to end the walk on its own.

/** The radius never shrinks below this — GPS is not a tape measure. */
export const ARRIVAL_MIN_RADIUS_M = 10;
/** Radius = this × the fix's reported accuracy (when that exceeds the min). */
export const ARRIVAL_ACCURACY_FACTOR = 1.5;
/** Consecutive qualifying fixes required before arrival is declared. */
export const ARRIVAL_STREAK = 2;
/** Fixes at/below this accuracy earn "You're here"; above it the honest
 *  claim is "You're close" — the radius that triggered could be 40m+ wide. */
export const ARRIVAL_CONFIDENT_ACCURACY_M = 20;

/** Arrival progress threaded between renders (like `prevOctant`): how many
 *  consecutive fixes have been inside the arrival radius, and which fix was
 *  counted last — the 1 Hz tick re-renders the same fix, and a re-render
 *  must never count twice. */
export interface ArrivalProgress {
  streak: number;
  lastFixAt: number;
}

export type FinderMode =
  | "stationary"
  | "walking"
  | "arrived"
  | "locating"
  | "awaiting"
  | "problem";

/** Why there's no usable phone position. Each one renders an explanation. */
export type FinderProblem = "denied" | "unavailable" | "no-car";

export interface FinderView {
  mode: FinderMode;
  /** Arrow glyph — walking state only; null means "render nothing there". */
  arrow: string | null;
  /** The big line. */
  headline: string;
  /** Secondary line: staleness, or the explanation behind a problem. */
  detail: string;
  /** Bottom hint. Always present: a finder screen is never blank. */
  hint: string;
  /** Chosen direction index, fed back in as `prevOctant` for hysteresis. */
  octant: number | null;
  /** Arrival progress, fed back in as `arrival` on the next render. */
  arrival: ArrivalProgress;
}

export interface FinderInput {
  /** Car position from the last /status, or null if it didn't report one. */
  car: LatLon | null;
  /** Latest usable phone fix, or null before the first one arrives. */
  fix: Fix | null;
  /** Travel course from CourseTracker, or null when stationary/unknown. */
  course: number | null;
  now: number;
  /** The account's range unit from /status ("mi"/"km"), for long distances. */
  unit?: string | null;
  /** location_last_updated from /status. Absent on an older proxy. */
  parkedAt?: string | null;
  /** Direction shown last frame, so the arrow doesn't flicker at a boundary. */
  prevOctant?: number | null;
  /** Arrival progress from the previous render (see ArrivalProgress). */
  arrival?: ArrivalProgress | null;
  /** Set when the phone position is unavailable for a known reason. */
  problem?: FinderProblem | null;
  /** The permission dialog is (probably) still waiting to be answered — a
   *  first-run phone with the finder started from the glasses shows the iOS
   *  prompt invisibly on a locked screen. Distinct from `locating` (permission
   *  already granted, a fix is merely still coming) so the copy can say the
   *  honest thing: unlock the phone, not "Locating…". Ignored once a fix or a
   *  real `problem` arrives — both outrank a guess about a pending dialog. */
  awaitingPermission?: boolean | null;
}

const HINT_BACK = "Tap: back · 2x tap: close app";

export function finderView(input: FinderInput): FinderView {
  const {
    car,
    fix,
    course,
    now,
    unit = null,
    parkedAt = null,
    prevOctant = null,
    arrival: prevArrival = null,
    problem = null,
    awaitingPermission = null,
  } = input;

  // No usable fix ⇒ no arrival progress; the streak restarts from zero.
  const noArrival: ArrivalProgress = { streak: 0, lastFixAt: 0 };
  const base = {
    arrow: null,
    octant: null,
    hint: HINT_BACK,
    arrival: noArrival,
  } as const;

  // Problem states first: every one of them renders a sentence explaining
  // itself. A blank screen inside a feature reads as a crash (and is a store
  // review reject), so there is no path out of this function that draws
  // nothing.
  if (problem === "no-car" || !car) {
    return {
      ...base,
      mode: "problem",
      headline: "Car position unknown",
      detail: "Your car hasn't reported\nwhere it's parked",
    };
  }
  if (problem === "denied") {
    return {
      ...base,
      mode: "problem",
      headline: "Location not allowed",
      detail: "Allow location for this app\nin your phone's settings",
    };
  }
  if (problem === "unavailable") {
    return {
      ...base,
      mode: "problem",
      headline: "No GPS signal",
      detail: "Move somewhere with a\nclearer view of the sky",
    };
  }
  // Waiting on the permission dialog, not on a fix. A first-run phone shows the
  // iOS prompt invisibly on a locked screen, and a bare "Locating…" then lies
  // for however long the phone stays pocketed (the field-tested stuck state).
  // Only reachable with no fix and no hard problem yet — both branches above
  // and the fix below outrank it.
  if (awaitingPermission && !fix) {
    return {
      ...base,
      mode: "awaiting",
      headline: "Unlock your phone",
      detail: "to allow location access",
    };
  }
  if (!fix) {
    return { ...base, mode: "locating", headline: "Locating…", detail: "" };
  }

  const metres = distanceMetres(fix, car);
  const distance = formatDistance(metres, unit);
  const parked = formatParkedAge(parkedAt, now) ?? "";

  // Arrival bookkeeping. The radius follows the fix's own accuracy, and one
  // fix is never enough: the streak must reach ARRIVAL_STREAK across
  // *distinct* fixes (a re-render of the same fix changes nothing).
  const radius = Math.max(
    ARRIVAL_MIN_RADIUS_M,
    ARRIVAL_ACCURACY_FACTOR * fix.accuracy,
  );
  const qualifying = metres <= radius;
  const prev = prevArrival ?? noArrival;
  const arrival: ArrivalProgress =
    fix.at === prev.lastFixAt
      ? prev
      : { streak: qualifying ? prev.streak + 1 : 0, lastFixAt: fix.at };

  // Deliberately not "you have arrived": the car's own coordinates are only
  // worth ±10–30m and floors are invisible to GPS. With a tight fix "here"
  // is defensible; with a wide one the trigger circle could be 40m+ across,
  // so the claim honestly downgrades to "close". Both say "Check nearby".
  if (arrival.streak >= ARRIVAL_STREAK) {
    return {
      ...base,
      arrival,
      mode: "arrived",
      headline:
        fix.accuracy <= ARRIVAL_CONFIDENT_ACCURACY_M
          ? "You're here"
          : "You're close",
      detail: "Check nearby",
    };
  }

  // Walking: a course exists, so the arrow can point relative to the way the
  // user is actually facing — the whole point of the feature.
  if (course != null) {
    const relative = normalizeDeg(bearingDeg(fix, car) - course);
    const index = octantWithHysteresis(relative, prevOctant);
    return {
      mode: "walking",
      arrow: ARROWS[index],
      headline: distance,
      detail: parked,
      hint: HINT_BACK,
      octant: index,
      arrival,
    };
  }

  // Stationary: no course to be relative to, so fall back to absolute
  // compass-point text. The wording carries the mode — "NE" is a direction
  // you look up, an arrow is one you follow.
  const bearing = bearingDeg(fix, car);
  return {
    mode: "stationary",
    arrow: null,
    headline: `Car: ${distance} ${cardinal(bearing)}`,
    detail: parked,
    hint: HINT_BACK,
    // Deliberately not carried into hysteresis: this is an absolute bearing,
    // not the relative angle the arrow uses, so it must not seed it.
    octant: null,
    arrival,
  };
}
