/** Car finder maths and state machine (Stage 1 / Option B).
 *
 *  Everything the user sees while walking back to their car is decided here,
 *  from GPS fixes that are never better than ±5m and are routinely ±30m in the
 *  car parks this feature exists for. The tests below are mostly about that
 *  noise: the arrow must not flicker, the distance must not claim precision it
 *  hasn't got, and a course must not be invented out of standing still.
 */

import { describe, expect, it } from "vitest";

import {
  ARROWS,
  CARDINALS,
  CourseTracker,
  type Fix,
  bearingDeg,
  cardinal,
  distanceMetres,
  finderView,
  formatDistance,
  formatParkedAge,
  isUsableFix,
  octant,
  octantWithHysteresis,
} from "./finder";

// Trafalgar Square, and points a known distance/bearing away from it.
const CAR = { lat: 51.5072, lon: -0.1276 };

/** A point `metres` from `from` on `bearing` (flat-earth, fine at this scale). */
function offset(from: { lat: number; lon: number }, bearing: number, metres: number) {
  const rad = (bearing * Math.PI) / 180;
  return {
    lat: from.lat + (metres * Math.cos(rad)) / 111_320,
    lon:
      from.lon +
      (metres * Math.sin(rad)) / (111_320 * Math.cos((from.lat * Math.PI) / 180)),
  };
}

function fix(pos: { lat: number; lon: number }, at: number, extra: Partial<Fix> = {}): Fix {
  return { lat: pos.lat, lon: pos.lon, accuracy: 8, at, ...extra };
}

describe("geometry", () => {
  it("measures distance to within a metre over a few hundred metres", () => {
    expect(distanceMetres(CAR, offset(CAR, 0, 300))).toBeCloseTo(300, 0);
    expect(distanceMetres(CAR, offset(CAR, 90, 150))).toBeCloseTo(150, 0);
    expect(distanceMetres(CAR, CAR)).toBe(0);
  });

  it("gives forward azimuth clockwise from north", () => {
    expect(bearingDeg(CAR, offset(CAR, 0, 200))).toBeCloseTo(0, 0);
    expect(bearingDeg(CAR, offset(CAR, 90, 200))).toBeCloseTo(90, 0);
    expect(bearingDeg(CAR, offset(CAR, 225, 200))).toBeCloseTo(225, 0);
  });

  it("maps bearings onto the eight compass points", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(44)).toBe("NE");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(200)).toBe("S");
    expect(cardinal(359)).toBe("N");
  });

  it("keeps the cardinal names and the arrow glyphs on the same index", () => {
    // A mismatch here would point the arrow one sector off — silently, and
    // only while walking, which is the worst possible way to find out.
    expect(ARROWS).toHaveLength(CARDINALS.length);
    expect(octant(0)).toBe(0);
    expect(octant(90)).toBe(2);
    expect(octant(180)).toBe(4);
    expect(octant(270)).toBe(6);
  });
});

describe("octantWithHysteresis", () => {
  it("takes the nearest sector when there is nothing to stick to", () => {
    expect(octantWithHysteresis(80, null)).toBe(2);
  });

  it("holds the current arrow while the angle hovers on a sector boundary", () => {
    // 22.5° is the true edge between N and NE. GPS noise walks an angle back
    // and forth across it constantly; without hysteresis the glyph would
    // alternate on every fix.
    expect(octantWithHysteresis(23, 0)).toBe(0);
    expect(octantWithHysteresis(21, 0)).toBe(0);
    expect(octantWithHysteresis(29, 0)).toBe(0);
  });

  it("gives way once the direction has genuinely changed", () => {
    expect(octantWithHysteresis(31, 0)).toBe(1);
    expect(octantWithHysteresis(90, 0)).toBe(2);
  });

  it("holds across the 0/360 wrap", () => {
    expect(octantWithHysteresis(355, 0)).toBe(0);
    expect(octantWithHysteresis(5, 0)).toBe(0);
    // ...and still releases on the far side of it (330° is 30° off north,
    // past the 22.5° edge plus the 7° band).
    expect(octantWithHysteresis(330, 0)).toBe(7);
  });
});

describe("formatDistance", () => {
  it("rounds to the nearest 10m below a kilometre", () => {
    // ±5m of GPS accuracy on a good day: "143m" would be a fiction.
    expect(formatDistance(143, "km")).toBe("140m");
    expect(formatDistance(147, "km")).toBe("150m");
    expect(formatDistance(8, "km")).toBe("10m");
  });

  it("switches to the account's own unit above a kilometre", () => {
    expect(formatDistance(1400, "km")).toBe("1.4 km");
    expect(formatDistance(1609.344, "mi")).toBe("1.0 mi");
    expect(formatDistance(3200, "mi")).toBe("2.0 mi");
  });

  it("never prints an absurd 1000m", () => {
    expect(formatDistance(999, "km")).toBe("1.0 km");
  });

  it("falls back to metric when the account never said what unit it uses", () => {
    expect(formatDistance(2000, null)).toBe("2.0 km");
  });
});

describe("formatParkedAge", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("says nothing about a recently reported position", () => {
    expect(formatParkedAge(ago(5 * 60_000), now)).toBeNull();
    expect(formatParkedAge(ago(29 * 60_000), now)).toBeNull();
  });

  it("reports minutes, then hours, then days", () => {
    expect(formatParkedAge(ago(45 * 60_000), now)).toBe("parked 45m ago");
    expect(formatParkedAge(ago(2 * 3600_000), now)).toBe("parked 2h ago");
    expect(formatParkedAge(ago(26 * 3600_000), now)).toBe("parked 26h ago");
    expect(formatParkedAge(ago(3 * 86_400_000), now)).toBe("parked 3d ago");
  });

  it("stays silent when the field is missing, junk, or in the future", () => {
    // An older proxy doesn't send the field at all — omit the line rather
    // than inventing an age from the status timestamp.
    expect(formatParkedAge(null, now)).toBeNull();
    expect(formatParkedAge(undefined, now)).toBeNull();
    expect(formatParkedAge("not a date", now)).toBeNull();
    expect(formatParkedAge(ago(-3600_000), now)).toBeNull();
  });
});

describe("isUsableFix", () => {
  it("rejects fixes too vague to place the phone in the right street", () => {
    expect(isUsableFix(fix(CAR, 0, { accuracy: 30 }))).toBe(true);
    expect(isUsableFix(fix(CAR, 0, { accuracy: 250 }))).toBe(false);
    expect(isUsableFix(fix(CAR, 0, { accuracy: Infinity }))).toBe(false);
  });
});

describe("CourseTracker", () => {
  it("has no course from a single fix", () => {
    const t = new CourseTracker();
    t.push(fix(CAR, 1000));
    expect(t.course(1000)).toBeNull();
  });

  it("has no course from standing still and jittering", () => {
    // The whole hazard: GPS noise at a standstill would otherwise produce a
    // confident, random arrow.
    const t = new CourseTracker();
    for (let i = 0; i < 10; i++) {
      t.push(fix(offset(CAR, i * 36, 4), 1000 + i * 1000));
    }
    expect(t.course(11_000)).toBeNull();
  });

  it("derives the travel course once the user has actually moved", () => {
    const t = new CourseTracker();
    const start = offset(CAR, 180, 200);
    for (let i = 0; i <= 10; i++) {
      t.push(fix(offset(start, 90, i * 3), 1000 + i * 1000));
    }
    // Walked 30m due east.
    expect(t.course(11_000)).toBeCloseTo(90, 0);
  });

  it("lets the course go stale when the user stops walking", () => {
    const t = new CourseTracker();
    const start = offset(CAR, 180, 200);
    for (let i = 0; i <= 10; i++) {
      t.push(fix(offset(start, 90, i * 3), 1000 + i * 1000));
    }
    expect(t.course(14_000)).toBeCloseTo(90, 0);
    // Six seconds without qualifying movement: they've stopped, and a course
    // from where they were walking a minute ago is a lie.
    expect(t.course(20_000)).toBeNull();
  });

  it("ignores fixes too vague to derive a course from", () => {
    const t = new CourseTracker();
    const start = offset(CAR, 180, 200);
    for (let i = 0; i <= 10; i++) {
      t.push(fix(offset(start, 90, i * 3), 1000 + i * 1000, { accuracy: 60 }));
    }
    expect(t.course(11_000)).toBeNull();
  });

  it("uses the platform's own heading when it offers one and we're moving", () => {
    const t = new CourseTracker();
    t.push(fix(CAR, 1000, { heading: 270, speed: 1.4 }));
    expect(t.course(1000)).toBeCloseTo(270, 0);
  });

  it("ignores the platform heading at a standstill", () => {
    // The probe saw heading null while stationary; a platform that reports a
    // stale one instead must not be believed.
    const t = new CourseTracker();
    t.push(fix(CAR, 1000, { heading: 270, speed: 0 }));
    expect(t.course(1000)).toBeNull();
  });
});

describe("finderView", () => {
  const now = Date.parse("2026-07-20T12:00:00Z");
  const base = { car: CAR, now, unit: "mi" as string | null };

  it("shows distance and a compass point while stationary", () => {
    // Standing 200m south-west of the car ⇒ the car is to the north-east.
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 225, 200), now),
      course: null,
    });
    expect(v.mode).toBe("stationary");
    expect(v.headline).toBe("Car: 200m NE");
    expect(v.arrow).toBeNull();
  });

  it("upgrades to a relative arrow once a travel course exists", () => {
    // Car due north; walking due east ⇒ the car is 90° to the left.
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 180, 200), now),
      course: 90,
    });
    expect(v.mode).toBe("walking");
    expect(v.arrow).toBe(ARROWS[6]); // ←
    expect(v.headline).toBe("200m");
  });

  it("points straight ahead when the user is walking at the car", () => {
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 180, 200), now),
      course: 0,
    });
    expect(v.arrow).toBe(ARROWS[0]); // ↑
  });

  it("feeds its own direction back in, so the arrow can be held steady", () => {
    const here = fix(offset(CAR, 180, 200), now);
    const first = finderView({ ...base, fix: here, course: 0 });
    expect(first.octant).toBe(0);
    // A course that has drifted 20° — inside the hysteresis band, so the
    // arrow must not move.
    const second = finderView({
      ...base,
      fix: here,
      course: 340,
      prevOctant: first.octant,
    });
    expect(second.arrow).toBe(first.arrow);
  });

  it("does not seed the arrow's hysteresis from an absolute bearing", () => {
    // The stationary state's direction is absolute (compass) while the
    // walking state's is relative (to travel). Carrying one into the other
    // would hold the arrow at a sector that means something else entirely.
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 225, 200), now),
      course: null,
    });
    expect(v.octant).toBeNull();
  });

  it("degrades back to cardinal text when the course goes stale", () => {
    const here = fix(offset(CAR, 225, 200), now);
    expect(finderView({ ...base, fix: here, course: 45 }).mode).toBe("walking");
    expect(finderView({ ...base, fix: here, course: null }).mode).toBe(
      "stationary",
    );
  });

  it("stops claiming precision once the user is on top of the car", () => {
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 45, 15), now),
      course: 45,
    });
    expect(v.mode).toBe("arrived");
    expect(v.headline).toBe("You're here");
    // Not "you have arrived": GPS can't see which floor of the car park
    // you're on, and the car's own coordinates are worth ±10-30m.
    expect(v.detail).toBe("Check nearby");
    expect(v.arrow).toBeNull();
  });

  it("adds the parked age only when the position is genuinely old", () => {
    const here = fix(offset(CAR, 225, 200), now);
    const fresh = finderView({
      ...base,
      fix: here,
      course: null,
      parkedAt: new Date(now - 60_000).toISOString(),
    });
    expect(fresh.detail).toBe("");

    const old = finderView({
      ...base,
      fix: here,
      course: null,
      parkedAt: new Date(now - 2 * 3600_000).toISOString(),
    });
    expect(old.detail).toBe("parked 2h ago");
  });

  it("carries the parked age into the walking state too", () => {
    const v = finderView({
      ...base,
      fix: fix(offset(CAR, 180, 200), now),
      course: 0,
      parkedAt: new Date(now - 5 * 3600_000).toISOString(),
    });
    expect(v.mode).toBe("walking");
    expect(v.detail).toBe("parked 5h ago");
  });

  it("explains every failure instead of drawing nothing", () => {
    // A blank screen inside a feature reads as a crash — and is a store
    // review reject. Every one of these renders a sentence and a way out.
    const here = fix(offset(CAR, 225, 200), now);

    const denied = finderView({ ...base, fix: here, course: null, problem: "denied" });
    expect(denied.mode).toBe("problem");
    expect(denied.headline).toBe("Location not allowed");

    const unavailable = finderView({
      ...base,
      fix: here,
      course: null,
      problem: "unavailable",
    });
    expect(unavailable.headline).toBe("No GPS signal");

    const noCar = finderView({ ...base, car: null, fix: here, course: null });
    expect(noCar.headline).toBe("Car position unknown");

    const locating = finderView({ ...base, fix: null, course: null });
    expect(locating.mode).toBe("locating");

    for (const v of [denied, unavailable, noCar, locating]) {
      expect(v.headline).not.toBe("");
      expect(v.hint).toContain("Tap");
    }
  });

  it("reports a missing car position even when GPS is also broken", () => {
    // Nothing to point at beats "turn your GPS on" — fixing the phone would
    // not help.
    const v = finderView({
      ...base,
      car: null,
      fix: null,
      course: null,
      problem: "denied",
    });
    expect(v.headline).toBe("Car position unknown");
  });
});
