import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";

import {
  ApiError,
  BackendClient,
  TimeoutError,
  type VehicleStatus,
} from "./api";
import { renderArrowFrames } from "./arrow-frames";
import { BRAND, applyBrand } from "./brand";
import { createBridgeGate } from "./bridge-gate";
import {
  CONNECTING_TEXT,
  CONNECT_CONTAINER,
  CONNECT_SPIN_CONTAINER,
  CONNECT_SPIN_W,
  CONNECT_SPIN_X,
  FINDER_CONTAINER,
  FINDER_DEBUG_CONTAINER,
  FINDER_FOOT_CONTAINER,
  FINDER_FOOT_H,
  FINDER_FOOT_Y,
  FINDER_IMG_FOOT_H,
  FINDER_IMG_FOOT_Y,
  FINDER_IMG_MAIN_H,
  FINDER_IMG_MAIN_Y,
  FINDER_MAIN_CONTAINER,
  FINDER_MAIN_H,
  FINDER_MAIN_Y,
  HUD_CONTAINER,
  HUD_NOTE_CONTAINER,
  HUD_PADDING,
  HUD_ROW_CONTAINER,
  HUD_ROW_W,
  HUD_ROW_X,
  MENU_INFO_CONTAINER,
  MENU_LIST_CONTAINER,
  MENU_LIST_WIDTH,
  type MenuItem,
  buildMenuItems,
  formatConnectFail,
  formatFinder,
  formatHudBottom,
  formatHudRow,
  formatMenuInfo,
  prioritiseMenu,
  sameMenu,
  spinnerFrame,
} from "./display";
import {
  type DirectionIndicator,
  createGlyphIndicator,
  createImageIndicator,
} from "./direction";
import {
  angleDelta,
  cardinal,
  formatDistance,
  formatParkedAge,
  headingPhrase,
} from "./finder";
import {
  KEEP_UNLOCKED_NOTE,
  type FinderFrame,
  type FinderRenderer,
  createFinderEngine,
} from "./finder-engine";
import { type AppLocationBridge, startPositionWatch } from "./geo";
import {
  type GlassesView,
  type RouterState,
  commitView,
  createInputTrace,
  describeRawEvent,
  routeGlassesEvent,
} from "./glasses-input";
import {
  loadGrantedOnce,
  probePermission,
  saveGrantedOnce,
} from "./location-permission";
import { type RadarLayout, computeScene, layoutFor, niceRange } from "./radar";
import {
  type AppSettings,
  type Bridge,
  type TempUnit,
  DEFAULT_SETTINGS,
  REGIONS,
  carKnownLimits,
  chargeLimitsRelevant,
  isConfigured,
  limitsNeedSending,
  loadSettings,
  resolveTempUnit,
  saveSettings,
  tempFieldState,
  toCanonicalC,
} from "./settings";
// Vite resolves JSON imports at build time — gives us the version string
// from app.json without a runtime fetch.
import appJson from "../app.json";

const APP_VERSION: string = appJson.version;

// The host bridge, usable from this line on whether or not a host ever shows
// up (bridge-gate.ts explains the encoding it fails with). This used to be
// `await waitForEvenAppBridge()` — an unbounded top-level await on a promise
// the SDK never rejects and never times out. On any host that didn't inject the
// bridge, the whole module body below never executed: no listeners, no phone
// UI, and a settings page that rendered perfectly while every button on it,
// "Find my car" and "Copy diagnostic report" alike, did nothing.
const gate = createBridgeGate(waitForEvenAppBridge);
const bridge = gate.bridge;

// Real settings load AFTER the first frame is on the glasses (boot section at
// the bottom) — a slow bridge storage read must never delay the first paint.
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let client: BackendClient | null = null;
let lastStatus: VehicleStatus | null = null;
// 'connect' until the first successful /status (no HUD of empty values);
// then two-layer UI: 'hud' is glanceable status only, 'menu' holds controls.
let view: GlassesView = "connect";
// Last ~10 glasses events (raw shape, router branch, believed state) for the
// diagnostic report — the 1.4.0 gesture regression cost a hardware walk and a
// guess because nothing recorded what the router actually saw.
const inputTrace = createInputTrace(10);
let connectState: "connecting" | "failed" = "connecting";
// Deliberate single-tap "glasses off" mode: the HUD renders nothing but the
// app keeps running and polling. Distinct from connect/error states, which
// always render something — a silent blank must only ever be user-chosen.
let hudHidden = false;
let menuItems: MenuItem[] = [];
let repollTimer: ReturnType<typeof setTimeout> | null = null;
// Guard against a rapid repeat double-tap re-firing the exit dialog.
let lastDoubleClickAt = 0;
// True between FOREGROUND_EXIT and FOREGROUND_ENTER: timers are paused and
// nothing may be rendered — the page isn't on the glasses while backgrounded.
let backgrounded = false;
// Bumped to invalidate an in-flight connect attempt (superseded by a newer
// attempt, or backgrounded mid-flight); a stale attempt must not render.
let connectGen = 0;

// Tracks the last backend error for the diagnostics report. Never includes
// credentials — just the endpoint path, HTTP status, and sanitised detail.
let lastError: { endpoint: string; status: number; detail: string } | null =
  null;

// Kia + US: brand code 1, region code 3.
const IS_KIA_US = BRAND.apiBrandCode === 1;

function credentialsFrom(s: AppSettings) {
  return {
    username: s.username.trim(),
    password: s.password,
    pin: s.pin.trim(),
    region: s.region,
    // Brand is build-time (one packed app per brand), not a setting.
    brand: BRAND.apiBrandCode,
    // Kia-US: include the stored device token so the proxy can reuse the
    // trusted device identity. Ignored by other brand/region combos.
    ...(IS_KIA_US && s.region === 3 && s.kiaUsDeviceToken
      ? { device_token: s.kiaUsDeviceToken }
      : {}),
  };
}

function rebuildClient() {
  client = isConfigured(settings)
    ? new BackendClient(credentialsFrom(settings))
    : null;
}
rebuildClient();

// ---------------------------------------------------------------------------
// Bridge call serialization — concurrent bridge calls can crash the BLE link.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Page rendering

// HUD page: invisible full-screen event layer + top status row + bottom
// centred line (charging / transient notes). Nothing else.
function hudPage(note: string) {
  return {
    containerTotalNum: 3,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        ...HUD_CONTAINER,
        content: " ",
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: HUD_ROW_X,
        yPosition: 0,
        width: HUD_ROW_W,
        height: 40,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: HUD_PADDING,
        ...HUD_ROW_CONTAINER,
        content: hudHidden
          ? " "
          : safeText("render/hud", () => formatHudRow(lastStatus), safeHudRow()),
        isEventCapture: 0,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 224,
        width: 576,
        height: 64,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: HUD_PADDING,
        ...HUD_NOTE_CONTAINER,
        content: hudHidden
          ? " "
          : safeText(
              "render/hud",
              () => formatHudBottom(lastStatus, note),
              SAFE_NOTE,
            ),
        isEventCapture: 0,
      }),
    ],
  };
}

// Connect page: invisible full-screen event layer + centred message
// container + a fixed spinner cell below it. The spinner has its own
// container so frame swaps never re-flow the message text. Shown from
// launch until the first successful /status.
function connectPage(content: string, spin: string) {
  return {
    containerTotalNum: 3,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        ...HUD_CONTAINER,
        content: " ",
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 88,
        width: 576,
        height: 96,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: HUD_PADDING,
        ...CONNECT_CONTAINER,
        content,
        isEventCapture: 0,
      }),
      // Sits directly below the single "Connecting…" line. It overlaps the
      // bottom of the (taller) message container, which is fine: the spinner
      // is blanked whenever the message grows to multi-line error text.
      new TextContainerProperty({
        xPosition: CONNECT_SPIN_X,
        yPosition: 124,
        width: CONNECT_SPIN_W,
        height: 40,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: HUD_PADDING,
        ...CONNECT_SPIN_CONTAINER,
        content: spin,
        isEventCapture: 0,
      }),
    ],
  };
}

/**
 * Menu page shapes, plainest last.
 *
 * Hardware (1.4.3) refused EVERY menu page rebuild — "host rejected menu page",
 * four for four — while the HUD page was accepted every time. The menu is the
 * only page with a list container, the only one setting `borderRadius`, and the
 * only one whose text carries non-ASCII (`°`, `·`). All three are valid per the
 * SDK 0.0.10 types and all three render in the simulator, so the host is
 * stricter than both. Rather than guess which, we try progressively plainer
 * variants and record the first the host accepts: the user gets a menu, and
 * `Menu variant:` in the diagnostic report names the culprit. (Precedent: the
 * RC round found an unknown PB field kills a whole page rebuild — hence the
 * standing ban on `zOrderIndex`.)
 */
const MENU_VARIANTS = [
  { name: "full", radius: true, ascii: false, maxItems: 0 },
  // 1.4.4 hardware verdict: every 7-item variant was refused and the 3-item one
  // was accepted, so the host's limit is ITEM COUNT (or total payload size) —
  // not borderRadius and not the non-ASCII labels. The ladder therefore walks
  // the count down, keeping the styling that already works.
  { name: "6-items", radius: true, ascii: false, maxItems: 6 },
  { name: "5-items", radius: true, ascii: false, maxItems: 5 },
  { name: "4-items", radius: true, ascii: false, maxItems: 4 },
  { name: "3-items", radius: true, ascii: false, maxItems: 3 },
  // Only after the count is as low as it goes do the styling/text suspects get
  // stripped — they were exonerated above, but cost nothing as a backstop.
  { name: "3-items+plain", radius: false, ascii: true, maxItems: 3 },
  { name: "2-items+plain", radius: false, ascii: true, maxItems: 2 },
] as const;

/** Which variant the host accepted last (null = none tried / all refused).
 *  `prioritiseMenu` and `MENU_PRIORITY` moved to display.ts, where a test can
 *  reach them — they decide which action a tap index means. */
let menuVariantUsed: string | null = null;

/**
 * The item cap currently in force: the accepted variant's, or none if the host
 * hasn't accepted anything yet. `renderCurrent` needs this to compare a fresh
 * menu against the one actually on screen — see the warning on `sameMenu`.
 */
function acceptedMenuMax(): number {
  const variant = MENU_VARIANTS.find((v) => v.name === menuVariantUsed);
  return variant ? variant.maxItems : 0;
}

/** Non-ASCII → nearest plain equivalent, for the ascii variants. */
function toAsciiLabel(s: string): string {
  return s
    .replace(/°/g, "")
    .replace(/·/g, "-")
    .replace(/…/g, "...")
    // Anything else outside printable ASCII goes entirely.
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function menuListContainer(
  items: MenuItem[],
  opts: { radius: boolean; ascii: boolean } = { radius: true, ascii: false },
) {
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: MENU_LIST_WIDTH,
    height: 288,
    borderWidth: 1,
    borderColor: 8,
    // Omitted entirely (not set to 0) in the no-radius variants: an unknown or
    // unwanted PB field is refused by its presence, not its value.
    ...(opts.radius ? { borderRadius: 6 } : {}),
    paddingLength: 4,
    ...MENU_LIST_CONTAINER,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 0, // auto fill container width
      isItemSelectBorderEn: 1,
      itemName: items.map((i) => (opts.ascii ? toAsciiLabel(i.label) : i.label)),
    }),
  });
}

function menuInfoContainer(content: string) {
  return new TextContainerProperty({
    xPosition: MENU_LIST_WIDTH,
    yPosition: 0,
    width: 576 - MENU_LIST_WIDTH,
    height: 288,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 8,
    ...MENU_INFO_CONTAINER,
    content,
    isEventCapture: 0,
  });
}

/**
 * The host reports page/text failures in the RESOLVED value — these APIs return
 * `Promise<boolean>` and NEVER reject. Exactly the trap `updateImageRawData` set
 * in 1.3.3 (pushes "succeeded" while the panel stayed blank), relearned here the
 * hard way: an unchecked `false` from `rebuildPageContainer` let `view` commit to
 * a page that was never built, after which no tap branch matched and every
 * double-tap fell through to the exit dialog. Converting `false` into a throw is
 * what lets commitView roll back and what makes the failure visible at all.
 *
 * Every result is also recorded for the diagnostic report — "did the page
 * actually go up?" must be answerable from one hardware minute.
 */
let lastHostOp: { what: string; ok: boolean; at: number } | null = null;
let hostOpFailures = 0;

async function recordHostOp(
  what: string,
  call: () => Promise<boolean>,
): Promise<boolean> {
  const ok = await call();
  lastHostOp = { what, ok, at: Date.now() };
  if (!ok) {
    hostOpFailures++;
    console.log(`glasses: host rejected ${what} (returned false)`);
  }
  return ok;
}

/**
 * Rebuild the whole page. THROWS when the host says no, which is the whole
 * point: only a throw reaches commitView's rollback, and only the rollback
 * keeps `view` honest about what is actually on screen.
 */
async function rebuildPage(what: string, container: RebuildPageContainer) {
  const ok = await recordHostOp(what, () =>
    enqueue(() => bridge.rebuildPageContainer(container)),
  );
  if (!ok) throw new Error(`host rejected ${what}`);
}

// Flicker-free in-place updates; only valid while the matching page is shown.
// Records failures but deliberately does NOT throw: a missed text upgrade is
// cosmetic and its callers are fire-and-forget, so throwing would only add
// unhandled rejections. The counter in the diagnostic report is the signal.
function upgradeText(
  ids: { containerID: number; containerName: string },
  content: string,
) {
  return recordHostOp(`upgrade ${ids.containerName}`, () =>
    enqueue(() =>
      bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          ...ids,
          content,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    ),
  );
}

async function updateHud(note = "") {
  await upgradeText(
    HUD_ROW_CONTAINER,
    hudHidden
      ? " "
      : safeText("render/hud", () => formatHudRow(lastStatus), safeHudRow()),
  );
  await upgradeText(
    HUD_NOTE_CONTAINER,
    hudHidden
      ? " "
      : safeText(
          "render/hud",
          () => formatHudBottom(lastStatus, note),
          SAFE_NOTE,
        ),
  );
}

// Transient HUD note: clears itself back to the regular bottom line (blank
// while hidden) after `ms`. Used for the hide-recovery hint, so it never
// masks the charging line for long.
let noteTimer: ReturnType<typeof setTimeout> | null = null;
function clearNoteTimer() {
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = null;
}
function scheduleNoteClear(ms: number) {
  clearNoteTimer();
  noteTimer = setTimeout(() => {
    noteTimer = null;
    if (view === "hud" && !backgrounded) void updateHud();
  }, ms);
}

const HUD_HIDDEN_HINT = "HUD Hidden: Tap to show";

// Single tap on the HUD toggles "glasses off". Hiding leaves a bottom-centred
// recovery hint up for 2 s before going fully blank — an instant silent blank
// reads as a crash to anyone but the owner. Unhide paints last-known data
// immediately, then refreshes in the background — never a stale-blank wait.
async function toggleHudHidden() {
  hudHidden = !hudHidden;
  clearNoteTimer();
  if (hudHidden) {
    await upgradeText(HUD_ROW_CONTAINER, " ");
    await upgradeText(
      HUD_NOTE_CONTAINER,
      formatHudBottom(null, HUD_HIDDEN_HINT),
    );
    scheduleNoteClear(2000);
  } else {
    await updateHud();
    void pollStatus();
  }
}

function updateMenuInfo(content: string) {
  return upgradeText(MENU_INFO_CONTAINER, content);
}

// Every view transition commits only once its page rebuild actually lands (see
// commitView). Assigning `view` and hoping was the 1.4.0 gesture-death
// amplifier: one rejected rebuild left the router reading a page that wasn't on
// screen, after which no tap branch matched and every double-tap fell through
// to the system exit dialog.
const setView = (v: GlassesView) => {
  view = v;
};

function showHud(note = "") {
  const previous = view;
  // Explicit navigation to the HUD always shows it — landing from the menu
  // (or a fresh connect) on an invisible page would look broken.
  hudHidden = false;
  return commitView(
    "hud",
    previous,
    setView,
    () => rebuildPage("hud page", new RebuildPageContainer(hudPage(note))),
    (err) => recordError("render/hud", err),
  );
}

/**
 * Build the menu page from `candidate`, walking MENU_VARIANTS until the host
 * accepts one. Throws only when every variant is refused, so commitView still
 * rolls the view back rather than stranding it on a page that never went up.
 *
 * `candidate` is a parameter rather than module state on purpose: `menuItems`
 * must describe what is ON SCREEN, and nothing else. It used to be assigned
 * before the rebuild, so for the length of a BLE round trip it named the full
 * untruncated list while the glasses still showed the truncated one — and a tap
 * during that window resolved index 1 ("Find my car") to `unlock`, sending an
 * unlock to the car. Same discipline as `commitView` and `view`: assign only
 * once the host has actually taken the page.
 */
async function rebuildMenuPage(
  candidate: MenuItem[],
  note: string,
): Promise<void> {
  const info = safeText(
    "render/menu",
    () => formatMenuInfo(lastStatus, note),
    SAFE_NOTE,
  );
  // Try the shape that worked last time first. Each refusal is a real BLE round
  // trip, and blindly re-walking the ladder on every menu open cost 34 rejected
  // ops in one hardware session — slow, and it buries the real signal.
  const ordered = menuVariantUsed
    ? [
        ...MENU_VARIANTS.filter((v) => v.name === menuVariantUsed),
        ...MENU_VARIANTS.filter((v) => v.name !== menuVariantUsed),
      ]
    : [...MENU_VARIANTS];
  for (const variant of ordered) {
    const items = prioritiseMenu(candidate, variant.maxItems);
    try {
      await rebuildPage(
        `menu page (${variant.name})`,
        new RebuildPageContainer({
          containerTotalNum: 2,
          listObject: [
            menuListContainer(items, {
              radius: variant.radius,
              ascii: variant.ascii,
            }),
          ],
          textObject: [menuInfoContainer(variant.ascii ? toAsciiLabel(info) : info)],
        }),
      );
      // Accepted. Keep menuItems in step with what is actually on screen, or a
      // tap would select the wrong action.
      menuItems = items;
      menuVariantUsed = variant.name;
      if (variant.name !== "full") {
        console.log(`glasses: menu accepted only as "${variant.name}"`);
      }
      return;
    } catch {
      // Refused — fall through to the next, plainer shape.
    }
  }
  menuVariantUsed = null;
  throw new Error("host refused every menu variant");
}

// List containers cannot be updated in-place, so entering the menu (or
// changing its context-aware items) is a full page rebuild.
function showMenu(note = "") {
  const previous = view;
  let candidate: MenuItem[];
  try {
    candidate = buildMenuItems(lastStatus, settings);
  } catch (err) {
    // Same safety net as the HUD: a broken status must still leave a
    // navigable menu (the universal actions need no status at all).
    recordError("render/menu", err);
    candidate = [
      { key: "hud", label: "Return to HUD" },
      { key: "refresh", label: "Refresh" },
      { key: "quit", label: "Quit" },
    ];
  }
  return commitView(
    "menu",
    previous,
    setView,
    () => rebuildMenuPage(candidate, note),
    (err) => recordError("render/menu", err),
  );
}

// ---------------------------------------------------------------------------
// Car finder ("Find my car")
//
// Bearing and distance from the phone's own GPS to the car position that
// /status already gave us. Every coordinate stays on the device — nothing
// below adds anything to a request, which is what PRIVACY.md promises.
//
// There is no compass: the Stage 0 probe found the Even WebView refuses
// DeviceOrientationEvent.requestPermission() outright (denied in 0–5ms, no
// dialog), so the arrow is relative to the user's *travel course* derived from
// successive fixes, and degrades to absolute cardinal text when they stop.

/** How long the arrival screen holds before returning to the HUD. */
const ARRIVAL_HOLD_MS = 3000;

// Telemetry strip on the finder screen (top edge) plus the Finder line in the
// diagnostic report. OFF for release builds — the strip and its container
// vanish entirely; the diagnostic-report line stays either way. Flip to true
// for hardware-debug builds (the 1.3.x rounds lived on it).
const FINDER_DEBUG = false;
// The circled-arrow image indicator (Round 3). false = the 1.3.1 glyph
// layout, kept as the fallback build if the image path misbehaves over BLE.
const FINDER_IMAGE_ARROW = true;
// Dim-grey ring/arrow when the car position is stale — the staleness-channel
// experiment. The simulator normalises greys, so only a hardware walk can
// judge it; flip false if it's illegible.
const STALE_DIM_ENABLED = true;
// The bridge App Location source, OFF after walk 5: it stalled under screen
// lock exactly like WebView geolocation (suspended JS can't receive host
// pushes) and delivered a worse fix cadence screen-on. The code path stays —
// an Even app update could change the suspension behaviour, and re-running the
// experiment now takes one env var: `VITE_BRIDGE_LOCATION=1 npm run build`
// (never set for a real distributable, like VITE_BACKEND_URL). NOTE: this alone
// is inert on the pinned SDK 0.0.10, which exposes no App Location methods, so
// startPositionWatch falls straight back to WebView geolocation — the bridge
// walk also needs an SDK 0.0.11+ bump (deliberately reverted, DECISIONS-LOG
// 2026-07-20) and the portal's "Run background services" toggle enabled.
const FINDER_BRIDGE_LOCATION = import.meta.env.VITE_BRIDGE_LOCATION === "1";

// The finder loop itself lives in finder-engine.ts; the state below is only the
// glasses renderer's (diffing + arrival hold + repaint telemetry). The engine
// is created once the page functions it depends on are defined (below).

// Last rendered content, so a frame only touches containers that actually
// changed — an unchanged upgrade is a wasted bridge call. (The direction
// indicator does its own diffing behind its interface.)
let finderShown: { main: string; foot: string } | null = null;
let finderDebugShown: string | null = null;
// Repaints attempted vs completed. A growing gap is the signature of the bridge
// serialization chain jamming on a call that never settled — on-screen it is
// indistinguishable from GPS death, which is why it's counted. Reset on entry.
let finderRenders = { started: 0, done: 0 };
// Arrival's hold-then-return-to-HUD timer (glasses only; the phone shows Done).
let finderArrival: ReturnType<typeof setTimeout> | null = null;

// The arrow, behind the DirectionIndicator seam. Round 3 default is the
// image renderer (large circled arrow, the owner's mockup); the glyph
// renderer remains both the flag fallback (FINDER_IMAGE_ARROW=false) and the
// image renderer's own live fallback if a push fails over real BLE.
function pushImage(
  ids: { containerID: number; containerName: string },
  imageData: number[],
) {
  // Same serialization chain as text upgrades: the SDK is explicit that
  // image transmissions must not overlap anything on the BLE link.
  return enqueue(async () => {
    const result = await bridge.updateImageRawData(
      new ImageRawDataUpdate({ ...ids, imageData }),
    );
    // The host reports image failures in the RESOLVED value — the promise
    // does not reject (spike finding, relearned the hard way on the 1.3.3
    // walk: pushes "succeeded" while the panel stayed blank and the glyph
    // fallback never armed). Throwing here is what arms it.
    const verdict = ImageRawDataUpdateResult.normalize(result);
    if (!ImageRawDataUpdateResult.isSuccess(verdict)) {
      throw new Error(`host rejected image push: ${verdict}`);
    }
    return result;
  });
}
/** Contributes no containers at all — the last-resort finder layout for a host
 *  that refuses the richer pages (hardware 1.4.4 refused anything with too many
 *  containers/payload). Distance and direction still read out in the text. */
function createNullIndicator(): DirectionIndicator {
  return {
    containers: () => ({ count: 0, textObject: [] }),
    async update() {},
    reset() {},
  };
}

// Swappable: enterFinder walks these downward if the host refuses a page.
const imageIndicator = createImageIndicator(
  pushImage,
  upgradeText,
  renderArrowFrames,
);
const glyphIndicator = createGlyphIndicator(upgradeText);
const nullIndicator = createNullIndicator();

let directionIndicator: DirectionIndicator = FINDER_IMAGE_ARROW
  ? imageIndicator
  : glyphIndicator;
/** Which finder layout the host accepted, for the diagnostic report. */
let finderLayoutUsed: string | null = null;

// Geometry shifts when the image dominates the screen (image layout packs
// headline+foot below the 144px arrow; text layout is the 1.3.1 one).
const FINDER_GEOM = FINDER_IMAGE_ARROW
  ? {
      mainY: FINDER_IMG_MAIN_Y,
      mainH: FINDER_IMG_MAIN_H,
      footY: FINDER_IMG_FOOT_Y,
      footH: FINDER_IMG_FOOT_H,
      compact: true,
    }
  : {
      mainY: FINDER_MAIN_Y,
      mainH: FINDER_MAIN_H,
      footY: FINDER_FOOT_Y,
      footH: FINDER_FOOT_H,
      compact: false,
    };

function finderPage(content: { main: string; foot: string }) {
  const cell = (
    ids: { containerID: number; containerName: string },
    y: number,
    height: number,
    text: string,
  ) =>
    new TextContainerProperty({
      xPosition: 0,
      yPosition: y,
      width: 576,
      height,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: HUD_PADDING,
      ...ids,
      content: text,
      isEventCapture: 0,
    });

  const direction = directionIndicator.containers();
  return {
    containerTotalNum: 3 + direction.count + (FINDER_DEBUG ? 1 : 0),
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        ...FINDER_CONTAINER,
        content: " ",
        isEventCapture: 1,
      }),
      ...direction.textObject,
      cell(FINDER_MAIN_CONTAINER, FINDER_GEOM.mainY, FINDER_GEOM.mainH, content.main),
      cell(FINDER_FOOT_CONTAINER, FINDER_GEOM.footY, FINDER_GEOM.footH, content.foot),
      // Telemetry strip in the otherwise-empty top band (arrow row starts at
      // y=36). Painted by renderFinder; " " keeps the first frame clean.
      ...(FINDER_DEBUG ? [cell(FINDER_DEBUG_CONTAINER, 0, 36, " ")] : []),
    ],
    ...(direction.imageObject?.length
      ? { imageObject: direction.imageObject }
      : {}),
  };
}

function carPosition() {
  const lat = lastStatus?.latitude;
  const lon = lastStatus?.longitude;
  return lat != null && lon != null ? { lat, lon } : null;
}

// The shared finder loop. Its side effects are injected so it stays free of
// bridge/DOM and unit-testable: the car position and status metadata come from
// lastStatus, the position source is startPositionWatch (bridge path parked
// behind the flag), and the permission bits go through location-permission.ts
// over bridge KV. main.ts is one of its renderers (the glasses); the phone
// radar is the other. Every coordinate still stays on the device.
const finderEngine = createFinderEngine({
  getCar: () => carPosition(),
  getMeta: () => ({
    unit: lastStatus?.range_unit ?? null,
    parkedAt: lastStatus?.location_last_updated ?? null,
  }),
  startWatch: (handlers, car) =>
    startPositionWatch(
      handlers,
      car,
      // Bridge source parked (FINDER_BRIDGE_LOCATION above): null sends geo.ts
      // straight down the proven WebView-geolocation path.
      FINDER_BRIDGE_LOCATION ? (bridge as unknown as AppLocationBridge) : null,
    ),
  // THROUGH `enqueue`, like every other bridge call in this file. These are
  // real BLE traffic (getLocalStorage/setLocalStorage), and the engine fires
  // them on session start and first fix — i.e. concurrently with whatever page
  // rebuild is in flight. Calling them directly is what broke 1.4.0's gestures
  // on hardware: a concurrent bridge call jammed the link, the menu rebuild
  // never landed, and `view` was left naming a page that wasn't on screen. The
  // simulator has no BLE, so nothing showed there.
  loadGrantedOnce: () => enqueue(() => loadGrantedOnce(bridge)),
  saveGrantedOnce: () => enqueue(() => saveGrantedOnce(bridge)),
  // DEV: `VITE_FAKE_GPS=awaiting` forces the pending-prompt verdict so the
  // first-run walkthrough is inspectable without a real permission dialog.
  probePermission:
    import.meta.env.DEV && import.meta.env.VITE_FAKE_GPS === "awaiting"
      ? async () => "prompt" as const
      : () => probePermission(),
  onError: (where, err) => recordError(where, err),
});

/** One line that tells the walker which link is dead while it's dead:
 *  raw-fix count (platform delivering?), usable count (filter passing?),
 *  seconds since the last fix, repaints done/attempted (bridge alive?),
 *  watch replacements (watchdog+screen-wake), and the current mode. The
 *  age counter changing every second doubles as a JS-alive heartbeat —
 *  if this line freezes, the whole WebView is suspended. */
function finderDebugLine(frame: FinderFrame): string {
  const t = frame.telemetry;
  if (!t) return "no watch";
  const age = t.lastFixAt
    ? `${Math.max(0, Math.round((Date.now() - t.lastFixAt) / 1000))}s`
    : "–";
  const rejected = t.rawFixes - t.usableFixes;
  // Which location source is live: br = host bridge session (the one that
  // should survive screen lock), wk = WebView geolocation, fk = DEV fake.
  const src =
    t.source === "bridge" ? "br" : t.source === "webkit" ? "wk" : t.source === "fake" ? "fk" : "?";
  return (
    `${src} fx ${t.rawFixes}${rejected ? `(-${rejected})` : ""} ${age}` +
    ` · rp ${finderRenders.done}/${finderRenders.started}` +
    ` · rs ${t.restarts}+${t.resumes}` +
    ` · ${frame.view.mode}` +
    (t.lastProblem ? ` !${t.lastProblem}` : "")
  );
}

// The glasses renderer: a FinderFrame → container upgrades. Crash-safe like
// every other formatter here — a maths bug must still leave a readable screen
// with a way out, never a blank (a store-review reject). The engine has already
// applied the note/stale/arrival logic; this only lays the characters down.
const glassesFinderRenderer: FinderRenderer = {
  async render(frame: FinderFrame) {
    if (backgrounded || view !== "finder") return;
    finderRenders.started++;
    try {
      const v = frame.view;
      // The keep-unlocked note borrows the detail line briefly; problem and
      // awaiting states keep their own explanation (it outranks advice).
      const detail = frame.noteActive ? KEEP_UNLOCKED_NOTE : v.detail;
      const content = formatFinder({ ...v, detail }, FINDER_GEOM.compact);
      const mode = v.mode;
      // Ring shows for every located state (walking arrow, stationary/arrived/
      // locating ring-only); problem and awaiting states clear the image.
      await directionIndicator.update(v.octant, {
        ring: mode !== "problem" && mode !== "awaiting",
        dim: STALE_DIM_ENABLED && frame.stale,
      });
      if (content.main !== finderShown?.main) {
        await upgradeText(FINDER_MAIN_CONTAINER, content.main);
      }
      if (content.foot !== finderShown?.foot) {
        await upgradeText(FINDER_FOOT_CONTAINER, content.foot);
      }
      finderShown = content;
      if (FINDER_DEBUG) {
        const line = finderDebugLine(frame);
        if (line !== finderDebugShown) {
          finderDebugShown = line;
          await upgradeText(FINDER_DEBUG_CONTAINER, line);
        }
      }
      finderRenders.done++;

      // Arrival ends the feature: the engine has already stopped the watch, so
      // the glasses just hold briefly and return to the HUD. No other state has
      // a timeout — nothing yanks the user back mid-walk. (The phone shows Done
      // instead, since it has nowhere to return to.)
      if (mode === "arrived" && !finderArrival) {
        finderArrival = setTimeout(() => {
          finderArrival = null;
          if (view === "finder" && !backgrounded) void showHud();
        }, ARRIVAL_HOLD_MS);
      }
    } catch (err) {
      // Don't repaint from the catch — that risks a loop; log and leave the
      // last good frame up.
      recordError("render/finder", err);
    }
  },
};

// The phone radar renderer, wired to its DOM in bindPhoneFinder. Kept at module
// scope with its attach/detach so the visibility + system-exit handlers below
// can reach them; the watch is provably stopped whenever the last surface
// leaves (engine ref-counting).
let phoneFinderRenderer: FinderRenderer | null = null;
let phoneFinderOpen = false;
let phoneFinderAttached = false;

function attachPhoneFinder() {
  if (phoneFinderRenderer && !phoneFinderAttached) {
    finderEngine.attach(phoneFinderRenderer);
    phoneFinderAttached = true;
  }
}
function detachPhoneFinder() {
  if (phoneFinderRenderer && phoneFinderAttached) {
    finderEngine.detach(phoneFinderRenderer);
    phoneFinderAttached = false;
  }
}

async function enterFinder() {
  const previous = view;
  finderShown = null;
  finderDebugShown = null;
  finderRenders = { started: 0, done: 0 };
  if (finderArrival) {
    clearTimeout(finderArrival);
    finderArrival = null;
  }
  // Paint a placeholder before attaching (and before GPS spins up) — the
  // permission prompt can take seconds and the glasses must not sit blank
  // behind it. The engine's synchronous first emit on attach replaces this
  // with the real state (Locating…, the car-unknown explanation, or a frame
  // the phone already started) within the same turn.
  const placeholder = formatFinder(
    {
      mode: "locating",
      arrow: null,
      headline: "Locating…",
      detail: "",
      hint: "Tap: back · 2x tap: close app",
      octant: null,
      arrival: { streak: 0, lastFixAt: 0 },
    },
    FINDER_GEOM.compact,
  );
  finderShown = placeholder;
  // Same lesson as the menu: the host refuses pages that are too heavy, so walk
  // the layout down until one is accepted. Image arrow (5 containers) → glyph
  // arrow (4) → text only (3). A plain finder that opens beats a pretty one
  // that doesn't.
  const layouts: { name: string; indicator: DirectionIndicator }[] = [
    ...(FINDER_IMAGE_ARROW
      ? [{ name: "image", indicator: imageIndicator }]
      : []),
    { name: "glyph", indicator: glyphIndicator },
    { name: "text-only", indicator: nullIndicator },
  ];
  const landed = await commitView(
    "finder",
    previous,
    setView,
    async () => {
      let lastErr: unknown = null;
      for (const layout of layouts) {
        directionIndicator = layout.indicator;
        // NOTE: `prepare()` is deliberately NOT called here — see below.
        directionIndicator.reset();
        try {
          await rebuildPage(
            `finder page (${layout.name})`,
            new RebuildPageContainer(finderPage(placeholder)),
          );
          finderLayoutUsed = layout.name;
          if (layout.name !== layouts[0].name) {
            console.log(`glasses: finder accepted only as "${layout.name}"`);
          }
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      finderLayoutUsed = null;
      throw lastErr ?? new Error("host refused every finder layout");
    },
    (err) => recordError("render/finder", err),
  );
  // The finder page never went up: don't attach a renderer that would paint
  // into containers that don't exist, and don't ask for GPS for a screen the
  // user can't see. The view has already rolled back to wherever we were.
  if (!landed) return;
  // Attach to the shared loop — starts a fresh session, or joins one the phone
  // already started (one loop, both surfaces, no mode conflict).
  finderEngine.attach(glassesFinderRenderer);

  // Arrow frames LAST, and off this turn entirely. `prepare()` renders ~35
  // 144x144 PNGs synchronously (renderArrowFrames: 16 rotations x 2 brightness
  // levels, each a canvas + toDataURL + per-byte number[]), which blocks the
  // WebView's main thread — no painting, no event delivery — on the first
  // finder entry of the session. Doing that BEFORE the page rebuild meant the
  // user's press bought a freeze and nothing on screen, and any tap during it
  // queued up to fire afterwards (a queued tap routes to exitFinder and snaps
  // straight back to the HUD, which reads as the press doing nothing). The page
  // is up and the tap acknowledged before we spend that time; `update()`
  // no-ops until the frames exist, so the repaint below is what draws the first
  // arrow. Later entries are free — the frames are cached.
  const indicator = directionIndicator;
  if (indicator.prepare) {
    setTimeout(() => {
      indicator.prepare?.();
      // Still on the finder? Repaint through the engine so the arrow appears
      // without waiting for the next GPS fix.
      if (view === "finder" && !backgrounded) finderEngine.refresh();
    }, 0);
  }
}

function exitFinder() {
  finderEngine.detach(glassesFinderRenderer);
  if (finderArrival) {
    clearTimeout(finderArrival);
    finderArrival = null;
  }
  return showHud();
}

// Phone screen coming back (unlock / WebView resume). The glasses FOREGROUND_*
// events cover the glasses dashboard; they say nothing about the phone's own
// screen — and a locked phone can suspend all of the WebView's JS (the 1.3.0
// walk froze exactly this way). A suspended watch may never deliver again, so
// the engine REPLACES it on resume; the tick/watchdog are the belt to this
// brace. This also drives the phone finder's own attach/detach, so its watch is
// provably stopped when the screen goes away and restarted when it returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (phoneFinderOpen) attachPhoneFinder();
    finderEngine.pokeVisible();
  } else if (phoneFinderOpen) {
    detachPhoneFinder();
  }
});

// ---------------------------------------------------------------------------
// Status polling (cached backend state only — no force refresh on glasses)

/** Record the last error for the diagnostics report. The `endpoint` is a
 *  human label ("status", "lock", etc.), never a full URL. Detail is the
 *  user-facing description — never credentials or token contents. */
function recordError(endpoint: string, err: unknown) {
  if (err instanceof ApiError) {
    lastError = { endpoint, status: err.status, detail: err.message.slice(0, 200) };
  } else if (err instanceof TimeoutError) {
    lastError = { endpoint, status: 0, detail: "timeout" };
  } else if (err instanceof Error) {
    // Non-network errors too (e.g. a render crash caught by the safety
    // net) — name + message so the diagnostic report says what actually
    // broke, still never credentials.
    lastError = {
      endpoint,
      status: 0,
      detail: `${err.name}: ${err.message}`.slice(0, 200),
    };
  } else {
    lastError = { endpoint, status: 0, detail: "network/fetch error" };
  }
}

// ---------------------------------------------------------------------------
// Render crash-safety net: a formatter bug (an unexpected payload shape from
// a car we've never seen) must degrade to a thin-but-alive screen — car name
// + lock state + "Some data unavailable" — never a black screen (store
// auto-reject lesson). The crash lands in the diagnostic report via
// recordError.

const SAFE_NOTE = "Some data unavailable";

/** Fallback HUD row built from primitives only — cannot itself throw. */
function safeHudRow(): string {
  const locked = lastStatus?.locked;
  const lock = locked == null ? "" : locked ? "Locked" : "UNLOCKED";
  return ` ${BRAND.name}   ${lock}`;
}

function safeText(label: string, build: () => string, fallback: string): string {
  try {
    return build();
  } catch (err) {
    recordError(label, err);
    return fallback;
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409)
      return "Device enrollment needed: open phone app";
    if (err.status === 401)
      return "Login rejected: check account in phone app";
    if (err.status === 502) return `${BRAND.name} unreachable`;
    if (err.status === 429) return "Rate limited, wait a minute";
    // Proxy reached the car service but couldn't parse the reply — our bug,
    // not a connectivity problem, so don't send the user chasing credentials.
    if (err.status === 500) return "Backend parse bug, please report";
    return `Backend error ${err.status}`;
  }
  if (err instanceof TimeoutError) return "Timed out, retry in 1 min";
  return "Proxy unreachable: check phone internet";
}

const NOT_CONFIGURED = `Not configured. Open app on phone,\nenter your ${BRAND.name} account`;

// Re-render the current view from lastStatus. Menu items are rebuilt only
// when the context-aware set actually changed (rebuild flickers; the info
// panel upgrade does not).
async function renderCurrent(note = "") {
  // Backgrounded: the page isn't on the glasses; FOREGROUND_ENTER re-polls.
  if (backgrounded) return;
  try {
    if (view === "finder") {
      // A fresh status can carry a newer car position; the engine recomputes
      // from lastStatus, so a refresh repaints both surfaces immediately (and
      // starts the watch if the car position has only just arrived).
      finderEngine.refresh();
    } else if (view === "hud") {
      await updateHud(note);
    } else if (
      // Through prioritiseMenu with the accepted cap FIRST, so this compares
      // the menu we would render against the one on screen. Comparing the raw
      // build against the truncated `menuItems` can never match once the host
      // caps the list, so every poll rebuilt the menu — the rebuild that ate
      // the "Find my car" press. See the warning on sameMenu.
      sameMenu(
        prioritiseMenu(buildMenuItems(lastStatus, settings), acceptedMenuMax()),
        menuItems,
      )
    ) {
      await updateMenuInfo(
        safeText("render/menu", () => formatMenuInfo(lastStatus, note), SAFE_NOTE),
      );
    } else {
      await showMenu(note);
    }
  } catch (err) {
    // Everything below already degrades per-container; this is the last
    // resort (e.g. buildMenuItems itself threw during the sameMenu diff).
    // Fall back to the HUD, whose row/bottom formatters are individually
    // guarded — thin data beats a dead screen.
    recordError("render", err);
    await showHud(SAFE_NOTE).catch(() => undefined);
  }
}

async function pollStatus(note = "") {
  if (!client) {
    await renderCurrent(NOT_CONFIGURED);
    return;
  }
  try {
    lastStatus = await client.getStatus();
    applyPowertrain(lastStatus);
    await renderCurrent(note);
  } catch (err) {
    // 409 mid-session = device token expired. Clear it so the phone-side
    // enrollment section reappears; the glasses show "open phone app".
    if (err instanceof ApiError && err.status === 409 && settings.kiaUsDeviceToken) {
      delete settings.kiaUsDeviceToken;
      rebuildClient();
      void enqueue(() => saveSettings(bridge as Bridge, settings));
    }
    // Keep showing the last-known data with the error appended — never blank.
    recordError("status", err);
    await renderCurrent(describeError(err));
  }
}

// Phone settings: show/hide form sections from the persisted powertrain
// (chargeLimitsRelevant in settings.ts holds the rule). Reads settings, not
// a live status, so the form is right on open before any fetch.
function renderPowertrainForm() {
  const el = document.getElementById("charge-limits-section");
  if (!el) return;
  const show = chargeLimitsRelevant(
    settings.lastPowertrain,
    settings.lastPowertrainFuelOnly,
  );
  el.style.display = show ? "" : "none";
  console.debug(
    `powertrain form: ${settings.lastPowertrain ?? "none"}` +
      `${settings.lastPowertrainFuelOnly ? " (fuel-only)" : ""} → charge limits ${show ? "shown" : "hidden"}`,
  );
}

// Evaluate the powertrain from any successful status fetch (glasses poll,
// launch connect, or the phone Test connection), persist it when it changed,
// and re-render the form. A status without the powertrain field (older
// proxy) keeps the last-known classification rather than resetting it.
function applyPowertrain(status: VehicleStatus | null) {
  const pt = status?.powertrain;
  if (typeof pt === "string" && status) {
    const fuelOnly =
      status.fuel_level_percent != null && status.soc_percent == null;
    if (
      settings.lastPowertrain !== pt ||
      settings.lastPowertrainFuelOnly !== fuelOnly
    ) {
      settings.lastPowertrain = pt;
      settings.lastPowertrainFuelOnly = fuelOnly;
      void enqueue(() => saveSettings(bridge as Bridge, settings));
    }
  }
  renderPowertrainForm();
  // The car has just told us what limits it holds — that may be exactly what
  // is on the form, in which case the send button quietly goes away.
  syncPhoneLimits?.();
}

function scheduleRepoll(delayMs: number) {
  if (repollTimer) clearTimeout(repollTimer);
  repollTimer = setTimeout(() => {
    repollTimer = null;
    void pollStatus();
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Launch connection — wake the backend, then fetch the first /status.

let spinTimer: ReturnType<typeof setInterval> | null = null;
let spinIndex = 0;

function stopSpinner() {
  if (spinTimer) clearInterval(spinTimer);
  spinTimer = null;
}

// One 90° rotation step per second via plain text swaps.
function startSpinner() {
  stopSpinner();
  spinIndex = 0;
  spinTimer = setInterval(() => {
    // The spinner's container only exists on the connect page. A tick that
    // lands after we've moved on is refused by the host and would otherwise
    // inflate the diagnostic's rejection counter with pure noise — and that
    // counter is now the signal for real page failures.
    if (view !== "connect" || backgrounded) return;
    spinIndex = (spinIndex + 1) % 4;
    void upgradeText(CONNECT_SPIN_CONTAINER, spinnerFrame(spinIndex));
  }, 1000);
}

async function connectToBackend() {
  const gen = ++connectGen;
  if (!client) {
    connectState = "failed";
    await upgradeText(CONNECT_SPIN_CONTAINER, " ");
    await upgradeText(
      CONNECT_CONTAINER,
      formatConnectFail(NOT_CONFIGURED, "Double-tap to exit"),
    );
    return;
  }
  connectState = "connecting";
  await upgradeText(CONNECT_CONTAINER, CONNECTING_TEXT);
  await upgradeText(CONNECT_SPIN_CONTAINER, spinnerFrame(0));
  startSpinner();
  try {
    // One straight /status: the hosted proxy has no cold start (the Render
    // wake loop is gone), and the generous request timeout already covers a
    // session-cache-miss login on the proxy side.
    const status = await client.getStatus();
    if (gen !== connectGen) return; // superseded or backgrounded mid-flight
    lastStatus = status;
    applyPowertrain(status);
    stopSpinner();
    await showHud();
  } catch (err) {
    if (gen !== connectGen) return;
    stopSpinner();
    connectState = "failed";
    // 409 = device token expired/missing. Clear the stale token so the
    // phone-side enrollment section appears when the user opens settings.
    if (err instanceof ApiError && err.status === 409 && settings.kiaUsDeviceToken) {
      delete settings.kiaUsDeviceToken;
      rebuildClient();
      void enqueue(() => saveSettings(bridge as Bridge, settings));
    }
    recordError("connect", err);
    await upgradeText(CONNECT_SPIN_CONTAINER, " ");
    await upgradeText(CONNECT_CONTAINER, formatConnectFail(describeError(err)));
  }
}

// Opening the menu auto-fetches cached /status once so the context-aware
// items reflect reality without any manual refresh action.
async function openMenu() {
  if (await showMenu()) {
    // Only chase a status refresh if the menu is genuinely up — polling into a
    // page that never landed is how a failed rebuild used to cascade.
    await pollStatus();
    return;
  }
  // The host refused the menu page. A refused rebuild can leave the panel with
  // no event-capture container at all, which is what killed single taps on
  // hardware while system-level double-taps kept arriving. Re-assert a
  // known-good page so the user gets their gestures back instead of a screen
  // that looks alive and answers nothing.
  console.log("glasses: menu rebuild refused — falling back to the HUD");
  await showHud();
}

// ---------------------------------------------------------------------------
// Menu actions — every action fires on a single tap, no confirm step.

async function selectMenuItem(index: number) {
  const item = menuItems[index];
  if (!item) return;

  if (item.key === "hud") {
    await showHud();
    return;
  }
  if (item.key === "finder") {
    // No backend needed — the car position is already in lastStatus and the
    // rest is on-device maths.
    await enterFinder();
    return;
  }
  if (item.key === "quit") {
    // Same system Yes/No dialog as double-tap; cleanup stays in the
    // SYSTEM_EXIT handler so cancelling leaves a live app.
    void bridge.shutDownPageContainer(1);
    return;
  }
  if (!client) {
    await updateMenuInfo(formatMenuInfo(lastStatus, NOT_CONFIGURED));
    return;
  }

  if (item.key === "refresh") {
    // Cached /status only — never wakes the car. The item label carries the
    // last-updated time, so a changed timestamp rebuilds the list.
    await updateMenuInfo(formatMenuInfo(lastStatus, "Refreshing…"));
    await pollStatus("Refreshed");
    return;
  }

  await updateMenuInfo(formatMenuInfo(lastStatus, "Sending…"));
  try {
    let note = "";
    switch (item.key) {
      case "lock":
        await client.lock();
        note = "Lock sent";
        break;
      case "unlock":
        await client.unlock();
        note = "Unlock sent (relocks in ~30s)";
        break;
      case "climateOn":
        await client.climate(
          true,
          settings.climateTemp,
          settings.climateDefrost,
          settings.climateHeating,
        );
        note = "Climate on sent";
        break;
      case "climateOff":
        await client.climate(false, settings.climateTemp, false, false);
        note = "Climate off sent";
        break;
      case "chargeStart":
        await client.charge(true);
        note = "Charge start sent";
        break;
      case "chargeStop":
        await client.charge(false);
        note = "Charge stop sent";
        break;
    }
    // Fire-and-forget: back to the glanceable HUD with the sent note; the
    // car takes 30–90 s to apply, so re-poll the backend cache later.
    await showHud(`${note}, car applies in 30-90s`);
    scheduleRepoll(15_000);
  } catch (err) {
    recordError(item.key, err);
    await updateMenuInfo(formatMenuInfo(lastStatus, describeError(err)));
  }
}

// ---------------------------------------------------------------------------
// Events

let unsubscribe: () => void = () => {};

function subscribeEvents() {
  unsubscribe = bridge.onEvenHubEvent((event) => {
    // The decision lives in glasses-input.ts (pure, unit-tested against the
    // real payload shapes — including proto3's elided CLICK_EVENT). This
    // function is only the effects half. Keeping them apart is what makes the
    // whole gesture matrix testable without hardware.
    const snapshot: RouterState = {
      view,
      connectState,
      hasClient: client != null,
      lastDoubleClickAt,
      now: Date.now(),
    };
    const { action, acceptedDoubleClickAt, branch } = routeGlassesEvent(
      event,
      snapshot,
    );
    if (acceptedDoubleClickAt != null) lastDoubleClickAt = acceptedDoubleClickAt;
    // One line per event, kept for the diagnostic report — raw shape, branch
    // taken, and the state the router believed. A gesture regression is then
    // one hardware minute to diagnose instead of a walk and a guess.
    inputTrace.record(event, branch, snapshot);
    // Mirrored to the console so the simulator can show the same evidence the
    // hardware diagnostic report carries.
    console.log(`glasses-event: ${describeRawEvent(event)} → ${branch} (view ${snapshot.view})`);

    switch (action.kind) {
      case "openMenu":
        void openMenu();
        return;
      case "exitDialog":
        // Cleanup happens on SYSTEM_EXIT, not here — the user can still
        // cancel. (The simulator just blanks the panel; hardware shows Yes/No.)
        void bridge.shutDownPageContainer(1);
        return;

      case "systemExit":
        if (repollTimer) clearTimeout(repollTimer);
        stopSpinner();
        clearNoteTimer();
        // The app is going away with the GPS watch possibly still running —
        // this is the path that would otherwise leak it into the user's
        // pocket. Detach both surfaces so the engine tears the watch down.
        finderEngine.detach(glassesFinderRenderer);
        detachPhoneFinder();
        unsubscribe();
        return;

      case "foregroundEnter":
        backgrounded = false;
        if (view === "finder") {
          // The glasses renderer was detached on the way out; re-attach it. If
          // the phone kept the session alive it rejoins the same loop;
          // otherwise a fresh session starts, painting at once either way.
          finderEngine.attach(glassesFinderRenderer);
        } else if (view === "connect") {
          // Restart the attempt outright: a fetch suspended mid-flight may
          // never settle, and the old attempt was invalidated on
          // FOREGROUND_EXIT — a resume must never leave an endless spinner.
          void connectToBackend();
        } else {
          void pollStatus();
        }
        return;

      case "foregroundExit":
        // Backgrounded: stop driving the display and the network. Everything
        // resumes via FOREGROUND_ENTER. Settings are already durable.
        backgrounded = true;
        connectGen++;
        stopSpinner();
        if (repollTimer) clearTimeout(repollTimer);
        repollTimer = null;
        clearNoteTimer();
        // GPS is the expensive one: a watch left running while the phone is in
        // a pocket is a battery complaint. The watch stops unless the phone
        // finder is also open (it keeps its own session).
        finderEngine.detach(glassesFinderRenderer);
        return;

      case "selectMenuItem":
        void selectMenuItem(action.index);
        return;
      case "retryConnect":
        void connectToBackend();
        return;
      case "exitFinder":
        void exitFinder();
        return;
      case "toggleHud":
        void toggleHudHidden();
        return;
      case "ignore":
        return;
    }
  });
}

// ---------------------------------------------------------------------------
// Phone-side settings screen

function setStatus(el: HTMLParagraphElement, text: string, isError = false) {
  el.textContent = text;
  el.classList.toggle("err", isError);
}

/**
 * Re-fill the settings form from `settings`, published by `bindPhoneUi`.
 *
 * The form binds before the settings read completes (that read goes over the
 * bridge, and the bridge is no longer allowed to gate the phone UI), so boot
 * calls this once the real values land. It leaves a form the user has already
 * typed into alone.
 */
let hydratePhoneForm: ((force?: boolean) => void) | null = null;

/**
 * Re-evaluate the contextual charge-limit send button, published by
 * `bindPhoneUi`. Called after every successful status fetch: the car's own
 * reported limits are one of the two inputs to "does the form disagree with
 * the car", so a poll can stand the button down (or raise it) with no
 * interaction at all.
 */
let syncPhoneLimits: (() => void) | null = null;

function bindPhoneUi() {
  // Fill the brand word into the static copy before anything else renders.
  applyBrand();

  const guideEl = document.getElementById("setup-guide") as HTMLDetailsElement;
  const usernameEl = document.getElementById("acct-username") as HTMLInputElement;
  const passwordEl = document.getElementById("acct-password") as HTMLInputElement;
  const pinEl = document.getElementById("acct-pin") as HTMLInputElement;
  const regionEl = document.getElementById("acct-region") as HTMLSelectElement;
  const testBtn = document.getElementById("test-btn") as HTMLButtonElement;
  const testStatus = document.getElementById(
    "test-status",
  ) as HTMLParagraphElement;
  const tempEl = document.getElementById("climate-temp") as HTMLInputElement;
  const tempUnitEl = document.getElementById("temp-unit") as HTMLSelectElement;
  const tempLabelEl = document.getElementById(
    "climate-temp-label",
  ) as HTMLLabelElement;
  const defrostEl = document.getElementById(
    "climate-defrost",
  ) as HTMLInputElement;
  const heatingEl = document.getElementById(
    "climate-heating",
  ) as HTMLInputElement;
  const acEl = document.getElementById("charge-limit-ac") as HTMLSelectElement;
  const dcEl = document.getElementById("charge-limit-dc") as HTMLSelectElement;
  const limitsBtn = document.getElementById("limits-btn") as HTMLButtonElement;
  const limitsStatus = document.getElementById(
    "limits-status",
  ) as HTMLParagraphElement;
  const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
  const saveStatus = document.getElementById(
    "save-status",
  ) as HTMLParagraphElement;
  // Presentation-only additions: the connection chip beside the ACCOUNT
  // heading, the mono battery/last-test readout next to Test connection, the
  // segmented unit switch and the climate steppers. All optional — a missing
  // one degrades rather than throwing, because a cosmetic element must never
  // be able to take the whole form down with it.
  const connChip = document.getElementById("conn-chip");
  const testReadout = document.getElementById("test-readout");
  const tempUnitSuffix = document.getElementById("climate-temp-unit");
  const unitSegs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".seg[data-unit]"),
  );
  const tempDownBtn = document.getElementById("temp-down");
  const tempUpBtn = document.getElementById("temp-up");

  // The unit currently on screen. `climateTemp` is Celsius no matter what
  // this says — only the input, its bounds and the label follow it.
  let tempUnit: TempUnit = resolveTempUnit(settings);
  // Once the user picks a unit themselves we stop inferring it from the
  // region, so choosing Celsius in the US survives a later region edit.
  let tempUnitExplicit = settings.tempUnit != null;

  // The big mono readout IS the input, so it has to be exactly as wide as its
  // own digits — a fixed width leaves "70" floating away from the "°F".
  function sizeTempInput() {
    tempEl.style.width = `${Math.max(2, tempEl.value.length)}ch`;
  }

  // Retarget the input at `unit`, carrying whatever is currently typed across
  // the conversion (it's read back in `prev`, the unit it was entered in) so
  // an unsaved edit isn't lost by flipping the toggle.
  function applyTempUnit(unit: TempUnit, prev: TempUnit) {
    const canonicalC = toCanonicalC(parseFloat(tempEl.value), prev);
    tempUnit = unit;
    tempUnitEl.value = unit;
    const field = tempFieldState(canonicalC, unit);
    // Bounds before value: assigning a Fahrenheit value while the Celsius
    // max is still in place would let the browser clamp it.
    tempEl.min = field.min;
    tempEl.max = field.max;
    tempEl.step = field.step;
    tempEl.value = field.value;
    // The unit rides on the value ("21°C") in this layout, so the label above
    // it is the fixed micro-label; the full sentence stays as the input's
    // accessible name.
    tempLabelEl.textContent = "Climate target";
    tempEl.setAttribute("aria-label", field.label);
    if (tempUnitSuffix) tempUnitSuffix.textContent = `°${unit}`;
    for (const seg of unitSegs) {
      seg.setAttribute("aria-pressed", String(seg.dataset.unit === unit));
    }
    sizeTempInput();
  }

  tempUnitEl.addEventListener("change", () => {
    tempUnitExplicit = true;
    applyTempUnit(tempUnitEl.value as TempUnit, tempUnit);
  });

  // The segmented switch drives the (hidden) select rather than the unit
  // directly: the select stays the one source of truth every existing handler
  // — and the dirty tracking — already reads.
  for (const seg of unitSegs) {
    seg.addEventListener("click", () => {
      const unit = seg.dataset.unit as TempUnit;
      if (unit === tempUnitEl.value) return;
      tempUnitEl.value = unit;
      tempUnitEl.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // Steppers: one step of whatever the current unit's step is (1°C / 1°F),
  // clamped by the input's own min/max. `input` keeps the width in step and
  // marks the form dirty exactly as typing would.
  function stepTemp(dir: 1 | -1) {
    if (dir > 0) tempEl.stepUp();
    else tempEl.stepDown();
    tempEl.dispatchEvent(new Event("input", { bubbles: true }));
    tempEl.dispatchEvent(new Event("change", { bubbles: true }));
  }
  tempUpBtn?.addEventListener("click", () => stepTemp(1));
  tempDownBtn?.addEventListener("click", () => stepTemp(-1));
  tempEl.addEventListener("input", sizeTempInput);

  for (const region of REGIONS) {
    regionEl.add(new Option(region.label, String(region.code)));
  }
  for (const el of [acEl, dcEl]) {
    for (let pct = 50; pct <= 100; pct += 10) {
      el.add(new Option(`${pct}%`, String(pct)));
    }
  }

  // Has the user touched the form? The fields are live from the moment they
  // bind, which is now BEFORE the settings read finishes (that read goes over
  // the bridge and the bridge may never arrive). Typing in that window must
  // survive the settings landing a moment later.
  let formDirty = false;
  // Save is disabled until something actually changes, so listening on a
  // hand-written list of fields is no longer good enough: one control the list
  // forgot would leave Save dead with nothing on screen saying why. Delegated,
  // in the capture phase, so every input/change under the form counts —
  // including the ones the steppers and the unit switch synthesise.
  //
  // Programmatic assignment fires neither event, so hydration can't mark
  // itself dirty.
  function markDirty() {
    formDirty = true;
    syncSaveEnabled();
  }
  const formRoot = document.getElementById("app") ?? document.body;
  formRoot.addEventListener("input", markDirty, true);
  formRoot.addEventListener("change", markDirty, true);

  /** Nothing changed ⇒ nothing to save. Re-enabled by any edit above. */
  function syncSaveEnabled() {
    saveBtn.disabled = !formDirty;
  }
  syncSaveEnabled();

  // -- Kia-US device enrollment: which section is on screen ------------------
  //
  // Deliberately above `hydrateFromSettings`, which calls `syncEnrollSection`:
  // the visibility USED to be decided once, at bind time, and bind time is
  // before the settings read resolves (it goes over the bridge). `regionEl`
  // still held the default Europe then, so a returning Kia-US owner with no
  // stored token — exactly the state a user is in when their device token
  // expires and they must re-enrol — opened the settings page to no enrolment
  // UI at all. It only appeared if they happened to touch the region select, or
  // after Test connection came back 409. The gating rule is unchanged; the
  // evaluation now re-runs whenever the form is re-filled from settings, the
  // same way the charge-limits section follows the persisted powertrain.
  const enrollSection = document.getElementById("enroll-section")!;
  const enrollStartArea = document.getElementById("enroll-start-area")!;
  const enrollVerifyArea = document.getElementById("enroll-verify-area")!;
  const enrollNotifyType = document.getElementById("enroll-notify-type") as HTMLSelectElement;
  const enrollStartBtn = document.getElementById("enroll-start-btn") as HTMLButtonElement;
  const enrollCodeEl = document.getElementById("enroll-code") as HTMLInputElement;
  const enrollVerifyBtn = document.getElementById("enroll-verify-btn") as HTMLButtonElement;
  const enrollStatus = document.getElementById("enroll-status") as HTMLParagraphElement;
  const enrollStepEl = document.getElementById("enroll-step");
  const enrollBar2 = document.getElementById("enroll-bar-2");
  const enrollExplainer = document.getElementById("enroll-explainer");

  /** "j.berry@example.com" → "j***y@example.com"; anything else is left alone
   *  (an SMS destination is already masked by the upstream). */
  function maskDestination(dest: string): string {
    const at = dest.indexOf("@");
    if (at < 3) return dest;
    return `${dest[0]}***${dest[at - 1]}${dest.slice(at)}`;
  }

  /**
   * Presentation for the two-step panel: which progress bar is filled, the
   * "N / 2" counter, and the explainer — which names the masked destination
   * once a code has actually been sent somewhere.
   */
  function setEnrollStep(step: 1 | 2, dest?: string | null) {
    if (enrollStepEl) enrollStepEl.textContent = `${step} / 2`;
    enrollBar2?.classList.toggle("pending", step < 2);
    if (!enrollExplainer) return;
    enrollExplainer.textContent =
      step === 2 && dest
        ? `${BRAND.serviceName} (US) needs a one-time code to trust this app. Sent to ${maskDestination(dest)}.`
        : `${BRAND.serviceName} (US) needs a one-time code to trust this app. It expires after a few minutes.`;
  }
  setEnrollStep(1);

  function needsEnrollment(): boolean {
    return IS_KIA_US && Number(regionEl.value) === 3;
  }

  function showEnrollSection() {
    if (needsEnrollment()) enrollSection.style.display = "";
  }

  function hideEnrollSection() {
    // Already hidden ⇒ nothing to do. Not just an optimisation: the reset below
    // discards a code the user has typed and the "code sent" line above it, so
    // a re-evaluation that changes nothing must not touch the DOM at all.
    if (enrollSection.style.display === "none") return;
    enrollSection.style.display = "none";
    enrollVerifyArea.style.display = "none";
    enrollCodeEl.value = "";
    setEnrollStep(1);
    setStatus(enrollStatus, "");
  }

  /**
   * Show or hide the enrolment section from the region ON SCREEN plus whether a
   * device token is stored. Idempotent — re-running it with nothing changed
   * leaves the DOM untouched, so hydration, the region listener and the
   * enrolment handlers can all call it without flicker or lost input.
   */
  function syncEnrollSection() {
    const show = needsEnrollment() && !settings.kiaUsDeviceToken;
    if (show) showEnrollSection();
    else hideEnrollSection();
    // Logged like the powertrain form: the original bug was invisible from the
    // outside — the section was simply absent, with nothing saying why.
    console.debug(
      `enrolment form: brand ${BRAND.id}, region ${regionEl.value}, ` +
        `token ${settings.kiaUsDeviceToken ? "stored" : "none"}` +
        ` → ${show ? "shown" : "hidden"}`,
    );
  }

  // -- Charge limits: the contextual send ------------------------------------
  //
  // Car commands in this app are always a deliberate, separately-labelled tap.
  // Changing a dropdown is a preference edit; telling the car about it is an
  // action, and it gets its own button, its own label naming the exact values,
  // and its own status line. The button is only on screen while the form and
  // the car actually disagree, so the common case stays clean — and because
  // "disagree" survives a failed send, the button IS the retry path for the
  // sleeping-car case.
  let limitsSending = false;

  function formLimits(): { ac: number; dc: number } {
    return { ac: Number(acEl.value), dc: Number(dcEl.value) };
  }

  function syncLimitsButton() {
    const { ac, dc } = formLimits();
    if (limitsSending) {
      // Stays on screen while in flight so the values being sent are still
      // readable, and disabled so a second tap cannot start a second push.
      limitsBtn.hidden = false;
      limitsBtn.disabled = true;
      limitsBtn.textContent = "Sending…";
      return;
    }
    const known = carKnownLimits(
      settings.chargeLimitsSent,
      {
        ac: lastStatus?.charge_limit_ac,
        dc: lastStatus?.charge_limit_dc,
      },
      Date.now(),
    );
    const offer =
      // No saved account ⇒ nothing to send to. First run shows the limit
      // dropdowns without an action that could only fail.
      isConfigured(settings) &&
      chargeLimitsRelevant(
        settings.lastPowertrain,
        settings.lastPowertrainFuelOnly,
      ) &&
      limitsNeedSending(ac, dc, known);
    limitsBtn.hidden = !offer;
    limitsBtn.disabled = false;
    limitsBtn.textContent = `Send ${ac}% / ${dc}% to car`;
  }

  // The label names the values, so it has to follow the dropdowns; and whether
  // the button is offered at all follows them too. Editing a limit also drops
  // the previous send's result — "Sent." above a value that has since changed
  // would be a lie. (Clearing it inside syncLimitsButton would instead wipe the
  // confirmation the moment a successful send stood the button down.)
  function onLimitEdited() {
    setStatus(limitsStatus, "");
    syncLimitsButton();
  }
  acEl.addEventListener("change", onLimitEdited);
  dcEl.addEventListener("change", onLimitEdited);

  limitsBtn.addEventListener("click", async () => {
    // Never concurrent: a tap while one is in flight is ignored outright, not
    // queued. The disabled state above already blocks it; this is the belt.
    if (limitsSending) return;
    const limitsClient = formClient();
    if (!limitsClient) {
      setStatus(limitsStatus, "Enter your account details first.", true);
      return;
    }
    const { ac, dc } = formLimits();
    limitsSending = true;
    syncLimitsButton();
    setStatus(limitsStatus, "Sending…");
    try {
      await limitsClient.setChargeLimits(ac, dc);
      // Record what the car now holds so the button stands down. Persisted
      // through the same queue as everything else, and deliberately NOT via
      // persistForm: sending must not quietly save the rest of the form.
      settings.chargeLimitsSent = { ac, dc, at: Date.now() };
      void enqueue(() => saveSettings(bridge as Bridge, settings));
      setStatus(limitsStatus, "Sent. The car applies them in 30–90 s.");
    } catch (err) {
      recordError("charge-limits", err);
      // The values still disagree with the car, so syncLimitsButton leaves the
      // button up — that is the retry, no extra state needed.
      setStatus(limitsStatus, describeError(err), true);
    } finally {
      limitsSending = false;
      syncLimitsButton();
    }
  });

  /**
   * Fill the form from `settings`. Called once at bind time (with whatever
   * defaults are in place) and again when the real settings arrive — see
   * `hydratePhoneForm` and the boot block.
   */
  function hydrateFromSettings(force = false) {
    if (formDirty && !force) return;
    // First run: walk the user through setup. Once configured, collapse it.
    guideEl.open = !isConfigured(settings);
    usernameEl.value = settings.username;
    passwordEl.value = settings.password;
    pinEl.value = settings.pin;
    regionEl.value = String(settings.region);
    tempUnitExplicit = settings.tempUnit != null;
    // Seed the field in Celsius (the stored unit), then let applyTempUnit
    // convert it into whatever the user should see.
    tempEl.value = String(settings.climateTemp);
    applyTempUnit(resolveTempUnit(settings), "C");
    defrostEl.checked = settings.climateDefrost;
    heatingEl.checked = settings.climateHeating;
    acEl.value = String(settings.chargeLimitAc);
    dcEl.value = String(settings.chargeLimitDc);
    // Sections reflect the persisted powertrain immediately — no waiting for
    // a fetch to stop showing an EV form to a fuel car.
    renderPowertrainForm();
    // A limit typed but never sent has just been re-filled from storage; the
    // button has to come back with it, still offering the send.
    syncLimitsButton();
    // Same rule for enrolment: the saved region decides it, so it has to be
    // re-evaluated here and not only when the user changes the select.
    syncEnrollSection();
  }
  hydrateFromSettings(true);
  hydratePhoneForm = hydrateFromSettings;
  syncPhoneLimits = syncLimitsButton;

  // -- Connection chip + last-test readout ----------------------------------
  //
  // Pure presentation over the Test connection flow that already exists: the
  // chip beside the ACCOUNT heading says whether the last test succeeded
  // (nothing at all until one has been run), and the mono block beside the
  // button carries the last known energy figure and the time of the last
  // successful test — the two things worth remembering between visits.
  function setConnectionChip(state: "idle" | "testing" | "ok" | "error") {
    if (!connChip) return;
    if (state === "idle" || state === "testing") {
      connChip.hidden = true;
      return;
    }
    connChip.hidden = false;
    connChip.classList.toggle("chip-off", state === "error");
    connChip.textContent = state === "ok" ? "● Connected" : "● Not connected";
  }

  function setTestReadout(status: VehicleStatus | null, at: number) {
    if (!testReadout) return;
    // Whichever energy figure this car actually reports — a hybrid answering
    // "BATT ?%" would read as a broken connection.
    const level = status?.soc_percent ?? status?.fuel_level_percent ?? null;
    const label = status?.soc_percent != null ? "BATT" : "FUEL";
    const time = new Date(at).toTimeString().slice(0, 5);
    testReadout.textContent =
      (level != null ? `${label} ${Math.round(level)}%\n` : "") + time;
  }

  // Client built from the current field values (not saved state) so users
  // can test before saving. Null until username + password are filled in.
  function formClient(): BackendClient | null {
    if (!usernameEl.value.trim() || !passwordEl.value) return null;
    return new BackendClient({
      username: usernameEl.value.trim(),
      password: passwordEl.value,
      pin: pinEl.value.trim(),
      region: Number(regionEl.value),
      brand: BRAND.apiBrandCode,
      // After enrollment, Test connection must include the stored device
      // token so the proxy recognises the trusted device and skips OTP.
      ...(IS_KIA_US &&
      Number(regionEl.value) === 3 &&
      settings.kiaUsDeviceToken
        ? { device_token: settings.kiaUsDeviceToken }
        : {}),
    });
  }

  // healthz first isolates "proxy/internet down" from credential problems.
  testBtn.addEventListener("click", async () => {
    const probe = formClient();
    if (!probe) {
      setStatus(testStatus, "Enter your username and password first.", true);
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = "Testing…";
    setConnectionChip("testing");
    setStatus(
      testStatus,
      "Testing… (the first sign-in can take up to a minute)",
    );
    try {
      try {
        await probe.healthz(15_000);
      } catch {
        setConnectionChip("error");
        setStatus(
          testStatus,
          "Proxy unreachable. Check your internet connection.",
          true,
        );
        return;
      }
      try {
        const status = await probe.getStatus();
        // A successful phone-side fetch is as good as a glasses poll for
        // learning what the car is — adapt the form right away.
        applyPowertrain(status);
        // Describe whichever energy figure the car actually reports — a
        // hybrid answering "battery ?%" would read as a broken connection.
        const figure =
          status.soc_percent != null
            ? `battery ${status.soc_percent}%`
            : status.fuel_level_percent != null
              ? `fuel ${status.fuel_level_percent}%`
              : "limited data";
        // Success proves the form's details work — persist them now rather
        // than trusting the user to also tap Save.
        const saved = await persistForm();
        setConnectionChip("ok");
        setTestReadout(status, Date.now());
        setStatus(
          testStatus,
          `Connected. Car responded (${figure}).` +
            (saved ? " Details saved." : " Auto-save failed — tap Save."),
          !saved,
        );
      } catch (err) {
        setConnectionChip("error");
        recordError("test/status", err);
        if (err instanceof ApiError && err.status === 409) {
          // Clear the stale token so enrollment can start fresh.
          if (settings.kiaUsDeviceToken) {
            delete settings.kiaUsDeviceToken;
            void enqueue(() => saveSettings(bridge as Bridge, settings));
          }
          setStatus(
            testStatus,
            "Device enrollment required. Use the enrolment section below to verify your device.",
            true,
          );
          showEnrollSection();
        } else if (err instanceof ApiError && err.status === 401) {
          setStatus(
            testStatus,
            `${BRAND.serviceName} rejected the sign-in. Check username, password, PIN and region.`,
            true,
          );
        } else if (err instanceof ApiError && err.status === 502) {
          setStatus(
            testStatus,
            `Proxy OK, but ${BRAND.serviceName} could not be reached. Try again in a minute.`,
            true,
          );
        } else if (err instanceof ApiError && err.status === 500) {
          setStatus(
            testStatus,
            "Signed in, but the car data could not be parsed. This is a backend bug, please report it.",
            true,
          );
        } else if (err instanceof ApiError && err.status === 429) {
          setStatus(
            testStatus,
            "Rate limited. Wait a minute and try again.",
            true,
          );
        } else if (err instanceof TimeoutError) {
          setStatus(
            testStatus,
            "The car status timed out. Try again in a minute.",
            true,
          );
        } else {
          setStatus(testStatus, "The status check failed.", true);
        }
      }
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test connection";
    }
  });

  // -- Kia-US device enrollment ---------------------------------------------
  // The section's elements and its visibility rule live above, next to
  // `hydrateFromSettings` — the load-time evaluation has to happen there, after
  // the settings read lands. What follows is the enrolment flow itself.

  // Selecting USA switches the display to Fahrenheit (and back out of it),
  // but only while the user hasn't overridden the unit themselves.
  regionEl.addEventListener("change", () => {
    if (tempUnitExplicit) return;
    const inferred: TempUnit = Number(regionEl.value) === 3 ? "F" : "C";
    if (inferred !== tempUnit) applyTempUnit(inferred, tempUnit);
  });

  // Re-evaluate on region change — enrollment is only for Kia + US, and only
  // until a device token is stored.
  regionEl.addEventListener("change", syncEnrollSection);

  enrollStartBtn.addEventListener("click", async () => {
    const enrollClient = formClient();
    if (!enrollClient) {
      setStatus(enrollStatus, "Enter your account details first.", true);
      return;
    }
    enrollStartBtn.disabled = true;
    setStatus(enrollStatus, "Sending verification code...");
    try {
      const result = await enrollClient.enrollStart(
        enrollNotifyType.value as "EMAIL" | "SMS",
      );
      if (result.enrolled && result.device_token) {
        // Already trusted — no OTP needed. Persist the whole form with the
        // token: the token was minted for these credentials, and saving
        // only the token used to strand unsaved credentials.
        settings.kiaUsDeviceToken = result.device_token;
        const ok = await persistForm(true);
        setStatus(
          enrollStatus,
          ok
            ? "Device already trusted. Details saved."
            : "Device trusted but save failed. Tap Save.",
          !ok,
        );
        if (ok) hideEnrollSection();
      } else if (result.destinations) {
        const dest =
          enrollNotifyType.value === "EMAIL"
            ? result.destinations.email
            : result.destinations.sms;
        setStatus(
          enrollStatus,
          `Code sent to ${dest ?? "your " + enrollNotifyType.value.toLowerCase()}. Enter it below.`,
        );
        enrollStartArea.style.display = "none";
        enrollVerifyArea.style.display = "";
        setEnrollStep(2, dest ?? null);
        enrollCodeEl.focus();
      }
    } catch (err) {
      recordError("enroll/start", err);
      if (err instanceof ApiError && err.status === 429) {
        setStatus(enrollStatus, "Too many enrollment attempts. Wait and try again.", true);
      } else {
        setStatus(enrollStatus, describeError(err), true);
      }
    } finally {
      enrollStartBtn.disabled = false;
    }
  });

  enrollVerifyBtn.addEventListener("click", async () => {
    const code = enrollCodeEl.value.trim();
    if (!code) {
      setStatus(enrollStatus, "Enter the verification code.", true);
      return;
    }
    const enrollClient = formClient();
    if (!enrollClient) {
      setStatus(enrollStatus, "Enter your account details first.", true);
      return;
    }
    enrollVerifyBtn.disabled = true;
    setStatus(enrollStatus, "Verifying...");
    try {
      const result = await enrollClient.enrollVerify(code);
      // Persist the whole form, not just the token: enrolling before Save
      // used to leave the credentials unsaved — and a later Save then wiped
      // the fresh token via the username-change rule (saved username was
      // still empty), forcing a re-enrolment.
      settings.kiaUsDeviceToken = result.device_token;
      const ok = await persistForm(true);
      if (ok) {
        setStatus(
          enrollStatus,
          "Device enrolled and details saved. Tap Test connection to verify.",
        );
        // Reset UI: hide enrollment, show success
        enrollStartArea.style.display = "";
        enrollVerifyArea.style.display = "none";
        enrollCodeEl.value = "";
        setEnrollStep(1);
        hideEnrollSection();
        setStatus(testStatus, "");
      } else {
        setStatus(enrollStatus, "Enrolled but save failed. Try saving again.", true);
      }
    } catch (err) {
      recordError("enroll/verify", err);
      if (err instanceof ApiError && err.status === 409) {
        // Enrollment session expired — restart
        setStatus(
          enrollStatus,
          "Session expired. Tap 'Send verification code' to get a new code.",
          true,
        );
        enrollStartArea.style.display = "";
        enrollVerifyArea.style.display = "none";
        enrollCodeEl.value = "";
        setEnrollStep(1);
      } else if (err instanceof ApiError && err.status === 401) {
        setStatus(enrollStatus, "Wrong code. Check and try again.", true);
      } else {
        setStatus(enrollStatus, describeError(err), true);
      }
    } finally {
      enrollVerifyBtn.disabled = false;
    }
  });

  // "Didn't get a code? Send again" — returns to the send step so the user
  // can re-request without being stuck on the verify screen.
  const enrollResend = document.getElementById("enroll-resend")!;
  enrollResend.addEventListener("click", (e) => {
    e.preventDefault();
    enrollStartArea.style.display = "";
    enrollVerifyArea.style.display = "none";
    enrollCodeEl.value = "";
    setEnrollStep(1);
    setStatus(enrollStatus, "");
  });

  // -- Diagnostics ------------------------------------------------------------
  const diagBtn = document.getElementById("diag-btn") as HTMLButtonElement;
  const diagStatus = document.getElementById(
    "diag-status",
  ) as HTMLParagraphElement;
  const diagCopied = document.getElementById("diag-copied");

  diagBtn.addEventListener("click", async () => {
    diagBtn.disabled = true;
    setStatus(diagStatus, "Building report…");

    const regionName =
      REGIONS.find((r) => r.code === Number(regionEl.value))?.label ??
      regionEl.value;

    // Finder telemetry survives session end in the engine, so a failed walk is
    // still describable here.
    const finderTelemetry = finderEngine.telemetry();

    // App-side info (always available, even if the backend is down).
    const lines: string[] = [
      `--- Connect Remote Diagnostic Report ---`,
      `App: ${BRAND.appName} v${APP_VERSION}`,
      `Brand: ${BRAND.id}`,
      `Region: ${regionName}`,
      `Device token stored: ${!!settings.kiaUsDeviceToken}`,
      `Last error: ${lastError ? `${lastError.endpoint} → ${lastError.status} (${lastError.detail})` : "none"}`,
      // The car-finder walk, summarised: which link died is readable from
      // which counter stopped. No coordinates — counts and ages only.
      `Finder: ${
        finderTelemetry
          ? `source ${finderTelemetry.source ?? "none"}` +
            `, fixes ${finderTelemetry.rawFixes} raw / ${finderTelemetry.usableFixes} usable` +
            `${finderTelemetry.lastRejectedAccuracy != null ? ` (last reject ±${Math.round(finderTelemetry.lastRejectedAccuracy)}m)` : ""}` +
            `, last fix ${finderTelemetry.lastFixAt ? `${Math.round((Date.now() - finderTelemetry.lastFixAt) / 1000)}s ago` : "never"}` +
            `, problems ${finderTelemetry.problems}${finderTelemetry.lastProblem ? ` (${finderTelemetry.lastProblem})` : ""}` +
            `, restarts ${finderTelemetry.restarts} watchdog / ${finderTelemetry.resumes} screen-wake` +
            `, repaints ${finderRenders.done}/${finderRenders.started}`
          : "not opened this session"
      }`,
      ``,
      // READ THIS LINE FIRST. Whether a host bridge ever attached. NOT
      // CONNECTED means no glasses call in the session could have done
      // anything: every host op below is a placeholder refusal and the glasses
      // half of the app was never running, so nothing further down is evidence
      // of anything except that.
      `Host bridge: ${gate.isReady() ? "connected" : "NOT CONNECTED"}`,
      // Did the host actually accept our page/text writes? These APIs return
      // false rather than rejecting, so "the page went up" is only knowable
      // from here.
      `Host ops: ${hostOpFailures} rejected${
        lastHostOp
          ? `, last ${lastHostOp.what} → ${lastHostOp.ok ? "ok" : "REJECTED"}` +
            ` ${Math.max(0, Math.round((Date.now() - lastHostOp.at) / 1000))}s ago`
          : ", none yet"
      }`,
      `Believed view: ${view}${backgrounded ? " (backgrounded)" : ""}`,
      // Which menu shape the host would accept — names the field or characters
      // it refuses when "full" isn't the answer.
      `Menu variant: ${menuVariantUsed ?? "none accepted yet"}`,
      `Finder layout: ${finderLayoutUsed ?? "not opened this session"}`,
      // The glasses events the router actually saw, newest last. "text(elided)"
      // vs "text(0)" is the distinction most gesture bugs turn on.
      `Input trace (last ${inputTrace.entries().length}):`,
      ...(inputTrace.entries().length
        ? inputTrace.lines(Date.now()).map((l) => `  ${l}`)
        : ["  no glasses events yet"]),
      ``,
    ];

    // Fetch /debug/fields if we have credentials — gracefully skip on failure.
    const diagClient = formClient();
    if (diagClient) {
      try {
        const fields = await diagClient.getDebugFields();
        lines.push(`--- Vehicle fields (server-redacted) ---`);
        lines.push(JSON.stringify(fields, null, 2));
      } catch (err) {
        lines.push(
          `--- Vehicle fields: fetch failed (${err instanceof ApiError ? err.status : "network"}) ---`,
        );
      }
    } else {
      lines.push(`--- Vehicle fields: skipped (no credentials) ---`);
    }

    const blob = lines.join("\n");

    // Copy to clipboard. Async clipboard API first, execCommand fallback,
    // then visible "copy failed" if neither works (WebView support unknown).
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(blob);
        copied = true;
      }
    } catch { /* swallow — fall through to fallback */ }
    if (!copied) {
      try {
        const ta = document.createElement("textarea");
        ta.value = blob;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { /* swallow */ }
    }

    if (copied) {
      setStatus(diagStatus, "Copied to clipboard. Paste it into a message to the developer.");
      // The row itself acknowledges, briefly — the status line under it is the
      // detail, this is the "it worked" the thumb is still over.
      if (diagCopied) {
        diagCopied.textContent = "Copied";
        setTimeout(() => { diagCopied.textContent = ""; }, 2000);
      }
    } else {
      setStatus(
        diagStatus,
        "Could not copy automatically. Long-press below to select and copy manually.",
        true,
      );
      // Show the blob in a selectable textarea as a last resort.
      let ta = document.getElementById("diag-fallback") as HTMLTextAreaElement | null;
      if (!ta) {
        ta = document.createElement("textarea");
        ta.id = "diag-fallback";
        ta.readOnly = true;
        ta.style.width = "100%";
        ta.style.height = "200px";
        ta.style.marginTop = "8px";
        ta.style.background = "#2e2e2e";
        ta.style.color = "#E5E5E5";
        ta.style.border = "1px solid #444";
        ta.style.borderRadius = "6px";
        ta.style.padding = "10px";
        ta.style.fontSize = "12px";
        ta.style.fontFamily = "monospace";
        diagStatus.after(ta);
      }
      ta.value = blob;
      ta.style.display = "";
      ta.focus();
      ta.select();
    }

    diagBtn.disabled = false;
  });

  // The one save routine: persists the current form to bridge storage.
  // Shared by the Save button and the auto-save-on-success paths (Test
  // connection, OTP enrolment) — the tester lost his credentials because
  // testing and enrolling before ever tapping Save persisted nothing.
  //
  // tokenFromForm: the device token now in `settings` was just minted with
  // the form's credentials (enrolment paths), so skip the username-change
  // wipe — that rule exists to kill a stored token belonging to a
  // previously saved, different account.
  async function persistForm(tokenFromForm = false): Promise<boolean> {
    // Read in whatever unit is on screen; store Celsius. Clamping and the
    // 0.5°C snap live in toCanonicalC.
    const temp = toCanonicalC(parseFloat(tempEl.value), tempUnit);
    // Different username ⇒ different account ⇒ old device token is stale.
    const usernameChanged =
      usernameEl.value.trim().toLowerCase() !==
      settings.username.trim().toLowerCase();
    if (!tokenFromForm && usernameChanged && settings.kiaUsDeviceToken) {
      delete settings.kiaUsDeviceToken;
      if (needsEnrollment()) showEnrollSection();
    }
    // Same reasoning for what we believe the car holds: a different account is
    // a different car, so "we sent it 80/90" stops meaning anything.
    if (usernameChanged) delete settings.chargeLimitsSent;
    settings = {
      username: usernameEl.value.trim(),
      password: passwordEl.value,
      pin: pinEl.value.trim(),
      region: Number(regionEl.value),
      climateTemp: temp,
      // Persist the unit only once it's been chosen deliberately — leaving it
      // undefined keeps the region inference live for users who never touch
      // the toggle.
      ...(tempUnitExplicit ? { tempUnit } : {}),
      climateDefrost: defrostEl.checked,
      climateHeating: heatingEl.checked,
      chargeLimitAc: Number(acEl.value),
      chargeLimitDc: Number(dcEl.value),
      // Preserve the Kia-US device token across saves — the enrollment
      // handlers write it to `settings` before this runs, and a plain save
      // must never wipe a hard-won OTP token. Cleared above when the
      // username changes (different account = stale token).
      ...(settings.kiaUsDeviceToken
        ? { kiaUsDeviceToken: settings.kiaUsDeviceToken }
        : {}),
      // Likewise the record of what the car was last told — it belongs to the
      // car, not the form, and a plain Save must not forget it and start
      // nagging to re-send limits the car already has.
      ...(settings.chargeLimitsSent
        ? { chargeLimitsSent: settings.chargeLimitsSent }
        : {}),
      // The powertrain memory belongs to the car, not the form — carry it
      // across saves.
      lastPowertrain: settings.lastPowertrain,
      lastPowertrainFuelOnly: settings.lastPowertrainFuelOnly,
    };
    rebuildClient();
    // `settings` has just been replaced, and the send button reads it — the
    // saved account gates whether it is offered at all, so a first Save has to
    // re-evaluate it rather than leaving the pre-account state on screen.
    syncLimitsButton();
    const ok = await enqueue(() => saveSettings(bridge as Bridge, settings));
    if (ok) guideEl.open = !isConfigured(settings);
    // Still on the connect page (first run: user just typed the account
    // details the connect attempt was missing) → restart the connect with the
    // new values; the generation guard supersedes any attempt still in flight.
    // After first connect, a plain re-poll updates the HUD/menu in place.
    if (view === "connect") {
      void connectToBackend();
    } else {
      void pollStatus();
    }
    return ok;
  }

  // Save is LOCAL ONLY. It writes the form to bridge storage and nothing else:
  // no request ever leaves the phone because the user tapped Save. Every car
  // command in this app is a deliberate, separately-labelled action (climate,
  // lock, charge, and the charge-limit send below), and Save must not become
  // the one exception — a preference write that silently drives the vehicle.
  //
  // The charge-limit VALUES are saved here like any other preference, so an
  // unsent limit survives a reload; whether the car has been told about it is
  // the send button's business, not this one's.
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const ok = await persistForm();
    if (!ok) {
      setStatus(saveStatus, "Save failed. Try again.", true);
      formDirty = true;
      syncSaveEnabled();
      return;
    }
    formDirty = false;
    syncSaveEnabled();
    setStatus(saveStatus, "Saved.");
    // A brief confirmation, then back to a quiet footer. Failures stay up.
    setTimeout(() => {
      if (!saveStatus.classList.contains("err")) setStatus(saveStatus, "");
    }, 4000);
  });
}

// ---------------------------------------------------------------------------
// Phone-side finder screen ("Find my car" on the phone)
//
// A standalone companion to the glasses arrow: the phone runs the SAME finder
// loop (finderEngine) and draws a radar from its frames, so it works with the
// glasses disconnected or absent, and renders alongside them from one shared
// state when both are active. Deliberately entered from a button near the
// bottom of the settings page — glasses-initiated is the primary path, this is
// the bonus.

function bindPhoneFinder() {
  const screenEl = document.getElementById("finder-screen") as HTMLDivElement;
  const openBtn = document.getElementById("finder-open") as HTMLButtonElement;
  const backBtn = document.getElementById("finder-back") as HTMLButtonElement;
  const doneBtn = document.getElementById("finder-done") as HTMLButtonElement;
  const messageEl = document.getElementById("finder-message") as HTMLDivElement;

  // The readout that leads: distance, then the heading phrase. The radar
  // underneath is confirmation — the two lines above it are the answer.
  const readoutEl = document.getElementById("finder-readout") as HTMLDivElement;
  const headlineEl = document.getElementById("finder-headline") as HTMLDivElement;
  const distValueEl = document.getElementById("finder-distance-value")!;
  const distUnitEl = document.getElementById("finder-distance-unit")!;
  const phraseEl = document.getElementById("finder-phrase")!;

  // The radar is DOM, not canvas: the dot and the rim arrowhead have to GLIDE
  // between updates (a fix arrives about once a second and a jumping dot reads
  // as a broken instrument), and a CSS `transform` transition does that for
  // free — including honouring prefers-reduced-motion, which a canvas tween
  // would have to reimplement. All the geometry still comes from the same
  // unit-tested radar.ts scene.
  const radarEl = document.getElementById("finder-radar") as HTMLDivElement;
  const ringsEl = document.getElementById("radar-rings") as HTMLDivElement;
  const arrowRotEl = document.getElementById("radar-arrow-rot") as HTMLDivElement;
  const arrowEl = document.getElementById("radar-arrow") as HTMLDivElement;
  const carWrapEl = document.getElementById("radar-car-wrap") as HTMLDivElement;
  const northRotEl = document.getElementById("radar-north-rot") as HTMLDivElement;
  const northEl = document.getElementById("radar-north") as HTMLDivElement;
  const scaleEl = document.getElementById("radar-scale") as HTMLDivElement;

  const detailEl = document.getElementById("finder-detail") as HTMLDivElement;
  const brgEl = document.getElementById("finder-brg")!;
  const cardinalEl = document.getElementById("finder-cardinal")!;
  const ageEl = document.getElementById("finder-age")!;
  const noteEl = document.getElementById("finder-note")!;

  /** The design's radar, shrunk to fit narrower phones. The outer ring IS the
   *  box: the rim arrowhead sits outside it, which is why it is allowed to
   *  overflow. */
  const RADAR_MAX = 340;
  let layout: RadarLayout = layoutFor(RADAR_MAX);

  function resizeRadar() {
    const size = Math.max(220, Math.min(screenEl.clientWidth - 40, RADAR_MAX));
    radarEl.style.width = `${size}px`;
    radarEl.style.height = `${size}px`;
    layout = layoutFor(size);
    ringCount = -1; // insets are absolute px — rebuild them at the new size
  }

  // Range rings are rebuilt only when their COUNT changes; the scale itself
  // follows the distance, so this is once every few hundred metres at most.
  let ringCount = -1;
  function renderRings(radii: number[]) {
    if (radii.length === ringCount) return;
    ringCount = radii.length;
    // The outermost radius is the black outer ring, already drawn by the face.
    ringsEl.replaceChildren(
      ...radii.slice(0, -1).map((r) => {
        const div = document.createElement("div");
        div.className = "radar-ring";
        div.style.inset = `${Math.round(layout.radius - r)}px`;
        return div;
      }),
    );
  }

  // The first-run walkthrough doubles as the awaiting-permission screen: clear
  // copy, then it flows into the radar the moment the first fix lands.
  const WALKTHROUGH =
    "Find my car uses your phone's location to point you back to your car.\n\n" +
    "When your phone asks, tap Allow. Your location stays on this phone and is " +
    "never sent anywhere.";

  function problemCopy(frame: FinderFrame): string {
    if (frame.problem === "denied") {
      // iOS won't re-prompt once denied — the only fix is the settings app.
      return (
        "Location access is off for this app.\n\n" +
        "Turn it on in your phone's Settings › Even › Location, then reopen " +
        "Find my car."
      );
    }
    if (frame.problem === "unavailable") {
      return "No GPS signal.\n\nMove somewhere with a clearer view of the sky.";
    }
    // Mode "problem" with no watch problem ⇒ the car hasn't given a position.
    return (
      "Your car hasn't reported where it's parked yet.\n\n" +
      "Try again once it has."
    );
  }

  function showMessage(text: string) {
    messageEl.textContent = text;
    messageEl.style.display = "block";
    radarEl.style.display = "none";
    readoutEl.style.display = "none";
    detailEl.style.display = "none";
    noteEl.textContent = "";
  }
  function showRadar() {
    messageEl.style.display = "none";
    radarEl.style.display = "block";
    readoutEl.style.display = "flex";
    detailEl.style.display = "flex";
  }

  /** `formatDistance` produces one string ("140m", "1.2 km"); the layout wants
   *  the number and the unit set at different sizes on a shared baseline. */
  function splitDistance(text: string): [string, string] {
    const m = /^([\d.,]+)\s*(.*)$/.exec(text);
    return m ? [m[1], m[2]] : [text, ""];
  }

  /** "47 MIN AGO" for the readout row. Unlike `formatParkedAge` (which stays
   *  silent until a position is old enough to be worth warning about) this row
   *  always carries the age, so it reports from the first minute. */
  function parkedAgo(parkedAtIso: string | null | undefined, now: number): string {
    if (!parkedAtIso) return "";
    const at = new Date(parkedAtIso).getTime();
    if (isNaN(at) || at > now) return "";
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) return "JUST NOW";
    if (minutes < 60) return `${minutes} MIN AGO`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} HR AGO`;
    return `${Math.floor(hours / 24)} DAYS AGO`;
  }

  // The phone renderer: one FinderFrame → the readout, the radar and the meta
  // row, or a full-screen message for the awaiting/problem states (there is no
  // radar to draw without a fix).
  phoneFinderRenderer = {
    render(frame: FinderFrame) {
      if (!phoneFinderOpen) return;
      const v = frame.view;
      const mode = v.mode;
      if (mode === "awaiting") {
        showMessage(WALKTHROUGH);
        return;
      }
      if (mode === "problem") {
        showMessage(problemCopy(frame));
        return;
      }
      showRadar();

      // -- the two lines that lead --------------------------------------
      const unit = lastStatus?.range_unit ?? null;
      headlineEl.classList.toggle("is-text", mode === "arrived");
      headlineEl.classList.toggle("is-dim", frame.distanceM == null);
      if (mode === "arrived") {
        distValueEl.textContent = "You're here";
        distUnitEl.textContent = "";
      } else if (frame.distanceM != null) {
        const [value, distUnit] = splitDistance(
          formatDistance(frame.distanceM, unit),
        );
        distValueEl.textContent = value;
        distUnitEl.textContent = distUnit;
      } else {
        distValueEl.textContent = "—";
        distUnitEl.textContent = "m";
      }

      // The heading phrase needs a direction the user is FACING. This app has
      // no compass — it derives a travel course from successive fixes — so the
      // phrase appears while walking and is simply absent while stopped, which
      // is the handoff's "no heading" state. Nothing is guessed.
      const relative =
        frame.course != null && frame.bearingToCar != null
          ? angleDelta(frame.bearingToCar, frame.course)
          : null;
      phraseEl.textContent =
        mode === "arrived"
          ? "Check nearby"
          : frame.distanceM == null
            ? "Getting your location"
            : relative != null
              ? headingPhrase(relative)
              : "";

      // -- the radar ------------------------------------------------------
      const scene = computeScene(frame, layout);
      renderRings(scene.ringRadii);

      // North-up while stopped, course-up while walking (the map turns so
      // "ahead" is up) — the N marker stays TRUE either way by counter-rotating
      // with the scene.
      const rotation = frame.course ?? 0;
      northRotEl.style.transform = `rotate(${-rotation}deg)`;
      northEl.style.transform = `translateX(-50%) rotate(${rotation}deg)`;

      if (scene.car) {
        carWrapEl.style.display = "block";
        carWrapEl.style.transform = `translate(${scene.car.x - layout.cx}px, ${scene.car.y - layout.cy}px)`;
      } else {
        carWrapEl.style.display = "none";
      }

      // The rim arrowhead is the shared "walk this way" cue with the glasses
      // and only means that while there IS a course. Stopped, it degrades to a
      // grey marker of where the car lies on the north-up map — a direction,
      // not an instruction. Arrival drops it entirely.
      const arrowDeg =
        mode === "arrived"
          ? null
          : (scene.arrowheadDeg ?? frame.bearingToCar ?? null);
      if (arrowDeg == null) {
        arrowEl.style.display = "none";
      } else {
        arrowEl.style.display = "block";
        arrowEl.classList.toggle("is-muted", scene.arrowheadDeg == null);
        arrowRotEl.style.transform = `rotate(${arrowDeg}deg)`;
      }

      const range = niceRange(frame.distanceM ?? 0).maxRange;
      scaleEl.textContent = `R ${formatDistance(range, unit).toUpperCase()}`;

      // -- the meta row ---------------------------------------------------
      brgEl.textContent =
        frame.bearingToCar != null
          ? `BRG ${Math.round(frame.bearingToCar)}°`
          : "WAITING FOR GPS";
      cardinalEl.textContent =
        frame.bearingToCar != null ? cardinal(frame.bearingToCar) : "";
      ageEl.textContent = parkedAgo(
        lastStatus?.location_last_updated ?? null,
        Date.now(),
      );

      // The keep-unlocked note (the one thing the user can actually do about a
      // watch a locked phone kills) sits under Done, out of the readout's way.
      // Arrival advice takes the same line — same wording as the glasses.
      noteEl.textContent = frame.noteActive
        ? KEEP_UNLOCKED_NOTE
        : mode === "arrived"
          ? v.detail
          : (formatParkedAge(
              lastStatus?.location_last_updated ?? null,
              Date.now(),
            ) ?? "");
    },
  };

  // True when THIS phone screen put the glasses into the finder, so closing it
  // takes them back out — but a finder the user opened from the glasses is left
  // alone.
  let phoneOpenedGlassesFinder = false;

  async function openFinder() {
    if (phoneFinderOpen) return;
    phoneFinderOpen = true;
    screenEl.style.display = "flex";
    resizeRadar();
    // Attach to the shared loop (starts a session, or joins the glasses one).
    attachPhoneFinder();
    // Ensure a car position: if the last status lacked one, poll now — the
    // engine's tick starts the GPS watch the moment coordinates arrive.
    if (!carPosition() && client) void pollStatus();
    // Mirror onto the glasses. This is the "active from either side" half of
    // the design that was missing: opening from the phone now puts the finder
    // on the glasses too, both rendering the same session. It is also the only
    // route to the glasses finder while the host is refusing the menu page.
    if (view !== "finder") {
      phoneOpenedGlassesFinder = true;
      await enterFinder();
    }
  }

  function closeFinder() {
    if (!phoneFinderOpen) return;
    phoneFinderOpen = false;
    // Detach — the GPS watch is provably stopped unless the glasses finder is
    // also open (engine ref-counting).
    detachPhoneFinder();
    screenEl.style.display = "none";
    if (phoneOpenedGlassesFinder) {
      phoneOpenedGlassesFinder = false;
      void exitFinder();
    }
  }

  openBtn.addEventListener("click", openFinder);
  backBtn.addEventListener("click", closeFinder);
  doneBtn.addEventListener("click", closeFinder);
  window.addEventListener("resize", () => {
    if (phoneFinderOpen) resizeRadar();
  });

  // DEV only (constant-folded out of production): `VITE_FINDER_AUTO=1` opens the
  // phone finder on boot, so the simulator's webview screenshot can inspect the
  // radar without a way to click the DOM button through the glasses input API.
  if (import.meta.env.DEV && import.meta.env.VITE_FINDER_AUTO) {
    // Delayed so the app has finished connecting and settled on the HUD —
    // otherwise this races boot and the connect's showHud paints over the
    // finder. Matches a real user tapping the button, which is the path worth
    // exercising.
    setTimeout(() => void openFinder(), 4000);
  }
}

// ---------------------------------------------------------------------------
// Boot.
//
// Two independent surfaces, and only one of them needs the glasses. The phone
// settings screen is plain DOM in this same WebView; it binds first and
// unconditionally. Everything that drives the glasses waits on the host bridge,
// which may arrive late or never — and that wait no longer blocks anything.
//
// This ordering is the fix for a phone page whose every button was dead. It
// used to sit behind TWO gates that could each silently swallow it: the
// unbounded `await waitForEvenAppBridge()` at the top of this file, and a
// `createStartUpPageContainer` failure below, which skipped all binding and
// shut the app down.

// Separately, so one broken surface cannot silently disable the other. These
// run in order, and `bindPhoneFinder` used to be last: anything thrown by
// `bindPhoneUi` — one missing element, one unsupported DOM API — left the
// finder's listeners unattached with no error anyone would see, which is
// indistinguishable from the button being broken. The settings form and the
// finder screen fail independently now.
function bindSafely(what: string, bind: () => void) {
  try {
    bind();
  } catch (err) {
    console.error(`phone UI: ${what} failed to bind`, err);
  }
}
bindSafely("settings form", bindPhoneUi);
bindSafely("car finder", bindPhoneFinder);

gate.onReady(async (host) => {
  try {
    // The first frame goes to the glasses before anything else — in particular
    // before the settings read, which must never sit between launch and first
    // paint (black-frame risk on a slow storage read).
    const createResult = await host.createStartUpPageContainer(
      new CreateStartUpPageContainer(
        connectPage(CONNECTING_TEXT, spinnerFrame(0)),
      ),
    );

    // Settings load whatever the glasses did: the phone form needs them even
    // when the startup page was refused.
    settings = await loadSettings(bridge);
    // Dev-server-only (never in a production build: DEV guard): fake
    // credentials so the simulator can reach the HUD against a mock proxy
    // (VITE_BACKEND_URL). The mock ignores credentials entirely.
    if (import.meta.env.DEV && import.meta.env.VITE_FAKE_CREDS) {
      settings = { ...settings, username: "simulator", password: "simulator" };
    }
    rebuildClient();
    // The form has been live on defaults since bindPhoneUi; give it the real
    // values now (unless the user has already started typing).
    hydratePhoneForm?.();

    if (createResult !== 0) {
      // No startup page means nothing can ever render ON THE GLASSES — every
      // later call would drive containers that don't exist, so we neither
      // subscribe nor connect. The app is deliberately NOT shut down: the phone
      // settings screen is fully usable, and it is the only way to fix
      // credentials or send a diagnostic report. Exiting here is what left the
      // owner holding a page where nothing responded.
      console.error(
        `Startup page creation failed (${createResult}) — glasses UI disabled,` +
          ` phone settings still available`,
      );
      return;
    }
    subscribeEvents();
    void connectToBackend();
  } catch (err) {
    // Never an unhandled rejection: that would take the phone UI's console
    // with it and tell the next round nothing.
    console.error("glasses boot failed", err);
  }
});
