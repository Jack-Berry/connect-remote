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
  | "chargeStop";

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

  const charging = status?.charging ?? null;
  if (charging === true) items.push(chargeStop);
  else if (charging === false) items.push(chargeStart);
  else items.push(chargeStart, chargeStop);

  // Cached /status only — force refresh is deliberately not on the glasses.
  const updated = timeOf(status?.last_updated ?? null);
  items.push({
    key: "refresh",
    label: updated === "?" ? "Refresh" : `Refresh · updated ${updated}`,
  });

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

function timeOf(iso: string | null): string {
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

// HUD top row: brand · lock state · range · SoC, evenly spaced across the
// full width. Nothing else lives on the HUD except the bottom line.
export function formatHudRow(status: VehicleStatus | null): string {
  return justifyRow(
    [
      BRAND.name,
      status?.locked == null ? "Lock ?" : status.locked ? "Locked" : "UNLOCKED",
      status?.range_value != null
        ? `${status.range_value} ${status.range_unit}`
        : "range ?",
      status?.soc_percent != null ? `${status.soc_percent}%` : "?%",
    ],
    HUD_ROW_INNER_W,
  );
}

// HUD bottom line, centred: transient notes (command sent / errors) take
// precedence; otherwise the charging line, shown only while charging.
export function formatHudBottom(
  status: VehicleStatus | null,
  note = "",
): string {
  const text = note || (status?.charging ? chargingLine(status) : "");
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

export function formatConnectFail(message: string): string {
  return centerBlock(`${message}\nDouble-tap to retry`, HUD_INNER_W);
}

// Right-hand info panel of the menu: compact status + feedback line.
export function formatMenuInfo(
  status: VehicleStatus | null,
  note = "",
): string {
  const lines: string[] = [];
  if (status) {
    const soc = status.soc_percent != null ? `${status.soc_percent}%` : "?%";
    const range =
      status.range_value != null
        ? `${status.range_value} ${status.range_unit}`
        : "range ?";
    lines.push(`${soc}  ${range}`);
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
      `Updated ${timeOf(status.last_updated)}${status.stale ? " — STALE" : ""}`,
    );
  } else {
    lines.push("No data yet.");
  }
  lines.push("");
  lines.push(note || "Tap: send\n2x tap: close app");
  return lines.join("\n");
}
