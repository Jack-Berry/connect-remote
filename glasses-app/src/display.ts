import { getTextWidth, pxTruncate } from "@evenrealities/pretext";

import type { VehicleStatus } from "./api";
import { BRAND } from "./brand";
import type { AppSettings } from "./settings";

// Two-layer UI on the 576x288 canvas:
//   Layer 1 (HUD)  — one justified status row on top, charging/notes
//                    bottom-centre, invisible full-screen event layer.
//   Layer 2 (menu) — firmware list container as a left sidebar + an info
//                    panel text container on the right.
export const HUD_CONTAINER = { containerID: 1, containerName: "hud" };
export const HUD_ROW_CONTAINER = { containerID: 4, containerName: "hudrow" };
export const HUD_NOTE_CONTAINER = { containerID: 5, containerName: "hudnote" };
export const MENU_LIST_CONTAINER = { containerID: 2, containerName: "menu" };
export const MENU_INFO_CONTAINER = {
  containerID: 3,
  containerName: "menuinfo",
};
export const CONNECT_CONTAINER = { containerID: 6, containerName: "connect" };
export const CONNECT_SPIN_CONTAINER = {
  containerID: 7,
  containerName: "connectspin",
};

// Geometry shared with main.ts. Sidebar is wide enough for the longest item
// label ("Refresh · updated 14:12" ≈ 200px + list item padding).
export const MENU_LIST_WIDTH = 272;
export const HUD_PADDING = 4;
// Top row spans only the central 80% of the canvas — flush to the panel
// edges it looked lopsided (left item tighter to the edge than the right).
export const HUD_ROW_X = 58;
export const HUD_ROW_W = 460;
// LVGL text is always left-aligned; even spacing and centring are done by
// inserting spaces measured against the real glyph widths.
const HUD_ROW_INNER_W = HUD_ROW_W - 2 * HUD_PADDING;
const HUD_INNER_W = 576 - 2 * HUD_PADDING;
const SPACE_W = getTextWidth("x x") - getTextWidth("xx");
// Longest usable item width: sidebar minus border+padding and the firmware's
// 12px per-side item padding.
const MENU_ITEM_MAX_PX = MENU_LIST_WIDTH - 2 * 5 - 2 * 12;

function padSpaces(px: number): string {
  return " ".repeat(Math.max(0, Math.round(px / SPACE_W)));
}

// space-between with equal gaps. Aim 10px inside the true width; the leading
// space splits that slack across both ends so the row sits centred.
function justifyRow(items: string[], innerW: number): string {
  const widths = items.map(getTextWidth);
  const total = widths.reduce((a, b) => a + b, 0);
  const gap = (innerW - 10 - total) / (items.length - 1);
  if (gap < SPACE_W) return items.join(" ");
  const counts: number[] = []; // spaces between item i-1 and i
  let x = widths[0];
  let target = widths[0];
  for (let i = 1; i < items.length; i++) {
    target += gap;
    counts.push(Math.max(1, Math.round((target - x) / SPACE_W)));
    x += counts[i - 1] * SPACE_W + widths[i];
    target += widths[i];
  }
  const render = () =>
    " " +
    items.map((it, i) => (i ? " ".repeat(counts[i - 1]) : "") + it).join("");
  // Space-count estimates ignore kerning across glyph/space boundaries and the
  // leading space, so the built row can land a few px past innerW — the glasses
  // then wrap the last item onto a clipped second line. Measure the real string
  // and shave spaces (widest gap first) until it genuinely fits.
  let out = render();
  while (getTextWidth(out) > innerW) {
    const widest = counts.indexOf(Math.max(...counts));
    if (counts[widest] <= 1) return items.join(" ");
    counts[widest]--;
    out = render();
  }
  return out;
}

function centerBlock(text: string, innerW: number): string {
  return text
    .split("\n")
    .map((line) => padSpaces((innerW - getTextWidth(line)) / 2) + line)
    .join("\n");
}

export type MenuKey =
  | "hud"
  | "refresh"
  | "lock"
  | "unlock"
  | "climateOn"
  | "climateOff"
  | "chargeStart"
  | "chargeStop"
  | "quit";

export interface MenuItem {
  key: MenuKey;
  label: string;
}

// Context-aware menu: show the action that makes sense for the current state;
// when a state is unknown (no data yet), offer both directions.
export function buildMenuItems(
  status: VehicleStatus | null,
  s: AppSettings,
): MenuItem[] {
  const items: MenuItem[] = [{ key: "hud", label: "Return to HUD" }];

  const lock: MenuItem = { key: "lock", label: "Lock" };
  const unlock: MenuItem = { key: "unlock", label: "Unlock" };
  const climateOn: MenuItem = {
    key: "climateOn",
    label: `Climate on (${s.climateTemp}°C${s.climateDefrost ? " +defrost" : ""}${
      s.climateHeating ? " +heat" : ""
    })`,
  };
  const climateOff: MenuItem = { key: "climateOff", label: "Climate off" };
  const chargeStart: MenuItem = { key: "chargeStart", label: "Start charging" };
  const chargeStop: MenuItem = { key: "chargeStop", label: "Stop charging" };

  const locked = status?.locked ?? null;
  if (locked === true) items.push(unlock);
  else if (locked === false) items.push(lock);
  else items.push(lock, unlock);

  const climate = status?.climate_on ?? null;
  if (climate === true) items.push(climateOff);
  else if (climate === false) items.push(climateOn);
  else items.push(climateOn, climateOff);

  // Charging actions only when the car verifiably plugs in: hidden for
  // HEV/ICE and whenever the charging field is absent — no data is not an
  // EV. (Climate and lock/unlock stay universal above.)
  const pt = status?.powertrain ?? "UNKNOWN";
  const charging = status?.charging ?? null;
  if (charging != null && pt !== "HEV" && pt !== "ICE") {
    items.push(charging ? chargeStop : chargeStart);
  }

  // Cached /status only — force refresh is deliberately not on the glasses.
  const updated = timeOf(status?.last_updated ?? null);
  items.push({
    key: "refresh",
    label: updated === "?" ? "Refresh" : `Refresh · updated ${updated}`,
  });

  // Explicit exit path in the list, alongside double-tap: both open the
  // system close dialog.
  items.push({ key: "quit", label: "Quit" });

  return items.map((i) => ({
    ...i,
    label: pxTruncate(i.label, MENU_ITEM_MAX_PX),
  }));
}

export function sameMenu(a: MenuItem[], b: MenuItem[]): boolean {
  return (
    a.length === b.length && a.every((item, i) => item.label === b[i].label)
  );
}

function timeOf(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "?";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function chargingLine(status: VehicleStatus): string {
  let c = "Charging";
  if (status.charge_eta_minutes != null) {
    const h = Math.floor(status.charge_eta_minutes / 60);
    const m = status.charge_eta_minutes % 60;
    c += ` (${h ? `${h}h` : ""}${m}m left)`;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Honest degradation: an energy line renders only when its fields are
// genuinely present — an absent field draws nothing, never "0%", "?" or
// "undefined". The proxy guarantees fuel fields are never sent for an EV
// (every EV payload upstream carries a vestigial fuelLevel: 0), so presence
// here can be trusted.

// EV-side items in HUD order: range, then SoC.
function evItems(status: VehicleStatus): string[] {
  const items: string[] = [];
  if (status.range_value != null) {
    const unit = status.range_unit ?? "";
    items.push(`${status.range_value}${unit ? ` ${unit}` : ""}`);
  }
  if (status.soc_percent != null) items.push(`${status.soc_percent}%`);
  return items;
}

// "Fuel 62% · 310mi" — either half alone if that's all the car reports.
function fuelLine(status: VehicleStatus): string | null {
  const parts: string[] = [];
  if (status.fuel_level_percent != null)
    parts.push(`${status.fuel_level_percent}%`);
  if (status.fuel_range != null)
    parts.push(`${status.fuel_range}${status.range_unit ?? ""}`);
  return parts.length ? `Fuel ${parts.join(" · ")}` : null;
}

export function hasEnergyData(status: VehicleStatus | null): boolean {
  return (
    status != null && (evItems(status).length > 0 || fuelLine(status) != null)
  );
}

// True when the car reports both sides (PHEV, or an UNKNOWN with genuine
// fuel evidence and EV data). Both-sides cars split across the two HUD
// containers: fuel keeps the top row (like HEV/ICE), the EV side moves to
// the bottom line — one row can't comfortably hold both on 576px.
function isBothSides(status: VehicleStatus): boolean {
  return fuelLine(status) != null && evItems(status).length > 0;
}

// HUD top row: brand · lock state · whatever energy data the car genuinely
// reports (EV: range + SoC; HEV/ICE/PHEV: fuel), evenly spaced. Nothing
// else lives on the HUD except the bottom line.
export function formatHudRow(status: VehicleStatus | null): string {
  const lock =
    status?.locked == null ? "Lock ?" : status.locked ? "Locked" : "UNLOCKED";
  // No data yet (pre-first-fetch): the placeholders read as "loading",
  // not as a car reporting zeros.
  if (!status) {
    return justifyRow([BRAND.name, lock, "range ?", "?%"], HUD_ROW_INNER_W);
  }
  const items = [BRAND.name, lock];
  const fuel = fuelLine(status);
  if (isBothSides(status)) items.push(fuel as string);
  else if (fuel) items.push(fuel);
  else items.push(...evItems(status));
  // Shouldn't happen since both-sides cars split across the containers,
  // but flag rather than silently wrap if a row still runs long.
  if (getTextWidth(items.join(" ")) > HUD_ROW_INNER_W) {
    console.warn(`HUD row overflows 576px: ${items.join(" | ")}`);
  }
  return justifyRow(items, HUD_ROW_INNER_W);
}

// HUD bottom block, centred. Transient notes (command sent / errors) take
// precedence over everything, then:
//   · both-sides cars (PHEV): the EV line ("25 mi  55%"), with the charging
//     line stacked directly below it while charging — same spot where a
//     pure EV's charging line lives;
//   · pure EV: the charging line while charging;
//   · a car with no renderable energy data at all: an honest "limited data"
//     notice so the near-empty top row doesn't read as a malfunction.
export function formatHudBottom(
  status: VehicleStatus | null,
  note = "",
): string {
  let text = note;
  if (!text && status) {
    const lines: string[] = [];
    if (isBothSides(status)) lines.push(evItems(status).join("  "));
    if (status.charging) lines.push(chargingLine(status));
    if (!lines.length && !hasEnergyData(status))
      lines.push("Limited data for this vehicle");
    text = lines.join("\n");
  }
  if (!text) return " ";
  return centerBlock(text, HUD_INNER_W);
}

// Connecting page: no HUD until the first successful /status — a HUD of
// empty values reads as "the car is broken". The spinner (one 90° step per
// second, plain text-frame swap — this display has no native animation)
// lives in its own fixed-position cell so nothing shifts between frames,
// and the corner triangles all fill the same square box, so the filled
// corner rotates evenly around the glyph's own centre. (◐◑ exist in the
// firmware font but ◓◒ don't, so a half-circle spin isn't possible.)
export const SPINNER_FRAMES = ["◤", "◥", "◢", "◣"];
export const CONNECT_SPIN_W = 64;
export const CONNECT_SPIN_X = (560 - CONNECT_SPIN_W) / 2;

export const CONNECTING_TEXT = centerBlock("Connecting…", HUD_INNER_W);

export function spinnerFrame(i: number): string {
  const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
  return (
    padSpaces((CONNECT_SPIN_W - 2 * HUD_PADDING - getTextWidth(frame)) / 2) +
    frame
  );
}

export function formatConnectFail(
  message: string,
  hint = "Tap to retry · double-tap to exit",
): string {
  return centerBlock(`${message}\n${hint}`, HUD_INNER_W);
}

// Right-hand info panel of the menu: compact status + feedback line.
export function formatMenuInfo(
  status: VehicleStatus | null,
  note = "",
): string {
  const lines: string[] = [];
  if (status) {
    // Same honest degradation as the HUD: render only what's present.
    const ev = evItems(status);
    const fuel = fuelLine(status);
    if (ev.length) lines.push(ev.join("  "));
    if (fuel) lines.push(fuel);
    if (!ev.length && !fuel) lines.push("Limited data for this vehicle");
    lines.push(
      status.locked == null
        ? "Lock ?"
        : status.locked
          ? "Locked"
          : "! UNLOCKED",
    );
    if (status.charging) lines.push(chargingLine(status));
    if (status.climate_on) lines.push("Climate ON");
    lines.push(
      `Updated ${timeOf(status.last_updated)}${status.stale ? " (STALE)" : ""}`,
    );
  } else {
    lines.push("No data yet.");
  }
  lines.push("");
  lines.push(note || "Tap: send\n2x tap: close app");
  return lines.join("\n");
}
