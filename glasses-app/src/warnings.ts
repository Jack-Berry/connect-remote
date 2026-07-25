/**
 * Car-reported warnings, app side: the copy, and the rules about when a line
 * is allowed to appear on the glasses.
 *
 * The proxy owns the truth (which flags this car provably reports, whether
 * they fire, and whether the data is fresh enough to make the claim — see
 * backend/app/warnings.py). Everything here is presentation and precedence.
 *
 * Two hard rules the copy has to carry:
 *
 * 1. **It reports, it never diagnoses.** Every line starts "Car reports…"
 *    because we have never observed one of these flags actually firing on a
 *    real car (docs-internal/WARNINGS-FIELDS.md, global confidence ceiling).
 *    If the flag turns out to mean something else, the copy was still true.
 * 2. **It must never invite a tap.** A single tap on the HUD is the hide-HUD
 *    toggle: a user who instinctively taps to dismiss a warning would blank
 *    their whole display. No "tap to dismiss", no "OK", nothing imperative.
 *    The 5 s auto-clear is the dismissal.
 *
 * Lives in its own module, not in main.ts, for the reason display.ts already
 * learned the hard way: main.ts is unreachable from a test, and this decides
 * what the owner is told about their car.
 */

import type { VehicleStatus } from "./api";

/** Severity order, highest first. The proxy sends the array in this order
 *  too, but the glasses re-rank rather than trusting position: an older or
 *  newer proxy must not be able to promote a key by sending it first. */
export const WARNING_SEVERITY: string[] = [
  "brake_fluid_low",
  "tyre_pressure_low",
  "smart_key_battery_low",
  "washer_fluid_low",
];

/** One line each, deliberately plain. British spelling matches the rest of
 *  the app's copy ("tyre", "bonnet", "boot"). */
export const WARNING_COPY: Record<string, string> = {
  brake_fluid_low: "Car reports low brake fluid",
  tyre_pressure_low: "Car reports low tyre pressure",
  smart_key_battery_low: "Car reports key fob battery low",
  washer_fluid_low: "Car reports washer fluid low",
};

/**
 * The keys this app can actually render, most severe first, de-duplicated.
 *
 * Keys we have no copy for are dropped, not passed through: a newer proxy
 * shipping `dtc_present` must show the owner nothing rather than a raw
 * snake_case key. That is also why an app update, not a proxy deploy, is what
 * turns a new warning on for the glasses.
 */
export function activeWarnings(status: VehicleStatus | null): string[] {
  const keys = status?.warnings;
  if (!Array.isArray(keys)) return [];
  const known = keys.filter(
    (k): k is string => typeof k === "string" && k in WARNING_COPY,
  );
  return WARNING_SEVERITY.filter((k) => known.includes(k));
}

/**
 * The single line the glasses show: the most severe warning, plus a count of
 * the others when there is more than one. Null when there is nothing
 * renderable — the common case by a wide margin.
 *
 * Deliberately NOT "Car reports multiple warnings: check phone". That trades
 * the one fact worth glancing at (brake fluid, say) for a number, and sends
 * the owner to another device to learn what a specific line could have told
 * them outright. "+2 more" keeps the severest fact, admits there is more, and
 * asks nothing of anyone — the phone banner already lists all of them for
 * whenever they next look. (Switching to the aggregate wording is a one-line
 * change here if that trade ever looks right.)
 */
export function warningLine(status: VehicleStatus | null): string | null {
  const active = activeWarnings(status);
  if (!active.length) return null;
  const line = WARNING_COPY[active[0]];
  return active.length > 1 ? `${line}  +${active.length - 1} more` : line;
}

/** Every active warning as copy, most severe first — the phone banner lists
 *  all of them where the glasses show one. */
export function warningLines(status: VehicleStatus | null): string[] {
  return activeWarnings(status).map((k) => WARNING_COPY[k]);
}

/**
 * Paint the phone's warning banner: one line per active warning, hidden
 * entirely when there are none (the overwhelmingly common case).
 *
 * Here rather than in main.ts so a test can drive it against the real
 * index.html — an id typo between the markup and the lookup is the realistic
 * way this silently stops working, and it would fail open (banner never
 * shows) on the one surface that has room to list every warning.
 */
export function renderWarningBanner(doc: Document, lines: string[]): void {
  const banner = doc.getElementById("warning-banner");
  const list = doc.getElementById("warning-list");
  if (!banner || !list) return; // glasses-only host: no phone DOM at all
  list.replaceChildren(
    ...lines.map((text) => {
      const div = doc.createElement("div");
      div.textContent = text;
      return div;
    }),
  );
  banner.hidden = lines.length === 0;
}

/** What the app is doing right now, from the warning's point of view. Every
 *  field is a reason to stay silent. */
export interface WarningContext {
  /** Anything but "hud" means the band this line lives in isn't on screen. */
  view: string;
  /** User-chosen "glasses off". Painting through it would undo their choice. */
  hudHidden: boolean;
  /** Page isn't on the glasses at all. */
  backgrounded: boolean;
  /** A transient command confirmation or error owns the band right now. */
  noteActive: boolean;
}

/**
 * Once-per-launch warning display, gated on the app actually being able to
 * show it.
 *
 * Pending-until-paintable rather than fire-on-status, because the first
 * /status routinely lands while the user is still on connecting — or is in
 * settings, the menu, or the finder. Fire-and-forget there would burn the
 * one showing on a screen the line can't appear on.
 *
 * Precedence, from docs-internal/WARNINGS-FIELDS.md §precedence:
 *   · transient command notes and errors win ABSOLUTELY — a warning arriving
 *     during one waits and paints when the band frees up;
 *   · the PHEV EV line and the charging line are not evicted, they are
 *     stacked under (formatHudBottom does that half);
 *   · hidden HUD, finder and the connect/menu pages: silence, and never a
 *     re-show of a HUD the user hid.
 */
export class WarningGate {
  private pending: string | null = null;
  private shown = false;

  /** Feed it every status. Cheap, idempotent, and safe to call from anywhere. */
  offer(status: VehicleStatus | null): void {
    if (this.shown) return;
    // A fault that clears before we ever got to show it is not shown at all —
    // the pending line always describes the latest status, never an older one.
    this.pending = warningLine(status);
  }

  /** Is a warning waiting for a chance to paint? (Diagnostics + tests.) */
  get isPending(): boolean {
    return this.pending !== null && !this.shown;
  }

  /** Has this launch already had its one warning? */
  get isSpent(): boolean {
    return this.shown;
  }

  /**
   * Take the line if it may be painted right now, else null and it stays
   * pending. Taking it spends the once-per-launch allowance — call this only
   * where the paint immediately follows.
   */
  claim(ctx: WarningContext): string | null {
    if (this.shown || this.pending === null) return null;
    if (ctx.backgrounded || ctx.view !== "hud") return null;
    if (ctx.hudHidden || ctx.noteActive) return null;
    const line = this.pending;
    this.pending = null;
    this.shown = true;
    return line;
  }
}
