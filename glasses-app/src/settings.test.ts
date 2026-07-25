/** Phone-form powertrain rule: the charge-limits section (AC/DC prefs + the
 *  contextual send button) exists only for cars that plug in. The fuelOnly
 *  flag means the status carried a fuel level with no EV battery — which the
 *  proxy only emits on genuine fuel evidence, never for an EV.
 *
 *  Also the temperature maths, and the two pure rules behind the send button:
 *  what the car is known to hold, and whether that disagrees with the form. */

import { describe, expect, it } from "vitest";

import {
  CHARGE_LIMITS_SETTLE_MS,
  DEFAULT_SETTINGS,
  type AppSettings,
  carKnownLimits,
  chargeLimitsRelevant,
  formatTemp,
  fromCanonicalC,
  limitsNeedSending,
  resolveTempUnit,
  tempBounds,
  tempFieldState,
  tempStep,
  toCanonicalC,
} from "./settings";

describe("chargeLimitsRelevant", () => {
  it("shows the section for plug-in powertrains", () => {
    expect(chargeLimitsRelevant("EV", false)).toBe(true);
    expect(chargeLimitsRelevant("PHEV", false)).toBe(true);
    // A weird status shape must never override a positive classification.
    expect(chargeLimitsRelevant("EV", true)).toBe(true);
    expect(chargeLimitsRelevant("PHEV", true)).toBe(true);
  });

  it("hides the section for positive non-plug powertrains", () => {
    expect(chargeLimitsRelevant("HEV", false)).toBe(false);
    expect(chargeLimitsRelevant("ICE", false)).toBe(false);
    expect(chargeLimitsRelevant("ICE", undefined)).toBe(false);
  });

  it("keeps UNKNOWN permissive unless the car showed fuel-only evidence", () => {
    expect(chargeLimitsRelevant("UNKNOWN", false)).toBe(true);
    expect(chargeLimitsRelevant("UNKNOWN", undefined)).toBe(true);
    expect(chargeLimitsRelevant("UNKNOWN", true)).toBe(false);
  });

  it("treats a label this build doesn't know like UNKNOWN", () => {
    expect(chargeLimitsRelevant("FCEV", false)).toBe(true);
    expect(chargeLimitsRelevant("FCEV", true)).toBe(false);
  });

  it("shows everything when no classification has ever been seen", () => {
    expect(chargeLimitsRelevant(undefined, undefined)).toBe(true);
    expect(chargeLimitsRelevant(null, undefined)).toBe(true);
  });
});

/** Temperature units. climateTemp is Celsius on disk and on the wire in every
 *  case — these helpers only decide what the user reads and types. */

const withSettings = (over: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});

describe("resolveTempUnit", () => {
  it("infers Fahrenheit for the US and Celsius everywhere else", () => {
    expect(resolveTempUnit(withSettings({ region: 3 }))).toBe("F");
    expect(resolveTempUnit(withSettings({ region: 1 }))).toBe("C");
    expect(resolveTempUnit(withSettings({ region: 2 }))).toBe("C");
    expect(resolveTempUnit(withSettings({ region: 5 }))).toBe("C");
  });

  it("defaults a fresh install to Celsius", () => {
    expect(resolveTempUnit(DEFAULT_SETTINGS)).toBe("C");
  });

  it("lets an explicit choice beat the region", () => {
    expect(resolveTempUnit(withSettings({ region: 3, tempUnit: "C" }))).toBe("C");
    expect(resolveTempUnit(withSettings({ region: 1, tempUnit: "F" }))).toBe("F");
  });
});

describe("toCanonicalC", () => {
  it("passes Celsius through on the 0.5 grid", () => {
    expect(toCanonicalC(21, "C")).toBe(21);
    expect(toCanonicalC(22.5, "C")).toBe(22.5);
    // Off-grid entry snaps rather than reaching the proxy as 22.3.
    expect(toCanonicalC(22.3, "C")).toBe(22.5);
  });

  it("converts Fahrenheit to Celsius", () => {
    expect(toCanonicalC(70, "F")).toBe(21);
    expect(toCanonicalC(72, "F")).toBe(22);
  });

  it("clamps to the proxy's 14–30°C validation in both units", () => {
    expect(toCanonicalC(5, "C")).toBe(14);
    expect(toCanonicalC(99, "C")).toBe(30);
    // 40°F is 4.4°C and 120°F is 48.9°C — both well outside.
    expect(toCanonicalC(40, "F")).toBe(14);
    expect(toCanonicalC(120, "F")).toBe(30);
  });

  it("falls back to the default rather than storing NaN", () => {
    expect(toCanonicalC(NaN, "C")).toBe(DEFAULT_SETTINGS.climateTemp);
    expect(toCanonicalC(NaN, "F")).toBe(DEFAULT_SETTINGS.climateTemp);
  });
});

describe("temperature round-tripping", () => {
  it("returns every whole Fahrenheit value in range unchanged", () => {
    // The 0.5°C storage grid must not drift a user's F setting: a 1°F step is
    // 0.56°C, wider than the 0.25°C worst-case snapping error.
    const { min, max } = tempBounds("F");
    for (let f = min; f <= max; f++) {
      expect(fromCanonicalC(toCanonicalC(f, "F"), "F")).toBe(f);
    }
  });

  it("returns every half-degree Celsius value in range unchanged", () => {
    for (let c = 14; c <= 30; c += 0.5) {
      expect(fromCanonicalC(toCanonicalC(c, "C"), "C")).toBe(c);
    }
  });

  it("keeps Fahrenheit bounds strictly inside the Celsius ones", () => {
    // 14°C is 57.2°F, so entering the F minimum must not clamp up to 58 again.
    const { min, max } = tempBounds("F");
    expect(min).toBe(58);
    expect(max).toBe(86);
    expect(toCanonicalC(min, "F")).toBeGreaterThanOrEqual(14);
    expect(toCanonicalC(max, "F")).toBeLessThanOrEqual(30);
  });
});

describe("tempFieldState", () => {
  it("describes the Celsius field exactly as the pre-toggle markup did", () => {
    expect(tempFieldState(21, "C")).toEqual({
      value: "21",
      min: "14",
      max: "30",
      step: "0.5",
      label: "Climate target temperature (°C)",
    });
  });

  it("moves the value, bounds, step and label together for Fahrenheit", () => {
    expect(tempFieldState(21, "F")).toEqual({
      value: "70",
      min: "58",
      max: "86",
      step: "1",
      label: "Climate target temperature (°F)",
    });
  });

  it("keeps the value within the bounds it ships with", () => {
    // The failure this guards: a Fahrenheit value left against Celsius bounds,
    // where the browser clamps 70 down to 30 on the user's behalf.
    for (const unit of ["C", "F"] as const) {
      for (let c = 14; c <= 30; c += 0.5) {
        const f = tempFieldState(c, unit);
        expect(Number(f.value)).toBeGreaterThanOrEqual(Number(f.min));
        expect(Number(f.value)).toBeLessThanOrEqual(Number(f.max));
      }
    }
  });
});

describe("stepping the climate target in Fahrenheit", () => {
  // The stored value is Celsius on a 0.5 grid; the F field steps in whole
  // degrees. A 1°F step is 0.56°C — only slightly wider than the 0.5°C grid —
  // so this is exactly where a stepper can start showing the same number twice
  // in a row, or a decimal that no car resolves. Walk the whole range.
  const { min, max } = tempBounds("F");
  const sweep = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  it("steps in whole degrees, so the field can never show a decimal", () => {
    expect(tempStep("F")).toBe(1);
    for (const f of sweep) expect(Number.isInteger(f)).toBe(true);
  });

  it("never shows the same reading twice — every °F is a distinct target", () => {
    // The failure this rules out: two adjacent F readings snapping to the same
    // 0.5°C, so pressing + appears to do nothing after a save/reload.
    const stored = sweep.map((f) => toCanonicalC(f, "F"));
    expect(new Set(stored).size).toBe(sweep.length);
    for (let i = 1; i < stored.length; i++) {
      expect(stored[i]).toBeGreaterThan(stored[i - 1]);
    }
  });

  it("survives the round trip through 0.5°C storage at every step", () => {
    // Step to a value, save, reopen: the field must read back what was set.
    for (const f of sweep) {
      const field = tempFieldState(toCanonicalC(f, "F"), "F");
      expect(field.value).toBe(String(f));
    }
  });

  it("keeps the whole sweep inside the field's own bounds", () => {
    for (const f of sweep) {
      const c = toCanonicalC(f, "F");
      expect(c).toBeGreaterThanOrEqual(14);
      expect(c).toBeLessThanOrEqual(30);
      expect(fromCanonicalC(c, "F")).toBeGreaterThanOrEqual(min);
      expect(fromCanonicalC(c, "F")).toBeLessThanOrEqual(max);
    }
  });
});

describe("carKnownLimits", () => {
  const sent = { ac: 80, dc: 90, at: 1_000_000 };

  it("believes the car when it reports its own limits", () => {
    expect(carKnownLimits(undefined, { ac: 70, dc: 100 }, 0)).toEqual({
      ac: 70,
      dc: 100,
    });
  });

  it("believes a fresh send over a status that hasn't caught up", () => {
    // The car takes 30–90 s to apply; a poll inside that window still reports
    // the old values, and trusting it would re-raise the send button seconds
    // after a successful send.
    const now = sent.at + CHARGE_LIMITS_SETTLE_MS - 1;
    expect(carKnownLimits(sent, { ac: 50, dc: 50 }, now)).toEqual({
      ac: 80,
      dc: 90,
    });
  });

  it("hands authority back to the car once the send has settled", () => {
    // Otherwise a limit changed in the manufacturer's own app would be masked
    // forever by a stale send record.
    const now = sent.at + CHARGE_LIMITS_SETTLE_MS + 1;
    expect(carKnownLimits(sent, { ac: 50, dc: 50 }, now)).toEqual({
      ac: 50,
      dc: 50,
    });
  });

  it("trusts the last send FOREVER when the car reports nothing", () => {
    // Plenty of EVs never send charge_limit_ac/dc. There is no second source to
    // hand authority back to, so the settle window must not apply — ageing the
    // send out would leave the button permanently offered on a car that can
    // never satisfy it, greeting the user on every launch with an action they
    // have already taken. A partial report is no report.
    const aYearLater = sent.at + 365 * 24 * 3600_000;
    expect(carKnownLimits(sent, {}, aYearLater)).toEqual({ ac: 80, dc: 90 });
    expect(carKnownLimits(sent, { ac: 70, dc: null }, aYearLater)).toEqual({
      ac: 80,
      dc: 90,
    });
    // Which is the whole point: the button stays down until the form moves.
    expect(limitsNeedSending(80, 90, carKnownLimits(sent, {}, aYearLater))).toBe(
      false,
    );
    expect(
      limitsNeedSending(80, 100, carKnownLimits(sent, {}, aYearLater)),
    ).toBe(true);
  });

  it("admits it doesn't know when neither source has anything", () => {
    expect(carKnownLimits(undefined, {}, 0)).toBeNull();
    expect(carKnownLimits(undefined, { ac: 70 }, 0)).toBeNull();
  });
});

describe("limitsNeedSending", () => {
  it("offers the send only while the form and the car disagree", () => {
    expect(limitsNeedSending(80, 90, { ac: 80, dc: 90 })).toBe(false);
    expect(limitsNeedSending(90, 90, { ac: 80, dc: 90 })).toBe(true);
    expect(limitsNeedSending(80, 100, { ac: 80, dc: 90 })).toBe(true);
  });

  it("offers the send when nothing is known about the car", () => {
    // A car that doesn't report its limits and has never been sent any is the
    // one case where the user has no other way to find out.
    expect(limitsNeedSending(80, 90, null)).toBe(true);
  });
});

describe("formatTemp", () => {
  it("labels the value in the requested unit", () => {
    expect(formatTemp(21, "C")).toBe("21°C");
    expect(formatTemp(22.5, "C")).toBe("22.5°C");
    expect(formatTemp(21, "F")).toBe("70°F");
  });

  it("never shows a fractional Fahrenheit degree", () => {
    expect(formatTemp(22.5, "F")).toBe("73°F");
  });
});
