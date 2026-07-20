/** Phone-form powertrain rule: the charge-limits section (AC/DC prefs +
 *  "Send limits to car") exists only for cars that plug in. The fuelOnly
 *  flag means the status carried a fuel level with no EV battery — which the
 *  proxy only emits on genuine fuel evidence, never for an EV. */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  type AppSettings,
  chargeLimitsRelevant,
  formatTemp,
  fromCanonicalC,
  resolveTempUnit,
  tempBounds,
  tempFieldState,
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
