/**
 * Car-reported warnings on the glasses: the copy, and every collision in
 * docs-internal/WARNINGS-FIELDS.md §"Glasses bottom-band precedence".
 *
 * The band is a single 576px-wide container shared by transient command
 * notes, the PHEV both-sides EV line, the charging line and the "limited
 * data" fallback — and a tap on it is the hide-HUD toggle, so a warning that
 * lands wrongly doesn't just look wrong, it can blank someone's display or
 * evict the only EV readout their car has. Each collision below is one of
 * those eight cases, pinned.
 */

import { getTextWidth } from "@evenrealities/pretext";
import { describe, expect, it } from "vitest";

import type { VehicleStatus } from "./api";
import { formatHudBottom } from "./display";
import {
  WARNING_COPY,
  WARNING_SEVERITY,
  WarningGate,
  activeWarnings,
  warningLine,
  warningLines,
} from "./warnings";

const EV: VehicleStatus = {
  powertrain: "EV",
  soc_percent: 80,
  range_value: 310,
  range_unit: "mi",
  locked: true,
  charging: false,
};

// The hard case: the band is this car's ONLY EV readout, and it is charging,
// so it already occupies two lines before a warning arrives.
const PHEV_CHARGING: VehicleStatus = {
  powertrain: "PHEV",
  soc_percent: 55,
  range_value: 25,
  range_unit: "mi",
  fuel_level_percent: 60,
  fuel_range: 340,
  locked: true,
  charging: true,
  charge_eta_minutes: 95,
};

const withWarnings = (s: VehicleStatus, ...keys: string[]): VehicleStatus => ({
  ...s,
  warnings: keys,
});

/** The band as the user reads it: blank alignment padding removed. */
const bandLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const HUD = {
  view: "hud",
  hudHidden: false,
  backgrounded: false,
  noteActive: false,
};

// ---------------------------------------------------------------------------
// Copy and ranking.

describe("warning copy", () => {
  it("reports, never diagnoses — every line starts 'Car reports'", () => {
    // We have never observed one of these flags firing on a real car. If the
    // flag turns out to mean something else, "Car reports…" is still true.
    for (const key of WARNING_SEVERITY) {
      expect(WARNING_COPY[key]).toMatch(/^Car reports /);
    }
  });

  it("never invites a tap — a tap on the HUD hides the whole display", () => {
    for (const key of WARNING_SEVERITY) {
      // Whole words: "low tyre pressure" contains "press" and is fine — it is
      // the imperative that must never appear.
      expect(WARNING_COPY[key].toLowerCase()).not.toMatch(
        /\b(tap|press|click|dismiss|ok|close|touch)\b/,
      );
    }
  });

  it("covers exactly the four keys the proxy's first cut emits", () => {
    expect(WARNING_SEVERITY).toEqual([
      "brake_fluid_low",
      "tyre_pressure_low",
      "smart_key_battery_low",
      "washer_fluid_low",
    ]);
    expect(Object.keys(WARNING_COPY).sort()).toEqual(
      [...WARNING_SEVERITY].sort(),
    );
  });

  it("shows the highest severity, whatever order the proxy sent", () => {
    const status = withWarnings(EV, "washer_fluid_low", "brake_fluid_low");
    expect(warningLine(status)).toBe(
      `${WARNING_COPY.brake_fluid_low}  +1 more`,
    );
  });

  it("counts the others rather than going vague about all of them", () => {
    // "Car reports multiple warnings: check phone" would drop the one fact
    // worth glancing at. The severest line stays; the count admits there is
    // more; the phone banner has the list.
    const status = withWarnings(
      EV,
      "washer_fluid_low",
      "smart_key_battery_low",
      "brake_fluid_low",
    );
    expect(warningLine(status)).toBe(
      `${WARNING_COPY.brake_fluid_low}  +2 more`,
    );
    // A lone warning carries no count — nothing to disambiguate.
    expect(warningLine(withWarnings(EV, "brake_fluid_low"))).toBe(
      WARNING_COPY.brake_fluid_low,
    );
  });

  it("fits the 576px band even at its longest", () => {
    // Longest copy + the largest count the four keys can produce.
    const longest = warningLine(
      withWarnings(EV, ...WARNING_SEVERITY),
    ) as string;
    expect(getTextWidth(longest)).toBeLessThan(576 - 2 * 4);
  });

  it("lists all active warnings, most severe first, for the phone", () => {
    const status = withWarnings(
      EV,
      "washer_fluid_low",
      "smart_key_battery_low",
      "brake_fluid_low",
    );
    expect(warningLines(status)).toEqual([
      WARNING_COPY.brake_fluid_low,
      WARNING_COPY.smart_key_battery_low,
      WARNING_COPY.washer_fluid_low,
    ]);
  });

  it("drops keys it has no copy for rather than rendering raw snake_case", () => {
    // A newer proxy shipping dtc_present must show the owner nothing until an
    // app update gives that key words.
    const status = withWarnings(EV, "dtc_present", "washer_fluid_low");
    expect(activeWarnings(status)).toEqual(["washer_fluid_low"]);
    expect(warningLine(status)).toBe(WARNING_COPY.washer_fluid_low);
  });

  it("de-duplicates a repeated key", () => {
    expect(
      activeWarnings(withWarnings(EV, "washer_fluid_low", "washer_fluid_low")),
    ).toEqual(["washer_fluid_low"]);
  });

  it("draws nothing for the normal cases: no field, empty, null status", () => {
    expect(warningLine(EV)).toBeNull();
    expect(warningLine(withWarnings(EV))).toBeNull();
    expect(warningLine(null)).toBeNull();
    expect(warningLines(null)).toEqual([]);
  });

  it("survives junk in the array without crashing the HUD", () => {
    const junk = { ...EV, warnings: [null, 7, {}, "brake_fluid_low"] } as
      unknown as VehicleStatus;
    expect(warningLine(junk)).toBe(WARNING_COPY.brake_fluid_low);
    const notAnArray = { ...EV, warnings: "brake_fluid_low" } as unknown as
      VehicleStatus;
    expect(warningLine(notAnArray)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Collision 2/3/8: the band's other occupants.

describe("bottom band composition", () => {
  it("stacks above the PHEV EV line and the charging line, evicting neither", () => {
    const band = formatHudBottom(
      PHEV_CHARGING,
      "",
      WARNING_COPY.tyre_pressure_low,
    );
    expect(bandLines(band)).toEqual([
      WARNING_COPY.tyre_pressure_low,
      "25 mi  55%", // the ONLY place this car's EV data appears
      "Charging (1h35m left)",
    ]);
  });

  it("keeps the band bottom-aligned so nothing jumps as lines appear", () => {
    // The container renders top-down; short blocks are padded on top so a
    // one-line band sits on the same pixels as the last line of a three-line
    // one. Without this the charging line would visibly jump 32px whenever a
    // warning arrived.
    const oneLine = formatHudBottom({ ...EV, charging: true }).split("\n");
    const threeLine = formatHudBottom(
      PHEV_CHARGING,
      "",
      WARNING_COPY.brake_fluid_low,
    ).split("\n");
    expect(oneLine).toHaveLength(3);
    expect(threeLine).toHaveLength(3);
    expect(oneLine.slice(0, 2).every((l) => l.trim() === "")).toBe(true);
    expect(oneLine[2].trim()).toBe("Charging");
  });

  it("replaces the 'limited data' fallback, which only fills an empty band", () => {
    const bare: VehicleStatus = { powertrain: "UNKNOWN", locked: true };
    expect(bandLines(formatHudBottom(bare))).toEqual([
      "Limited data for this vehicle",
    ]);
    expect(
      bandLines(formatHudBottom(bare, "", WARNING_COPY.washer_fluid_low)),
    ).toEqual([WARNING_COPY.washer_fluid_low]);
  });

  it("collision 1: a command note outranks a warning outright", () => {
    // Notes are absolute — the user just asked for something and is waiting to
    // hear whether it was sent.
    expect(
      bandLines(
        formatHudBottom(
          PHEV_CHARGING,
          "Unlock sent, car applies in 30-90s",
          WARNING_COPY.brake_fluid_low,
        ),
      ),
    ).toEqual(["Unlock sent, car applies in 30-90s"]);
  });

  it("renders a warning even before any status has landed", () => {
    expect(bandLines(formatHudBottom(null, "", WARNING_COPY.brake_fluid_low))).toEqual(
      [WARNING_COPY.brake_fluid_low],
    );
  });

  it("still returns a blank band when there is nothing at all to say", () => {
    expect(formatHudBottom(EV)).toBe(" ");
    expect(formatHudBottom(null)).toBe(" ");
  });
});

// ---------------------------------------------------------------------------
// The gate: collisions 1, 4, 5, 6 — when a warning is allowed to exist.

describe("WarningGate", () => {
  it("collision 6: a status arriving before the first HUD paint waits", () => {
    // The launch /status routinely lands while the user is still on the
    // connecting page. Fire-and-forget there would spend the one showing on a
    // screen that has no band.
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    expect(gate.claim({ ...HUD, view: "connect" })).toBeNull();
    expect(gate.isPending).toBe(true);
    expect(gate.claim(HUD)).toBe(WARNING_COPY.brake_fluid_low);
  });

  it("collision 1: re-queues behind a command note instead of being lost", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "tyre_pressure_low"));
    expect(gate.claim({ ...HUD, noteActive: true })).toBeNull();
    expect(gate.isPending).toBe(true);
    // The note clears; the band is ours.
    expect(gate.claim(HUD)).toBe(WARNING_COPY.tyre_pressure_low);
  });

  it("collision 5: never paints while the HUD is hidden", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    expect(gate.claim({ ...HUD, hudHidden: true })).toBeNull();
    // And it does NOT re-show a HUD the user deliberately hid: the gate can
    // only ever hand back a line, never request a view change. Once unhidden,
    // it paints.
    expect(gate.claim(HUD)).toBe(WARNING_COPY.brake_fluid_low);
  });

  it("collision 4: never fires into the finder view", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "washer_fluid_low"));
    expect(gate.claim({ ...HUD, view: "finder" })).toBeNull();
    expect(gate.claim({ ...HUD, view: "menu" })).toBeNull();
    expect(gate.isPending).toBe(true);
  });

  it("never paints while backgrounded — the page isn't on the glasses", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "washer_fluid_low"));
    expect(gate.claim({ ...HUD, backgrounded: true })).toBeNull();
    expect(gate.isPending).toBe(true);
  });

  it("shows once per app launch, however many statuses arrive", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    expect(gate.claim(HUD)).toBe(WARNING_COPY.brake_fluid_low);
    expect(gate.isSpent).toBe(true);
    // Every subsequent poll still carries the warning; none of them re-show it.
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    gate.offer(withWarnings(EV, "tyre_pressure_low"));
    expect(gate.claim(HUD)).toBeNull();
    expect(gate.isPending).toBe(false);
  });

  it("tracks the latest status while pending, not the first", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "washer_fluid_low"));
    // A more serious fault appears before the user ever reaches the HUD.
    gate.offer(withWarnings(EV, "brake_fluid_low", "washer_fluid_low"));
    expect(gate.claim(HUD)).toBe(`${WARNING_COPY.brake_fluid_low}  +1 more`);
  });

  it("forgets a fault that clears before it was ever shown", () => {
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "washer_fluid_low"));
    gate.offer(withWarnings(EV)); // topped up at the services
    expect(gate.claim(HUD)).toBeNull();
    expect(gate.isPending).toBe(false);
    // …and having never shown anything, it is still armed for a real one.
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    expect(gate.claim(HUD)).toBe(WARNING_COPY.brake_fluid_low);
  });

  it("stays silent for the overwhelmingly common healthy car", () => {
    const gate = new WarningGate();
    gate.offer(EV);
    gate.offer(null);
    expect(gate.claim(HUD)).toBeNull();
    expect(gate.isPending).toBe(false);
  });

  it("does not spend the launch's showing on a blocked claim", () => {
    // The precise bug this guards: a claim that returns null must leave the
    // gate armed. Marking it shown on a blocked attempt would mean a warning
    // that arrived during a command confirmation was never seen at all.
    const gate = new WarningGate();
    gate.offer(withWarnings(EV, "brake_fluid_low"));
    for (const ctx of [
      { ...HUD, view: "connect" },
      { ...HUD, view: "menu" },
      { ...HUD, view: "finder" },
      { ...HUD, hudHidden: true },
      { ...HUD, backgrounded: true },
      { ...HUD, noteActive: true },
    ]) {
      expect(gate.claim(ctx)).toBeNull();
      expect(gate.isSpent).toBe(false);
    }
    expect(gate.claim(HUD)).toBe(WARNING_COPY.brake_fluid_low);
  });
});
