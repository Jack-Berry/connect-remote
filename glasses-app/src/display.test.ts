/** Honest-degradation render tests: every absent-field path must draw
 *  nothing for that field — never "0%", "?", "undefined", "null" or a crash.
 *  Statuses here mirror what the proxy actually sends per powertrain
 *  (backend/tests/test_powertrain.py is the other half of the contract). */

import { getTextWidth } from "@evenrealities/pretext";
import { describe, expect, it } from "vitest";

import type { VehicleStatus } from "./api";
import {
  arrowCell,
  buildMenuItems,
  formatFinder,
  formatHudBottom,
  formatHudRow,
  formatMenuInfo,
  hasEnergyData,
  prioritiseMenu,
  sameMenu,
} from "./display";
import type { FinderView } from "./finder";
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
    // Three lines always: the band is bottom-aligned inside a three-line box
    // (a warning can stack above these two), so short blocks carry blank
    // padding on top and the content still ends flush with the panel edge.
    const lines = formatHudBottom(s).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].trim()).toBe("");
    expect(lines[1]).toContain("25 mi  55%");
    expect(lines[2]).toContain("Charging (1h35m left)");
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

describe("buildMenuItems climate temperature unit", () => {
  const climateLabel = (s: Partial<typeof DEFAULT_SETTINGS>) =>
    buildMenuItems(EV, { ...DEFAULT_SETTINGS, ...s }).find(
      (i) => i.key === "climateOn",
    )?.label;

  it("shows Celsius by default, unchanged from before the toggle", () => {
    expect(climateLabel({ climateTemp: 21 })).toBe("Climate on (21°C)");
    expect(climateLabel({ climateTemp: 22.5 })).toBe("Climate on (22.5°C)");
  });

  it("shows Fahrenheit when the user chose it", () => {
    expect(climateLabel({ climateTemp: 21, tempUnit: "F" })).toBe(
      "Climate on (70°F)",
    );
  });

  it("follows the US region when no unit was chosen", () => {
    expect(climateLabel({ climateTemp: 21, region: 3 })).toBe(
      "Climate on (70°F)",
    );
    expect(climateLabel({ climateTemp: 21, region: 1 })).toBe(
      "Climate on (21°C)",
    );
  });

  it("keeps the unit alongside the defrost suffix", () => {
    expect(
      climateLabel({ climateTemp: 21, tempUnit: "F", climateDefrost: true }),
    ).toBe("Climate on (70°F +defrost)");
  });

  it("truncates defrost+heat at the same point in either unit", () => {
    // Pre-existing pxTruncate behaviour, not a unit problem: the label is
    // already too wide for MENU_ITEM_MAX_PX with both suffixes. "°F" and "°C"
    // are the same width, so the toggle must not move where it cuts.
    const both = { climateTemp: 21, climateDefrost: true, climateHeating: true };
    expect(climateLabel({ ...both, tempUnit: "C" })).toBe(
      "Climate on (21°C +defrost ...",
    );
    expect(climateLabel({ ...both, tempUnit: "F" })).toBe(
      "Climate on (70°F +defrost ...",
    );
  });
});

describe("car finder menu item", () => {
  const items = (s: VehicleStatus | null) =>
    buildMenuItems(s, DEFAULT_SETTINGS).map((i) => i.key);

  it("offers Find my car when the car reported where it is", () => {
    expect(items({ ...EV, latitude: 51.5072, longitude: -0.1276 })).toContain(
      "finder",
    );
  });

  it("still offers it when the car has not reported a position", () => {
    // Deliberately unlike the charge actions. A missing position is transient
    // — asleep car, stale cache, no status yet — so the item must not come and
    // going with it (that reads as a bug). Entering reaches the finder's
    // "Car position unknown" state, which explains itself.
    expect(items(EV)).toContain("finder");
    expect(items({ ...EV, latitude: 51.5072 })).toContain("finder"); // half a fix
    expect(items(null)).toContain("finder");
  });

  it("offers it for a fuel car too — the finder is powertrain-independent", () => {
    expect(items({ ...HEV, latitude: 51.5072, longitude: -0.1276 })).toContain(
      "finder",
    );
  });

  it("keeps it out of the way of the everyday commands", () => {
    // The selector lands at the top of the list; lock/climate are the daily
    // actions and Find my car is occasional, so it sits below them. This also
    // pins the item's index, which the QA walkthrough depends on.
    const keys = items({ ...EV, latitude: 51.5072, longitude: -0.1276 });
    expect(keys.indexOf("finder")).toBeGreaterThan(keys.indexOf("lock"));
    expect(keys.indexOf("finder")).toBeLessThan(keys.indexOf("refresh"));
  });
});

describe("prioritiseMenu", () => {
  const keys = (s: VehicleStatus | null, max: number) =>
    prioritiseMenu(buildMenuItems(s, DEFAULT_SETTINGS), max).map((i) => i.key);

  it("keeps the way back, the finder and the way out in a three-slot menu", () => {
    // The host accepts only a short list on hardware. 1.4.4 shipped a blind
    // slice(0, 3), which cut Find my car and stranded the owner.
    expect(keys(EV, 3)).toEqual(["hud", "finder", "quit"]);
  });

  it("pins Quit to the bottom wherever it survives", () => {
    for (const max of [0, 3, 4, 5, 6]) {
      const out = keys(EV, max);
      // An exit item in the middle of the list is a mis-tap waiting to happen.
      expect(out[out.length - 1]).toBe("quit");
    }
  });

  it("drops Quit only in the last-ditch two-slot menu", () => {
    // Two slots go to the way back and the finder. There is no visible way
    // out at that size — double-tap still opens the same system dialog, and a
    // menu that can't reach the feature is worse than one without an exit row.
    expect(keys(EV, 2)).toEqual(["hud", "finder"]);
  });

  it("keeps the build order otherwise, so the list doesn't reshuffle", () => {
    const full = buildMenuItems(EV, DEFAULT_SETTINGS).map((i) => i.key);
    const kept = keys(EV, 5);
    const expectedOrder = full.filter((k) => kept.includes(k) && k !== "quit");
    expect(kept.filter((k) => k !== "quit")).toEqual(expectedOrder);
  });

  it("caps at max and never drops below it when items are available", () => {
    for (const max of [2, 3, 4, 5]) {
      expect(keys(EV, max)).toHaveLength(max);
    }
  });

  it("treats 0 as no cap", () => {
    expect(keys(EV, 0)).toHaveLength(
      buildMenuItems(EV, DEFAULT_SETTINGS).length,
    );
  });

  it("keeps duplicate-looking items distinct (identity, not label matching)", () => {
    // Two items could share a label after pxTruncate; filtering by value
    // identity must not collapse or duplicate them.
    const items = [
      { key: "hud", label: "Return to HUD" },
      { key: "lock", label: "Same" },
      { key: "unlock", label: "Same" },
      { key: "finder", label: "Find my car" },
      { key: "quit", label: "Quit" },
    ] as ReturnType<typeof buildMenuItems>;
    expect(prioritiseMenu(items, 3).map((i) => i.key)).toEqual([
      "hud",
      "finder",
      "quit",
    ]);
  });
});

describe("sameMenu against a truncated on-screen menu", () => {
  // THE REGRESSION. renderCurrent asked "has the menu changed?" by comparing a
  // freshly built (untruncated) list against the truncated one on screen. Those
  // can never match once the host caps the list, so every status poll rebuilt
  // the whole menu page — including the poll openMenu fires the instant the
  // menu appears. That rebuild recreates the list container under the user's
  // finger, and the press aimed at "Find my car" was eaten.
  const onScreen = (s: VehicleStatus | null, cap: number) =>
    prioritiseMenu(buildMenuItems(s, DEFAULT_SETTINGS), cap);

  it("never matches when the raw build is compared to a capped menu", () => {
    for (const s of [EV, HEV, null]) {
      const raw = buildMenuItems(s, DEFAULT_SETTINGS);
      expect(sameMenu(raw, onScreen(s, 3))).toBe(false);
    }
  });

  it("matches when both sides go through the same cap — no rebuild", () => {
    for (const cap of [0, 2, 3, 4, 5, 6]) {
      for (const s of [EV, HEV, null]) {
        const fresh = onScreen(s, cap);
        expect(sameMenu(fresh, onScreen(s, cap))).toBe(true);
      }
    }
  });

  it("still reports a genuine change through the cap", () => {
    // Locked → unlocked swaps which action the menu offers. With a 4-slot cap
    // that item is on screen, so the rebuild is the right answer.
    const locked = onScreen({ ...EV, locked: true }, 4);
    const unlocked = onScreen({ ...EV, locked: false }, 4);
    expect(locked.map((i) => i.key)).not.toEqual(unlocked.map((i) => i.key));
    expect(sameMenu(locked, unlocked)).toBe(false);
  });
});

describe("formatFinder", () => {
  const view = (over: Partial<FinderView> = {}): FinderView => ({
    mode: "walking",
    arrow: "↑",
    headline: "140m",
    detail: "",
    hint: "Tap: back",
    octant: 0,
    arrival: { streak: 0, lastFixAt: 0 },
    ...over,
  });

  it("centres the arrow by measuring the glyph, not by a fixed offset", () => {
    // The arrow set is not monospace: → and ← are 272 units, the diagonals
    // 224. A fixed x-position twitches ~3px every time the direction crosses
    // between a cardinal and a diagonal — constantly, while walking.
    expect(getTextWidth(arrowCell("→"))).toBeCloseTo(
      getTextWidth(arrowCell("↗")),
      -1,
    );
  });

  it("blanks the arrow cell rather than collapsing it", () => {
    // The container keeps its row so the headline never jumps as the user
    // starts and stops walking.
    expect(arrowCell(null)).toBe(" ");
  });

  it("always renders a hint, so no finder state is a blank screen", () => {
    const out = formatFinder(
      view({ mode: "problem", arrow: null, headline: "No GPS signal", detail: "a\nb" }),
    );
    expect(out.main.trim()).toBe("No GPS signal");
    expect(out.foot).toContain("Tap: back");
  });
});
