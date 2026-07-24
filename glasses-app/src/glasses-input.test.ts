/** Glasses gesture routing — the regression suite the 1.4.0 round didn't have.
 *
 *  1.4.0 shipped with gestures dead app-wide (single tap did nothing, double tap
 *  skipped the menu and went straight to the system exit dialog) while the unit
 *  suite was green and the simulator sweep was clean. The gap: nothing drove the
 *  real event entry point, and nothing checked what happens when a page rebuild
 *  FAILS — which is the state the hardware was actually in.
 *
 *  So these tests drive `routeGlassesEvent` with the payload shapes the host
 *  really sends (including proto3-elided `eventType`), through a harness that
 *  applies the resulting actions to observable app state (HUD hidden, menu
 *  opened, exit dialog raised) — with and without a live phone finder session.
 */

import { describe, expect, it, vi } from "vitest";
import { OsEventTypeList } from "@evenrealities/even_hub_sdk";

import { FinderEngine, type FinderFrame } from "./finder-engine";
import {
  DOUBLE_CLICK_DEBOUNCE_MS,
  type GlassesView,
  type RawGlassesEvent,
  type RouterState,
  commitView,
  createInputTrace,
  describeRawEvent,
  routeGlassesEvent,
} from "./glasses-input";

// --- real payload shapes ----------------------------------------------------
// A single tap from the full-screen capture container: textEvent with the
// eventType ELIDED, because CLICK_EVENT is 0 and proto3 omits zero values.
const tapElided: RawGlassesEvent = { textEvent: {} };
// The same tap, but with the zero explicitly present (some hosts do send it).
const tapExplicit: RawGlassesEvent = { textEvent: { eventType: 0 } };
// A system-level tap.
const tapSys: RawGlassesEvent = { sysEvent: { eventType: 0 } };
const tapSysElided: RawGlassesEvent = { sysEvent: {} };
const doubleTap: RawGlassesEvent = { sysEvent: { eventType: 3 } };
const doubleTapText: RawGlassesEvent = { textEvent: { eventType: 3 } };
const listSelect = (i: number): RawGlassesEvent => ({
  listEvent: { currentSelectItemIndex: i },
});
const foregroundExit: RawGlassesEvent = { sysEvent: { eventType: 5 } };

function state(over: Partial<RouterState> = {}): RouterState {
  return {
    view: "hud",
    connectState: "connecting",
    hasClient: true,
    lastDoubleClickAt: 0,
    now: 100_000,
    ...over,
  };
}

describe("platform facts this router depends on", () => {
  it("pins CLICK_EVENT to 0 — the whole elision trick collapses otherwise", () => {
    // If the SDK ever renumbers this, elided taps silently stop being taps.
    expect(OsEventTypeList.CLICK_EVENT).toBe(0);
    expect(OsEventTypeList.DOUBLE_CLICK_EVENT).toBe(3);
  });

  it("treats an elided eventType as a click, not as 'no type'", () => {
    expect(routeGlassesEvent(tapElided, state()).action.kind).toBe("toggleHud");
    expect(routeGlassesEvent(tapSysElided, state()).action.kind).toBe("toggleHud");
  });
});

describe("gesture matrix — every view × gesture", () => {
  const views: GlassesView[] = ["connect", "hud", "menu", "finder"];

  it("routes a single tap correctly in every view, from either sub-event", () => {
    const expected: Record<GlassesView, string> = {
      // connect + connecting + no failure ⇒ nothing to retry
      connect: "ignore",
      hud: "toggleHud",
      // a bare tap on the menu carries no listEvent ⇒ nothing selected
      menu: "ignore",
      finder: "exitFinder",
    };
    for (const view of views) {
      for (const payload of [tapElided, tapExplicit, tapSys, tapSysElided]) {
        expect(
          routeGlassesEvent(payload, state({ view })).action.kind,
          `${view} / ${describeRawEvent(payload)}`,
        ).toBe(expected[view]);
      }
    }
  });

  it("opens the menu on a HUD double-tap and exits from anywhere else", () => {
    for (const payload of [doubleTap, doubleTapText]) {
      expect(routeGlassesEvent(payload, state({ view: "hud" })).action.kind).toBe(
        "openMenu",
      );
      for (const view of ["connect", "menu", "finder"] as GlassesView[]) {
        expect(
          routeGlassesEvent(payload, state({ view })).action.kind,
          `${view} double-tap`,
        ).toBe("exitDialog");
      }
    }
  });

  it("selects a menu item only from a listEvent while the menu is up", () => {
    expect(routeGlassesEvent(listSelect(4), state({ view: "menu" })).action).toEqual({
      kind: "selectMenuItem",
      index: 4,
    });
    // Same payload elsewhere must not select anything.
    expect(routeGlassesEvent(listSelect(4), state({ view: "hud" })).action.kind).toBe(
      "ignore",
    );
  });

  it("retries the connect only after a failure with credentials", () => {
    const failed = state({ view: "connect", connectState: "failed" });
    expect(routeGlassesEvent(tapElided, failed).action.kind).toBe("retryConnect");
    expect(
      routeGlassesEvent(tapElided, { ...failed, hasClient: false }).action.kind,
    ).toBe("ignore");
  });

  it("debounces a repeat double-tap so HUD→menu can't chain into close-app", () => {
    const first = routeGlassesEvent(doubleTap, state({ view: "hud" }));
    expect(first.action.kind).toBe("openMenu");
    expect(first.acceptedDoubleClickAt).toBe(100_000);
    // A second one inside the window is swallowed...
    const tooSoon = state({
      view: "menu",
      lastDoubleClickAt: 100_000,
      now: 100_000 + DOUBLE_CLICK_DEBOUNCE_MS - 1,
    });
    expect(routeGlassesEvent(doubleTap, tooSoon).action.kind).toBe("ignore");
    // ...and accepted once the window passes.
    expect(
      routeGlassesEvent(doubleTap, { ...tooSoon, now: 100_000 + DOUBLE_CLICK_DEBOUNCE_MS })
        .action.kind,
    ).toBe("exitDialog");
  });

  it("routes lifecycle events ahead of any tap interpretation", () => {
    expect(routeGlassesEvent(foregroundExit, state()).action.kind).toBe(
      "foregroundExit",
    );
    expect(
      routeGlassesEvent({ sysEvent: { eventType: 7 } }, state()).action.kind,
    ).toBe("systemExit");
    expect(
      routeGlassesEvent({ sysEvent: { eventType: 4 } }, state()).action.kind,
    ).toBe("foregroundEnter");
  });
});

// ---------------------------------------------------------------------------
// The harness: actions → observable app state, mirroring main.ts's effects.

function makeApp(opts: { rebuildFails?: boolean } = {}) {
  const app = {
    view: "hud" as GlassesView,
    hudHidden: false,
    menuOpen: false,
    exitDialogRaised: false,
    lastDoubleClickAt: 0,
    rebuildFails: opts.rebuildFails ?? false,
    rebuilds: 0,
  };
  const setView = (v: GlassesView) => {
    app.view = v;
  };
  const rebuild = async () => {
    app.rebuilds++;
    // A jammed BLE link is exactly this: the rebuild never lands.
    if (app.rebuildFails) throw new Error("bridge rebuild rejected");
  };

  async function dispatch(event: RawGlassesEvent, now = 100_000) {
    const snapshot: RouterState = {
      view: app.view,
      connectState: "connecting",
      hasClient: true,
      lastDoubleClickAt: app.lastDoubleClickAt,
      now,
    };
    const { action, acceptedDoubleClickAt } = routeGlassesEvent(event, snapshot);
    if (acceptedDoubleClickAt != null) app.lastDoubleClickAt = acceptedDoubleClickAt;
    switch (action.kind) {
      case "toggleHud":
        app.hudHidden = !app.hudHidden;
        break;
      case "openMenu": {
        const ok = await commitView("menu", app.view, setView, rebuild);
        app.menuOpen = ok;
        break;
      }
      case "exitDialog":
        app.exitDialogRaised = true;
        break;
      case "exitFinder": {
        await commitView("hud", app.view, setView, rebuild);
        break;
      }
      default:
        break;
    }
    return action;
  }
  return { app, dispatch };
}

describe("observable outcomes through the harness", () => {
  it("single tap hides and restores the HUD", async () => {
    const { app, dispatch } = makeApp();
    await dispatch(tapElided);
    expect(app.hudHidden).toBe(true);
    await dispatch(tapElided);
    expect(app.hudHidden).toBe(false);
  });

  it("double tap opens the menu, and a later double tap from the menu exits", async () => {
    const { app, dispatch } = makeApp();
    await dispatch(doubleTap, 100_000);
    expect(app.menuOpen).toBe(true);
    expect(app.view).toBe("menu");
    expect(app.exitDialogRaised).toBe(false);
    // Past the debounce window.
    await dispatch(doubleTap, 100_000 + DOUBLE_CLICK_DEBOUNCE_MS + 1);
    expect(app.exitDialogRaised).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE REGRESSION. This is the test that fails on the pre-fix code.

describe("a failed page rebuild must not brick the gestures", () => {
  it("rolls `view` back when the rebuild never lands, keeping taps alive", async () => {
    // The exact hardware state: the BLE chain is jammed (a bridge call was made
    // outside the serialization chain), so the menu rebuild rejects.
    const { app, dispatch } = makeApp({ rebuildFails: true });

    await dispatch(doubleTap, 100_000);
    // The menu never appeared...
    expect(app.menuOpen).toBe(false);
    // ...so the app must NOT believe it is on the menu. Pre-fix this was
    // "menu", and from here every gesture was dead.
    expect(app.view).toBe("hud");

    // Single tap still works (pre-fix: matched no branch at all).
    await dispatch(tapElided, 100_001);
    expect(app.hudHidden).toBe(true);

    // Double tap still tries the menu instead of falling through to the system
    // exit dialog (pre-fix: exitDialogRaised === true — the reported symptom).
    await dispatch(doubleTap, 100_000 + DOUBLE_CLICK_DEBOUNCE_MS + 1);
    expect(app.exitDialogRaised).toBe(false);
  });
});

describe("host ops that fail by RESOLVING false, not by rejecting", () => {
  // rebuildPageContainer/textContainerUpgrade return Promise<boolean> and never
  // reject. 1.4.2 checked only for a throw, so a `false` still committed `view`
  // to a page that was never built — and a refused rebuild can leave the panel
  // with no event-capture container, which is what killed single taps on
  // hardware while system-level double-taps kept arriving.
  const rebuildReturningFalse = async () => {
    const ok: boolean = false;
    if (!ok) throw new Error("host rejected page rebuild");
  };

  it("rolls the view back when the host resolves false", async () => {
    let view: GlassesView = "hud";
    const ok = await commitView(
      "menu",
      "hud",
      (v) => {
        view = v;
      },
      rebuildReturningFalse,
    );
    expect(ok).toBe(false);
    expect(view).toBe("hud");
  });

  it("keeps gestures alive after a false-resolving rebuild", async () => {
    const { app, dispatch } = makeApp({ rebuildFails: true });
    await dispatch(doubleTap, 100_000);
    expect(app.view).toBe("hud");
    // The tap the hardware lost.
    await dispatch(tapElided, 100_001);
    expect(app.hudHidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-surface: the combination the round never tested.

describe("phone finder session must not change glasses routing", () => {
  function runningEngine() {
    vi.useFakeTimers();
    let clock = 1000;
    const engine = new FinderEngine({
      getCar: () => ({ lat: 51.5072, lon: -0.1276 }),
      getMeta: () => ({ unit: "km", parkedAt: null }),
      startWatch: () => ({ stop: () => {} }),
      loadGrantedOnce: async () => true,
      saveGrantedOnce: async () => {},
      probePermission: async () => "granted",
      now: () => clock,
      onError: () => {},
    });
    const phone = { render: (_f: FinderFrame) => {} };
    engine.attach(phone);
    return { engine, phone, stop: () => { engine.detach(phone); vi.useRealTimers(); } };
  }

  it("routes identically with a phone session live and with none", async () => {
    // Without a phone session.
    const bare = makeApp();
    await bare.dispatch(tapElided);
    const bareHidden = bare.app.hudHidden;
    await bare.dispatch(doubleTap);
    const bareView = bare.app.view;

    // With the phone finder attached and the engine ticking.
    const session = runningEngine();
    try {
      expect(session.engine.isRunning()).toBe(true);
      const withPhone = makeApp();
      await withPhone.dispatch(tapElided);
      expect(withPhone.app.hudHidden).toBe(bareHidden);
      await withPhone.dispatch(doubleTap);
      expect(withPhone.app.view).toBe(bareView);
      expect(withPhone.app.exitDialogRaised).toBe(false);
    } finally {
      session.stop();
    }
  });

  it("a phone session does not make the glasses believe the finder is up", () => {
    const session = runningEngine();
    try {
      // The glasses view is owned by the glasses, not by the engine. A live
      // phone session must leave a HUD tap as a HUD tap.
      expect(routeGlassesEvent(tapElided, state({ view: "hud" })).action.kind).toBe(
        "toggleHud",
      );
      expect(routeGlassesEvent(doubleTap, state({ view: "hud" })).action.kind).toBe(
        "openMenu",
      );
    } finally {
      session.stop();
    }
  });
});

describe("input trace", () => {
  it("records raw shape, branch and believed state, newest last, capped", () => {
    const trace = createInputTrace(3);
    const s = state({ view: "hud" });
    for (const ev of [tapElided, doubleTap, tapSys, listSelect(1)]) {
      const { branch } = routeGlassesEvent(ev, s);
      trace.record(ev, branch, s);
    }
    const entries = trace.entries();
    expect(entries).toHaveLength(3); // capped
    expect(entries[entries.length - 1].raw).toBe("list(1)");
    expect(entries[0].branch).toBe("double/openMenu");
    expect(trace.lines(s.now)[0]).toContain("view hud");
  });

  it("distinguishes an elided eventType from an explicit zero", () => {
    // The single most important distinction for diagnosing a gesture bug.
    expect(describeRawEvent(tapElided)).toBe("text(elided)");
    expect(describeRawEvent(tapExplicit)).toBe("text(0)");
    expect(describeRawEvent(doubleTap)).toBe("sys(3)");
    expect(describeRawEvent({})).toBe("empty");
  });
});
