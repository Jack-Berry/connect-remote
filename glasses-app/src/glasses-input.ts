/**
 * Glasses event routing — the tap/gesture decision, lifted out of main.ts so it
 * can be tested against real payload shapes.
 *
 * WHY THIS MODULE EXISTS (1.4.1 regression): the router itself was never wrong,
 * but it was welded inside `subscribeEvents()` behind main.ts's top-level
 * `await waitForEvenAppBridge()`, so nothing could drive it in a test. A
 * hardware round shipped with gestures dead app-wide (single tap did nothing,
 * double tap skipped the menu straight to the exit dialog) while a green suite
 * and a clean simulator sweep said everything was fine. The router is pure now,
 * so the gesture matrix is a unit test instead of a walk outside.
 *
 * Two platform facts this encodes, both load-bearing:
 *
 *  1. **proto3 elides zero values.** `CLICK_EVENT` is 0, so a single tap arrives
 *     with `eventType` ABSENT, not 0. Every read is `?? 0` — drop that and taps
 *     become invisible. (`assertsClickIsZero` in the tests pins it against the
 *     SDK enum, because the whole elision trick collapses if that ever moves.)
 *  2. **A tap can arrive as `sysEvent` OR `textEvent`.** The full-screen
 *     event-capture container reports through `textEvent`; system-level taps
 *     come through `sysEvent`. Both mean the same gesture, so both are checked.
 *
 * The router reads a snapshot of state and returns an action — it mutates
 * nothing, so a test can assert "in state X, this payload does Y" for the whole
 * matrix, with or without a phone finder session live.
 */

import { OsEventTypeList } from "@evenrealities/even_hub_sdk";

/** Guard against a repeat double-tap chaining HUD→menu→close-app. */
export const DOUBLE_CLICK_DEBOUNCE_MS = 800;

/** The glasses page currently believed to be on screen. */
export type GlassesView = "connect" | "hud" | "menu" | "finder";

/**
 * The event as the host actually delivers it: every field optional, every
 * `eventType` possibly elided. Deliberately structural rather than the SDK's
 * type — tests build these by hand and must be able to omit fields exactly the
 * way proto3 does.
 */
export interface RawGlassesEvent {
  sysEvent?: { eventType?: number | null } | null;
  textEvent?: { eventType?: number | null } | null;
  listEvent?: { currentSelectItemIndex?: number | null } | null;
}

export interface RouterState {
  view: GlassesView;
  connectState: "connecting" | "failed";
  /** Whether credentials exist — a connect-page tap can only retry with one. */
  hasClient: boolean;
  /** When the last double-tap was accepted (debounce). */
  lastDoubleClickAt: number;
  now: number;
}

export type GlassesAction =
  | { kind: "ignore" }
  | { kind: "openMenu" }
  | { kind: "exitDialog" }
  | { kind: "systemExit" }
  | { kind: "foregroundEnter" }
  | { kind: "foregroundExit" }
  | { kind: "selectMenuItem"; index: number }
  | { kind: "retryConnect" }
  | { kind: "exitFinder" }
  | { kind: "toggleHud" };

export interface RouteResult {
  action: GlassesAction;
  /** Set when a double-tap was accepted; the caller stores it for the debounce.
   *  Kept out of the router so the function stays pure. */
  acceptedDoubleClickAt?: number;
  /** Which branch fired — the label that lands in the diagnostic input trace. */
  branch: string;
}

/** `eventType`, with proto3's elided-zero restored. Null when the sub-event is
 *  absent entirely (which is different from "present but zero"). */
function typeOf(sub: { eventType?: number | null } | null | undefined): number | null {
  return sub ? (sub.eventType ?? 0) : null;
}

function isClick(sysType: number | null, textType: number | null): boolean {
  return (
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT
  );
}

/**
 * Decide what a glasses event means. Pure: same inputs, same answer, no clock
 * of its own (the caller supplies `now`) and no state written.
 *
 * Order matters and matches the shipped router exactly:
 *   double-tap → lifecycle (exit/foreground) → menu selection → per-view tap.
 */
export function routeGlassesEvent(
  event: RawGlassesEvent,
  state: RouterState,
): RouteResult {
  const sysType = typeOf(event.sysEvent);
  const textType = typeOf(event.textEvent);
  const listIndex = event.listEvent
    ? (event.listEvent.currentSelectItemIndex ?? 0)
    : null;

  // Double-tap: HUD → actions menu; everywhere else → the system close dialog.
  // Cleanup happens on SYSTEM_EXIT, not here — the user can still cancel.
  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    if (state.now - state.lastDoubleClickAt < DOUBLE_CLICK_DEBOUNCE_MS) {
      return { action: { kind: "ignore" }, branch: "double/debounced" };
    }
    return state.view === "hud"
      ? {
          action: { kind: "openMenu" },
          acceptedDoubleClickAt: state.now,
          branch: "double/openMenu",
        }
      : {
          action: { kind: "exitDialog" },
          acceptedDoubleClickAt: state.now,
          branch: "double/exitDialog",
        };
  }

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    return { action: { kind: "systemExit" }, branch: "sys/exit" };
  }
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    return { action: { kind: "foregroundEnter" }, branch: "sys/fgEnter" };
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    return { action: { kind: "foregroundExit" }, branch: "sys/fgExit" };
  }

  // Menu: the firmware scrolls natively; a tap reports the selected item.
  if (listIndex !== null && state.view === "menu") {
    return {
      action: { kind: "selectMenuItem", index: listIndex },
      branch: "list/select",
    };
  }

  const click = isClick(sysType, textType);

  // Connect page: a tap retries only after a failure with credentials present.
  if (state.view === "connect" && click) {
    return state.hasClient && state.connectState === "failed"
      ? { action: { kind: "retryConnect" }, branch: "click/retryConnect" }
      : { action: { kind: "ignore" }, branch: "click/connect-noop" };
  }
  // Finder: a tap goes back to the HUD (and releases the GPS watch).
  if (state.view === "finder" && click) {
    return { action: { kind: "exitFinder" }, branch: "click/exitFinder" };
  }
  // HUD: a tap toggles "glasses off".
  if (state.view === "hud" && click) {
    return { action: { kind: "toggleHud" }, branch: "click/toggleHud" };
  }

  return { action: { kind: "ignore" }, branch: "unhandled" };
}

// ---------------------------------------------------------------------------
// View transitions
//
// The 1.4.0 regression's amplifier: `view` was assigned BEFORE the page rebuild
// that realises it, with no rollback. One rejected rebuild (a jammed BLE link)
// left `view` naming a page that was not on screen — and from that moment the
// router, reading a lie, matched no tap branch at all and sent every double-tap
// to the exit dialog. The state must never claim a page the glasses aren't
// showing, so the commit happens only once the rebuild lands.

/**
 * Run a page rebuild and commit `view` only if it succeeds; roll back to the
 * previous view if it doesn't. Returns whether the transition took.
 *
 * `setView` is injected rather than closed over so this is testable without
 * main.ts's module state.
 */
export async function commitView(
  target: GlassesView,
  previous: GlassesView,
  setView: (v: GlassesView) => void,
  rebuild: () => Promise<unknown>,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  // Optimistic: renderers that fire DURING the rebuild must already see the
  // target view, or the first frame paints into the wrong branch.
  setView(target);
  try {
    await rebuild();
    return true;
  } catch (err) {
    // The rebuild never landed, so the old page is still up. Believing
    // otherwise is what bricked the gestures.
    setView(previous);
    onError?.(err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input trace
//
// One hardware minute should be enough to diagnose any future gesture
// regression: what the host actually sent, which branch fired, and what state
// the router believed at the time. Without this the 1.4.0 round cost a walk
// outside and a guess.

export interface InputTraceEntry {
  at: number;
  /** Raw payload shape, e.g. "text(elided)" / "sys(3)" / "list(2)". */
  raw: string;
  branch: string;
  view: GlassesView;
}

export interface InputTrace {
  record(event: RawGlassesEvent, branch: string, state: RouterState): void;
  /** Newest last, one line each — for the diagnostic report. */
  lines(now: number): string[];
  entries(): InputTraceEntry[];
}

/** Describe the payload the way the host sent it, preserving the distinction
 *  between an absent eventType (proto3 elision) and an explicit value — the
 *  exact thing a gesture bug turns on. */
export function describeRawEvent(event: RawGlassesEvent): string {
  const parts: string[] = [];
  const shape = (
    name: string,
    sub: { eventType?: number | null } | null | undefined,
  ) => {
    if (!sub) return;
    parts.push(
      sub.eventType == null ? `${name}(elided)` : `${name}(${sub.eventType})`,
    );
  };
  shape("sys", event.sysEvent);
  shape("text", event.textEvent);
  if (event.listEvent) {
    parts.push(`list(${event.listEvent.currentSelectItemIndex ?? 0})`);
  }
  if (parts.length) return parts.join("+");
  // Nothing we recognise. Name the keys the host DID send — an envelope we
  // don't read (audioEvent, or something newer) must be visible rather than
  // silently indistinguishable from "no event at all".
  const keys = Object.keys(event ?? {});
  return keys.length ? `other{${keys.join(",")}}` : "empty";
}

export function createInputTrace(limit = 10): InputTrace {
  const entries: InputTraceEntry[] = [];
  return {
    record(event, branch, state) {
      entries.push({
        at: state.now,
        raw: describeRawEvent(event),
        branch,
        view: state.view,
      });
      if (entries.length > limit) entries.shift();
    },
    entries: () => entries.slice(),
    lines(now) {
      return entries.map(
        (e) =>
          `${Math.max(0, Math.round((now - e.at) / 1000))}s ago ${e.raw}` +
          ` → ${e.branch} (view ${e.view})`,
      );
    },
  };
}
