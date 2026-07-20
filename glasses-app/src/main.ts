import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";

import {
  ApiError,
  BackendClient,
  PROXY_URL,
  TimeoutError,
  type VehicleStatus,
} from "./api";
import { renderArrowFrames } from "./arrow-frames";
import { BRAND, applyBrand } from "./brand";
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
  sameMenu,
  spinnerFrame,
} from "./display";
import { createGlyphIndicator, createImageIndicator } from "./direction";
import {
  CourseTracker,
  type Fix,
  type FinderProblem,
  finderView,
  formatParkedAge,
} from "./finder";
import {
  type KeepaliveSocket,
  type SocketTelemetry,
  createSocketTelemetry,
  openKeepaliveSocket,
} from "./finder-socket";
import {
  type FinderWatch,
  type FinderWatchTelemetry,
  createFinderTelemetry,
  createFinderWatch,
} from "./finder-watch";
import {
  type AppSettings,
  type Bridge,
  type TempUnit,
  DEFAULT_SETTINGS,
  REGIONS,
  chargeLimitsRelevant,
  isConfigured,
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

const bridge = await waitForEvenAppBridge();

// Real settings load AFTER the first frame is on the glasses (boot section at
// the bottom) — a slow bridge storage read must never delay the first paint.
let settings: AppSettings = { ...DEFAULT_SETTINGS };
let client: BackendClient | null = null;
let lastStatus: VehicleStatus | null = null;
// 'connect' until the first successful /status (no HUD of empty values);
// then two-layer UI: 'hud' is glanceable status only, 'menu' holds controls.
let view: "connect" | "hud" | "menu" | "finder" = "connect";
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

function menuListContainer(items: MenuItem[]) {
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: MENU_LIST_WIDTH,
    height: 288,
    borderWidth: 1,
    borderColor: 8,
    borderRadius: 6,
    paddingLength: 4,
    ...MENU_LIST_CONTAINER,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 0, // auto fill container width
      isItemSelectBorderEn: 1,
      itemName: items.map((i) => i.label),
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

// Flicker-free in-place updates; only valid while the matching page is shown.
function upgradeText(
  ids: { containerID: number; containerName: string },
  content: string,
) {
  return enqueue(() =>
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        ...ids,
        content,
        contentOffset: 0,
        contentLength: 0,
      }),
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

function showHud(note = "") {
  view = "hud";
  // Explicit navigation to the HUD always shows it — landing from the menu
  // (or a fresh connect) on an invisible page would look broken.
  hudHidden = false;
  return enqueue(() =>
    bridge.rebuildPageContainer(new RebuildPageContainer(hudPage(note))),
  );
}

// List containers cannot be updated in-place, so entering the menu (or
// changing its context-aware items) is a full page rebuild.
function showMenu(note = "") {
  view = "menu";
  try {
    menuItems = buildMenuItems(lastStatus, settings);
  } catch (err) {
    // Same safety net as the HUD: a broken status must still leave a
    // navigable menu (the universal actions need no status at all).
    recordError("render/menu", err);
    menuItems = [
      { key: "hud", label: "Return to HUD" },
      { key: "refresh", label: "Refresh" },
      { key: "quit", label: "Quit" },
    ];
  }
  return enqueue(() =>
    bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        listObject: [menuListContainer(menuItems)],
        textObject: [
          menuInfoContainer(
            safeText(
              "render/menu",
              () => formatMenuInfo(lastStatus, note),
              SAFE_NOTE,
            ),
          ),
        ],
      }),
    ),
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
/** Re-render cadence: slow enough to be free, fast enough that the course
 *  expiring (user stopped walking) flips back to cardinal text promptly. */
const FINDER_TICK_MS = 1000;

// Telemetry strip on the finder screen (top edge) plus the Finder line in the
// diagnostic report. ON for the 1.3.x hardware-debug builds — the 1.3.0 walk
// froze with zero ways to tell which link died. Flip to false for a store
// release; the report line stays either way.
const FINDER_DEBUG = true;
// The circled-arrow image indicator (Round 3). false = the 1.3.1 glyph
// layout, kept as the fallback build if the image path misbehaves over BLE.
const FINDER_IMAGE_ARROW = true;
// Dim-grey ring/arrow when the car position is stale — the staleness-channel
// experiment. The simulator normalises greys, so only a hardware walk can
// judge it; flip false if it's illegible.
const STALE_DIM_ENABLED = true;
// Round 3 spike: hold a do-nothing WebSocket open while the finder runs, to
// test whether a live socket keeps iOS from suspending the WebView on screen
// lock (it does for AbleShow). Costs one idle connection; carries no data.
const FINDER_KEEPALIVE_SOCKET = true;
const KEEPALIVE_WS_URL =
  PROXY_URL.replace(/\/$/, "").replace(/^http/, "ws") + "/ws";

// Shown briefly when a screen-wake restart fires: honest guidance that works
// on any backend, whatever the socket spike concludes.
const KEEP_UNLOCKED_NOTE = "Keep phone unlocked while finding your car";
const FINDER_NOTE_MS = 6000;
let finderNoteUntil = 0;

let finderSocket: KeepaliveSocket | null = null;
// Like finderTelem: survives finder exit for the diagnostic report.
let socketTelem: SocketTelemetry | null = null;

let finderWatch: FinderWatch | null = null;
// One per finder session (created on entry, kept across watchdog/screen-wake
// watch replacements, and after exit for the diagnostic report).
let finderTelem: FinderWatchTelemetry | null = null;
// Repaints attempted vs completed. A growing gap is the signature of the
// bridge serialization chain jamming on a call that never settled — on-screen
// it is indistinguishable from GPS death, which is why it's counted.
let finderRenders = { started: 0, done: 0 };
let finderTick: ReturnType<typeof setInterval> | null = null;
let finderArrival: ReturnType<typeof setTimeout> | null = null;
let finderFix: Fix | null = null;
let finderProblem: FinderProblem | null = null;
let finderOctant: number | null = null;
const finderCourse = new CourseTracker();
// Last rendered content, so the 1 Hz tick only touches containers that
// actually changed — an unchanged upgrade is a wasted bridge call. (The
// direction indicator does its own diffing behind its interface.)
let finderShown: { main: string; foot: string } | null = null;
let finderDebugShown: string | null = null;

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
  return enqueue(() =>
    bridge.updateImageRawData(new ImageRawDataUpdate({ ...ids, imageData })),
  );
}
const directionIndicator = FINDER_IMAGE_ARROW
  ? createImageIndicator(pushImage, upgradeText, renderArrowFrames)
  : createGlyphIndicator(upgradeText);

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

/** Build the current finder strings. Crash-safe like every other formatter
 *  here: a maths bug must still leave a readable screen with a way out. */
function finderContent() {
  try {
    const v = finderView({
      car: carPosition(),
      fix: finderFix,
      course: finderCourse.course(Date.now()),
      now: Date.now(),
      unit: lastStatus?.range_unit ?? null,
      parkedAt: lastStatus?.location_last_updated ?? null,
      prevOctant: finderOctant,
      problem: finderProblem,
    });
    finderOctant = v.octant;
    // The screen-wake guidance note borrows the detail line briefly; problem
    // states keep their own explanation (it outranks advice).
    const detail =
      v.mode !== "problem" && Date.now() < finderNoteUntil
        ? KEEP_UNLOCKED_NOTE
        : v.detail;
    return {
      arrived: v.mode === "arrived",
      octant: v.octant,
      mode: v.mode as string,
      // Stale car position drives the dim-grey experiment on the image ring.
      stale:
        STALE_DIM_ENABLED &&
        formatParkedAge(
          lastStatus?.location_last_updated ?? null,
          Date.now(),
        ) != null,
      content: formatFinder({ ...v, detail }, FINDER_GEOM.compact),
    };
  } catch (err) {
    recordError("render/finder", err);
    return {
      arrived: false,
      octant: null,
      mode: "crash",
      stale: false,
      content: formatFinder({
        mode: "problem",
        arrow: null,
        headline: "Finder unavailable",
        detail: SAFE_NOTE,
        hint: "Tap: back · 2x tap: close app",
        octant: null,
      }, FINDER_GEOM.compact),
    };
  }
}

/** One line that tells the walker which link is dead while it's dead:
 *  raw-fix count (platform delivering?), usable count (filter passing?),
 *  seconds since the last fix, repaints done/attempted (bridge alive?),
 *  watch replacements (watchdog+screen-wake), and the current mode. The
 *  age counter changing every second doubles as a JS-alive heartbeat —
 *  if this line freezes, the whole WebView is suspended. */
function finderDebugLine(mode: string): string {
  const t = finderTelem;
  if (!t) return "no watch";
  const age = t.lastFixAt
    ? `${Math.max(0, Math.round((Date.now() - t.lastFixAt) / 1000))}s`
    : "–";
  const rejected = t.rawFixes - t.usableFixes;
  // Socket glyphs: ✓ open, … connecting, ✗ closed/stopped; the count after
  // ✗ is reconnect attempts (the drop count, i.e. how flaky the link is).
  const s = socketTelem;
  const ws = !s
    ? ""
    : ` · ws${s.state === "open" ? "✓" : s.state === "connecting" ? "…" : "✗"}${
        s.reconnects ? s.reconnects : ""
      }`;
  return (
    `fx ${t.rawFixes}${rejected ? `(-${rejected})` : ""} ${age}` +
    ` · rp ${finderRenders.done}/${finderRenders.started}` +
    ` · rs ${t.restarts}+${t.resumes}` +
    ws +
    ` · ${mode}` +
    (t.lastProblem ? ` !${t.lastProblem}` : "")
  );
}

async function renderFinder() {
  if (backgrounded || view !== "finder") return;
  // Entered before the car reported a position, and a later poll has now
  // supplied one: this is the point where asking for GPS finally makes sense.
  if (carPosition() && !finderWatch && finderTick) startFinderWatch();
  finderRenders.started++;
  const { arrived, octant, mode, stale, content } = finderContent();
  // Ring shows for every located state (walking arrow, stationary/arrived/
  // locating ring-only); problem and crash states clear the image entirely.
  await directionIndicator.update(octant, {
    ring: mode !== "problem" && mode !== "crash",
    dim: stale,
  });
  if (content.main !== finderShown?.main) {
    await upgradeText(FINDER_MAIN_CONTAINER, content.main);
  }
  if (content.foot !== finderShown?.foot) {
    await upgradeText(FINDER_FOOT_CONTAINER, content.foot);
  }
  finderShown = content;
  if (FINDER_DEBUG) {
    const line = finderDebugLine(mode);
    if (line !== finderDebugShown) {
      finderDebugShown = line;
      await upgradeText(FINDER_DEBUG_CONTAINER, line);
    }
  }
  finderRenders.done++;

  // Arrival ends the feature: the job is done, so the watcher stops right
  // here (not on the way out) and the screen holds briefly before returning
  // to the HUD. No other state has a timeout — nothing yanks the user back
  // mid-walk.
  if (arrived) {
    stopFinderWatch("arrived");
    finderArrival = setTimeout(() => {
      finderArrival = null;
      if (view === "finder" && !backgrounded) void showHud();
    }, ARRIVAL_HOLD_MS);
  }
}

/** The one place the GPS watch and its timers are torn down. Every exit path
 *  — finder exit, arrival, foreground exit, system exit — calls this, and the
 *  watch logs a line when it stops (handoff §4.6). The keepalive socket
 *  follows the same discipline, except across watch restarts (reason
 *  "restart"): tearing a healthy socket down to replace a GPS watch would
 *  sabotage the very keep-alive behaviour the socket exists to test. */
function stopFinderWatch(reason: string) {
  if (finderWatch) {
    finderWatch.stop(reason);
    finderWatch = null;
  }
  if (finderTick) clearInterval(finderTick);
  finderTick = null;
  if (finderArrival) clearTimeout(finderArrival);
  finderArrival = null;
  if (reason !== "restart" && finderSocket) {
    finderSocket.stop(reason);
    finderSocket = null;
  }
}

function startFinderWatch() {
  stopFinderWatch("restart");
  // The 1 Hz repaint runs regardless: it is what lets the course go stale,
  // what notices a car position arriving on a later poll — and now what rides
  // the stall watchdog, so a watch that died without an error gets replaced.
  finderTick = setInterval(() => {
    finderWatch?.poke(Date.now());
    void renderFinder();
  }, FINDER_TICK_MS);
  // The keepalive socket spans the whole finder session (see stopFinderWatch)
  // and reopens here after a foreground/screen-wake re-entry. Telemetry
  // accumulates across reopens within the session.
  if (FINDER_KEEPALIVE_SOCKET && !finderSocket) {
    socketTelem ??= createSocketTelemetry();
    finderSocket = openKeepaliveSocket(KEEPALIVE_WS_URL, socketTelem);
  }
  // No car position ⇒ nothing to compute a bearing to, so don't ask for the
  // location permission at all. Prompting for a sensor we can't use yet is a
  // bad trade; the screen already explains what's missing, and the tick above
  // starts the watch the moment coordinates turn up.
  if (!carPosition()) return;
  finderTelem ??= createFinderTelemetry(Date.now());
  // The vague-fix filter lives inside createFinderWatch, where a rejection is
  // a counted event instead of an invisible return.
  finderWatch = createFinderWatch(
    {
      onFix(fix) {
        finderProblem = null;
        finderFix = fix;
        finderCourse.push(fix);
        void renderFinder();
      },
      onProblem(problem) {
        finderProblem = problem;
        void renderFinder();
      },
    },
    carPosition(),
    finderTelem,
  );
}

// Phone screen coming back. FOREGROUND_* events cover the glasses dashboard;
// they say nothing about the phone's own screen — and a locked phone can
// suspend the WebView's geolocation (or all of its JS). The 1.3.0 hardware
// walk froze exactly this way: one fix at entry, nothing after pocketing the
// phone. A suspended watch may never deliver again after resume, so a fresh
// one is the only guarantee; the tick/watchdog stay as the belt to this brace.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (backgrounded || view !== "finder" || !finderTick) return;
  if (finderTelem) finderTelem.resumes++;
  // The honest guidance, at the exact moment it's true: the finder just lost
  // (at least) a screen-lock's worth of updates. Shown briefly, then the
  // normal detail line returns.
  finderNoteUntil = Date.now() + FINDER_NOTE_MS;
  console.log("finder: page visible again — replacing GPS watch");
  startFinderWatch();
  void renderFinder();
});

async function enterFinder() {
  view = "finder";
  finderFix = null;
  finderProblem = null;
  finderOctant = null;
  finderShown = null;
  finderDebugShown = null;
  finderNoteUntil = 0;
  // Fresh telemetry per session; kept after exit so the diagnostic report can
  // describe the walk that just failed.
  finderTelem = createFinderTelemetry(Date.now());
  socketTelem = FINDER_KEEPALIVE_SOCKET ? createSocketTelemetry() : null;
  finderRenders = { started: 0, done: 0 };
  finderCourse.reset();
  // Pre-render the arrow frames before the page goes up: a one-off ~tens of
  // ms on entry, so the first direction push has frames to draw from.
  directionIndicator.prepare?.();
  directionIndicator.reset();
  // Paint the first frame ("Locating…", or the explanation if the car never
  // reported a position) before asking for GPS — the permission prompt can
  // take seconds and the glasses must not sit blank behind it.
  const { content } = finderContent();
  finderShown = content;
  await enqueue(() =>
    bridge.rebuildPageContainer(new RebuildPageContainer(finderPage(content))),
  );
  startFinderWatch();
}

function exitFinder() {
  stopFinderWatch("finder exit");
  return showHud();
}

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
      // A fresh status can carry a newer car position; the finder recomputes
      // from lastStatus on every render, so there is nothing else to do.
      await renderFinder();
    } else if (view === "hud") {
      await updateHud(note);
    } else if (sameMenu(buildMenuItems(lastStatus, settings), menuItems)) {
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
  await showMenu();
  await pollStatus();
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
    // Protobuf drops zero-value fields: CLICK_EVENT (0) and item index 0
    // arrive as undefined, so coalesce with ?? 0 — but only when the
    // envelope itself is present.
    const sysType = event.sysEvent ? (event.sysEvent.eventType ?? 0) : null;
    const textType = event.textEvent ? (event.textEvent.eventType ?? 0) : null;
    const listIndex = event.listEvent
      ? (event.listEvent.currentSelectItemIndex ?? 0)
      : null;

    // Double-tap: HUD (hidden or not) → open the actions menu (the standard
    // gesture across Even Hub apps; the menu's Quit item and its double-tap
    // both reach the system exit dialog). Everywhere else — unconfigured,
    // connecting, failed, menu — the system "close app?" Yes/No dialog.
    // Cleanup happens on SYSTEM_EXIT/ABNORMAL_EXIT, not here — the user can
    // still cancel the dialog. (The simulator does not render the dialog and
    // just blanks the panel; hardware shows Yes/No.)
    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      // Debounce: without it, HUD→menu can immediately chain into
      // menu→close-app.
      const now = Date.now();
      if (now - lastDoubleClickAt < 800) return;
      lastDoubleClickAt = now;
      if (view === "hud") {
        void openMenu();
      } else {
        void bridge.shutDownPageContainer(1);
      }
      return;
    }

    if (
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      if (repollTimer) clearTimeout(repollTimer);
      stopSpinner();
      clearNoteTimer();
      // The app is going away with the GPS watch possibly still running —
      // this is the path that would otherwise leak it into the user's pocket.
      stopFinderWatch("system exit");
      unsubscribe();
      return;
    }

    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      backgrounded = false;
      if (view === "finder") {
        // The watch was stopped on the way out; resume it and repaint from
        // whatever the last status said.
        startFinderWatch();
        void renderFinder();
      } else if (view === "connect") {
        // Restart the attempt outright: a fetch suspended mid-flight may never
        // settle, and the old attempt was invalidated on FOREGROUND_EXIT — a
        // resume must never leave an indefinite spinner. (Unconfigured just
        // re-renders the not-configured message.)
        void connectToBackend();
      } else {
        void pollStatus();
      }
      return;
    }

    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      // Backgrounded: stop driving the display and the network — no container
      // upgrades, no polls. Everything resumes via FOREGROUND_ENTER (immediate
      // re-poll / connect restart). Settings are written on Save and are
      // already durable, so there is nothing else to flush.
      backgrounded = true;
      connectGen++;
      stopSpinner();
      if (repollTimer) clearTimeout(repollTimer);
      repollTimer = null;
      clearNoteTimer();
      // GPS is the expensive one: a watch left running while the phone is in
      // a pocket is a battery complaint. FOREGROUND_ENTER restarts it.
      stopFinderWatch("foreground exit");
      return;
    }

    // Menu: the firmware scrolls the list natively; a single tap reports the
    // selected item. R1 ring gestures arrive through the same events.
    if (listIndex !== null && view === "menu") {
      void selectMenuItem(listIndex);
      return;
    }

    // Connect page: single tap retries after a failure (double-tap is exit).
    // Mid-connect and unconfigured taps do nothing — there's nothing to retry.
    if (
      view === "connect" &&
      (sysType === OsEventTypeList.CLICK_EVENT ||
        textType === OsEventTypeList.CLICK_EVENT)
    ) {
      if (client && connectState === "failed") void connectToBackend();
      return;
    }

    // Finder: single tap goes back to the HUD (and stops the GPS watch).
    // Double-tap is the system exit dialog, handled above with everywhere
    // else that isn't the HUD.
    if (
      view === "finder" &&
      (sysType === OsEventTypeList.CLICK_EVENT ||
        textType === OsEventTypeList.CLICK_EVENT)
    ) {
      void exitFinder();
      return;
    }

    // HUD: single tap toggles "glasses off" (hide/show everything).
    // Double-tap opens the menu from either state, handled above. Swipes
    // do nothing.
    if (
      view === "hud" &&
      (sysType === OsEventTypeList.CLICK_EVENT ||
        textType === OsEventTypeList.CLICK_EVENT)
    ) {
      void toggleHudHidden();
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

  // The unit currently on screen. `climateTemp` is Celsius no matter what
  // this says — only the input, its bounds and the label follow it.
  let tempUnit: TempUnit = resolveTempUnit(settings);
  // Once the user picks a unit themselves we stop inferring it from the
  // region, so choosing Celsius in the US survives a later region edit.
  let tempUnitExplicit = settings.tempUnit != null;

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
    tempLabelEl.textContent = field.label;
  }

  tempUnitEl.addEventListener("change", () => {
    tempUnitExplicit = true;
    applyTempUnit(tempUnitEl.value as TempUnit, tempUnit);
  });

  for (const region of REGIONS) {
    regionEl.add(new Option(region.label, String(region.code)));
  }
  for (const el of [acEl, dcEl]) {
    for (let pct = 50; pct <= 100; pct += 10) {
      el.add(new Option(`${pct}%`, String(pct)));
    }
  }

  // First run: walk the user through setup. Once configured, collapse it.
  guideEl.open = !isConfigured(settings);
  usernameEl.value = settings.username;
  passwordEl.value = settings.password;
  pinEl.value = settings.pin;
  regionEl.value = String(settings.region);
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
    setStatus(
      testStatus,
      "Testing… (the first sign-in can take up to a minute)",
    );
    try {
      try {
        await probe.healthz(15_000);
      } catch {
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
        setStatus(
          testStatus,
          `Connected. Car responded (${figure}).` +
            (saved ? " Details saved." : " Auto-save failed — tap Save."),
          !saved,
        );
      } catch (err) {
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
    }
  });

  // -- Kia-US device enrollment ---------------------------------------------
  const enrollSection = document.getElementById("enroll-section")!;
  const enrollStartArea = document.getElementById("enroll-start-area")!;
  const enrollVerifyArea = document.getElementById("enroll-verify-area")!;
  const enrollNotifyType = document.getElementById("enroll-notify-type") as HTMLSelectElement;
  const enrollStartBtn = document.getElementById("enroll-start-btn") as HTMLButtonElement;
  const enrollCodeEl = document.getElementById("enroll-code") as HTMLInputElement;
  const enrollVerifyBtn = document.getElementById("enroll-verify-btn") as HTMLButtonElement;
  const enrollStatus = document.getElementById("enroll-status") as HTMLParagraphElement;

  function needsEnrollment(): boolean {
    return IS_KIA_US && Number(regionEl.value) === 3;
  }

  function showEnrollSection() {
    if (needsEnrollment()) enrollSection.style.display = "";
  }

  function hideEnrollSection() {
    enrollSection.style.display = "none";
    enrollVerifyArea.style.display = "none";
    enrollCodeEl.value = "";
    setStatus(enrollStatus, "");
  }

  // Selecting USA switches the display to Fahrenheit (and back out of it),
  // but only while the user hasn't overridden the unit themselves.
  regionEl.addEventListener("change", () => {
    if (tempUnitExplicit) return;
    const inferred: TempUnit = Number(regionEl.value) === 3 ? "F" : "C";
    if (inferred !== tempUnit) applyTempUnit(inferred, tempUnit);
  });

  // Show/hide on region change — enrollment is only for Kia + US.
  regionEl.addEventListener("change", () => {
    if (needsEnrollment()) {
      // Show only if we don't already have a token stored
      if (!settings.kiaUsDeviceToken) showEnrollSection();
      else hideEnrollSection();
    } else {
      hideEnrollSection();
    }
  });

  // Show enrollment on load if Kia-US and not yet enrolled.
  if (needsEnrollment() && !settings.kiaUsDeviceToken) {
    showEnrollSection();
  }

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
    setStatus(enrollStatus, "");
  });

  // -- Diagnostics ------------------------------------------------------------
  const diagBtn = document.getElementById("diag-btn") as HTMLButtonElement;
  const diagStatus = document.getElementById(
    "diag-status",
  ) as HTMLParagraphElement;

  diagBtn.addEventListener("click", async () => {
    diagBtn.disabled = true;
    setStatus(diagStatus, "Building report…");

    const regionName =
      REGIONS.find((r) => r.code === Number(regionEl.value))?.label ??
      regionEl.value;

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
        finderTelem
          ? `fixes ${finderTelem.rawFixes} raw / ${finderTelem.usableFixes} usable` +
            `${finderTelem.lastRejectedAccuracy != null ? ` (last reject ±${Math.round(finderTelem.lastRejectedAccuracy)}m)` : ""}` +
            `, last fix ${finderTelem.lastFixAt ? `${Math.round((Date.now() - finderTelem.lastFixAt) / 1000)}s ago` : "never"}` +
            `, problems ${finderTelem.problems}${finderTelem.lastProblem ? ` (${finderTelem.lastProblem})` : ""}` +
            `, restarts ${finderTelem.restarts} watchdog / ${finderTelem.resumes} screen-wake` +
            `, repaints ${finderRenders.done}/${finderRenders.started}`
          : "not opened this session"
      }`,
      // The keepalive-socket spike, summarised: did the socket hold, and did
      // holding it change what the fixes did (compare with the line above).
      `Keepalive: ${
        socketTelem
          ? `${socketTelem.state}, opens ${socketTelem.opens}, drops ${socketTelem.reconnects}` +
            `${socketTelem.lastCloseCode != null ? ` (last close ${socketTelem.lastCloseCode})` : ""}`
          : "off"
      }`,
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

  limitsBtn.addEventListener("click", async () => {
    const limitsClient = formClient();
    if (!limitsClient) {
      setStatus(limitsStatus, "Enter your account details first.", true);
      return;
    }
    limitsBtn.disabled = true;
    setStatus(limitsStatus, "Sending…");
    try {
      await limitsClient.setChargeLimits(Number(acEl.value), Number(dcEl.value));
      setStatus(limitsStatus, "Limits sent. The car applies them in 30–90 s.");
    } catch (err) {
      recordError("charge-limits", err);
      setStatus(limitsStatus, describeError(err), true);
    } finally {
      limitsBtn.disabled = false;
    }
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
      // The powertrain memory belongs to the car, not the form — carry it
      // across saves.
      lastPowertrain: settings.lastPowertrain,
      lastPowertrainFuelOnly: settings.lastPowertrainFuelOnly,
    };
    rebuildClient();
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

  saveBtn.addEventListener("click", async () => {
    const ok = await persistForm();
    setStatus(saveStatus, ok ? "Saved." : "Save failed. Try again.", !ok);
  });
}

// ---------------------------------------------------------------------------
// Boot. Order matters: the first frame goes to the glasses before anything
// else — in particular before the settings read, which must never sit
// between launch and first paint (black-frame risk on a slow storage read).

const createResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(connectPage(CONNECTING_TEXT, spinnerFrame(0))),
);
if (createResult !== 0) {
  // No startup page means nothing can ever render — every later call would
  // drive containers that don't exist. Exit cleanly instead of continuing.
  console.error(`Startup page creation failed (${createResult}) — exiting`);
  void bridge.shutDownPageContainer(0);
} else {
  settings = await loadSettings(bridge);
  // Dev-server-only (never in a production build: DEV guard): fake
  // credentials so the simulator can reach the HUD against a mock proxy
  // (VITE_BACKEND_URL). The mock ignores credentials entirely.
  if (import.meta.env.DEV && import.meta.env.VITE_FAKE_CREDS) {
    settings = { ...settings, username: "simulator", password: "simulator" };
  }
  rebuildClient();
  subscribeEvents();
  void connectToBackend();
  bindPhoneUi();
}
