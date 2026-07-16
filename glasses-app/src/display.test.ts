/** Honest-degradation render tests: every absent-field path must draw
 *  nothing for that field — never "0%", "?", "undefined", "null" or a crash.
 *  Statuses here mirror what the proxy actually sends per powertrain
 *  (backend/tests/test_powertrain.py is the other half of the contract). */

import { describe, expect, it } from "vitest";

import type { VehicleStatus } from "./api";
import {
  buildMenuItems,
  formatHudBottom,
  formatHudRow,
  formatMenuInfo,
  hasEnergyData,
} from "./display";
import { DEFAULT_SETTINGS } from "./settings";

const EV: VehicleStatus = {
  powertrain: "EV",
  soc_percent: 80,
  range_value: 310,
  range_unit: "mi",
  locked: true,
  charging: false,
};

const HEV: VehicleStatus = {
  powertrain: "HEV",
  fuel_level_percent: 62,
  fuel_range: 310,
  range_unit: "mi",
  locked: true,
  // charging/soc/range genuinely absent — the proxy never sends them for HEV
};

const PHEV: VehicleStatus = {
  powertrain: "PHEV",
  soc_percent: 55,
  range_value: 25,
  range_unit: "mi",
  fuel_level_percent: 60,
  fuel_range: 340,
  total_range: 365,
  locked: false,
  charging: false,
};

const LIMITED: VehicleStatus = { powertrain: "UNKNOWN", locked: true };

describe("formatHudRow", () => {
  it("renders EV range and SoC", () => {
    const row = formatHudRow(EV);
    expect(row).toContain("310 mi");
    expect(row).toContain("80%");
    expect(row).not.toContain("Fuel");
  });

  it("renders the fuel line for an HEV, with no EV placeholders", () => {
    const row = formatHudRow(HEV);
    expect(row).toContain("Fuel 62% · 310mi");
    expect(row).not.toContain("?");
    expect(row).not.toContain("0%"); // no vestigial zeros
  });

  it("puts fuel on the top row for a PHEV and moves the EV side off it", () => {
    const row = formatHudRow(PHEV);
    expect(row).toContain("Fuel 60% · 340mi");
    expect(row).not.toContain("25 mi");
    expect(row).not.toContain("55%");
  });

  it("renders brand + lock only when no energy data exists", () => {
    const row = formatHudRow(LIMITED);
    expect(row).toContain("Locked");
    expect(row).not.toContain("%");
    expect(row).not.toContain("Fuel");
  });

  it("keeps loading placeholders only for a null status (pre-first-fetch)", () => {
    const row = formatHudRow(null);
    expect(row).toContain("range ?");
    expect(row).toContain("?%");
  });

  it("renders a partial fuel line when only the level is known", () => {
    const row = formatHudRow({ powertrain: "ICE", fuel_level_percent: 40 });
    expect(row).toContain("Fuel 40%");
    expect(row).not.toContain("·");
  });

  it("never renders undefined/null/NaN for degenerate statuses", () => {
    const degenerates: VehicleStatus[] = [
      {},
      { powertrain: null, soc_percent: null, range_value: null, range_unit: null },
      { fuel_level_percent: null, fuel_range: null },
      { soc_percent: 0 }, // zero is real data, not absence
    ];
    for (const s of degenerates) {
      const out = formatHudRow(s) + formatHudBottom(s) + formatMenuInfo(s);
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null");
      expect(out).not.toContain("NaN");
    }
  });

  it("renders a real 0% SoC (zero is data, absence is not)", () => {
    expect(formatHudRow({ soc_percent: 0 })).toContain("0%");
  });
});

describe("formatHudBottom", () => {
  it("shows the limited-data notice when nothing energy-ish is present", () => {
    expect(formatHudBottom(LIMITED)).toContain("Limited data for this vehicle");
  });

  it("prefers a transient note over the limited-data notice", () => {
    expect(formatHudBottom(LIMITED, "Command sent")).toContain("Command sent");
    expect(formatHudBottom(LIMITED, "Command sent")).not.toContain("Limited");
  });

  it("shows nothing extra for a healthy EV", () => {
    expect(formatHudBottom(EV).trim()).toBe("");
  });

  it("still shows the charging line while charging", () => {
    const s = { ...EV, charging: true, charge_eta_minutes: 95 };
    expect(formatHudBottom(s)).toContain("Charging (1h35m left)");
  });

  it("shows the PHEV EV side on the bottom line", () => {
    const bottom = formatHudBottom(PHEV);
    expect(bottom).toContain("25 mi  55%");
    expect(bottom).not.toContain("Charging");
    expect(bottom).not.toContain("Limited");
  });

  it("stacks the PHEV EV line directly above the charging line", () => {
    const s = { ...PHEV, charging: true, charge_eta_minutes: 95 };
    const lines = formatHudBottom(s).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("25 mi  55%");
    expect(lines[1]).toContain("Charging (1h35m left)");
  });

  it("keeps note precedence over the PHEV EV line", () => {
    expect(formatHudBottom(PHEV, "Command sent")).not.toContain("25 mi");
  });
});

describe("hasEnergyData", () => {
  it.each([
    [EV, true],
    [HEV, true],
    [PHEV, true],
    [LIMITED, false],
    [null, false],
  ])("case %#", (s, expected) => {
    expect(hasEnergyData(s)).toBe(expected);
  });
});

describe("buildMenuItems charging degradation", () => {
  const keys = (s: VehicleStatus | null) =>
    buildMenuItems(s, DEFAULT_SETTINGS).map((i) => i.key);

  it("offers a charge action for an EV with charging data", () => {
    expect(keys(EV)).toContain("chargeStart");
    expect(keys({ ...EV, charging: true })).toContain("chargeStop");
  });

  it("hides charge actions for HEV and ICE", () => {
    expect(keys(HEV)).not.toContain("chargeStart");
    expect(keys(HEV)).not.toContain("chargeStop");
    // Even a (bogus) charging flag must not resurrect them.
    const weirdIce: VehicleStatus = { powertrain: "ICE", charging: false };
    expect(keys(weirdIce)).not.toContain("chargeStart");
  });

  it("hides charge actions when the charging field is absent", () => {
    expect(keys(LIMITED)).not.toContain("chargeStart");
    expect(keys(null)).not.toContain("chargeStart");
  });

  it("keeps charge actions for UNKNOWN when charging data exists", () => {
    const s: VehicleStatus = { powertrain: "UNKNOWN", charging: false };
    expect(keys(s)).toContain("chargeStart");
  });

  it("always keeps lock and climate", () => {
    for (const s of [EV, HEV, PHEV, LIMITED, null]) {
      const k = keys(s);
      expect(k.some((x) => x === "lock" || x === "unlock")).toBe(true);
      expect(k.some((x) => x === "climateOn" || x === "climateOff")).toBe(true);
      expect(k).toContain("hud");
      expect(k).toContain("quit");
    }
  });
});

describe("formatMenuInfo", () => {
  it("shows the fuel line for an HEV", () => {
    const info = formatMenuInfo(HEV);
    expect(info).toContain("Fuel 62% · 310mi");
    expect(info).not.toContain("?%");
  });

  it("shows the limited-data notice when nothing is renderable", () => {
    expect(formatMenuInfo(LIMITED)).toContain("Limited data for this vehicle");
  });

  it("still shows both sides for a PHEV", () => {
    const info = formatMenuInfo(PHEV);
    expect(info).toContain("25 mi  55%");
    expect(info).toContain("Fuel 60% · 340mi");
  });
});
