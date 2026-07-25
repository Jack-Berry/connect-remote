import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from "@evenrealities/even_hub_sdk";

import {
  ARROW_CANDIDATES,
  ARROW_FALLBACKS,
  type GlyphResult,
  type ProbeState,
  type Verdict,
  checkGlyphs,
  fmtCoord,
  fmtTriple,
  glassesSummary,
  initialState,
} from "./probe";
import {
  ENCODINGS,
  type Encoding,
  FRAME_SIZE,
  type Frame,
  PushStats,
  buildFrames,
} from "./imagespike";
import { startGeolocation, startMotion, startOrientation } from "./sensors";

const bridge = await waitForEvenAppBridge();

const state: ProbeState = initialState();
const arrows: GlyphResult[] = checkGlyphs(ARROW_CANDIDATES);
const fallbacks: GlyphResult[] = checkGlyphs(ARROW_FALLBACKS);

let stopGeo: () => void = () => {};
let stopOri: () => void = () => {};
let stopMot: () => void = () => {};
let backgrounded = false;
let lastDoubleClickAt = 0;

// ---------------------------------------------------------------------------
// Bridge plumbing. Same discipline as the main app: concurrent bridge calls
// can crash the BLE link, so everything goes through one chain.

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const PROBE_CONTAINER = { containerID: 2, containerName: "probe" };
const EVENT_LAYER = { containerID: 1, containerName: "events" };

function probePage(content: string) {
  return {
    containerTotalNum: 2,
    textObject: [
      // Invisible full-screen capture layer so taps reach us at all.
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        ...EVENT_LAYER,
        content: " ",
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 6,
        ...PROBE_CONTAINER,
        content,
        isEventCapture: 0,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Image-container spike (see imagespike.ts for what it's answering).
//
// A separate page: one 144x144 image container plus a text container for the
// running log, so the timing numbers are readable on the glasses without
// looking at the phone. Entering rebuilds the page once — after that, every
// frame goes through updateImageRawData alone, which is precisely the
// behaviour under test.

const IMG_CONTAINER = { containerID: 3, containerName: "spikeimg" };
const IMG_LOG_CONTAINER = { containerID: 4, containerName: "spikelog" };

let imageMode = false;
let frames: Frame[] = [];
let frameIndex = 0;
let encodingIndex = 0;
let autoCycle: ReturnType<typeof setInterval> | null = null;
let pushing = false;
const stats = new PushStats();
const spikeLog: string[] = [];

function encoding(): Encoding {
  return ENCODINGS[encodingIndex];
}

function logSpike(line: string) {
  spikeLog.unshift(line);
  spikeLog.length = Math.min(spikeLog.length, 6);
  console.log(`spike: ${line}`);
  const out = document.getElementById("spike-log");
  if (out) out.textContent = spikeLog.join("\n");
  void upgradeSpikeLog();
}

function upgradeSpikeLog() {
  if (!imageMode || backgrounded) return Promise.resolve();
  return enqueue(() =>
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        ...IMG_LOG_CONTAINER,
        content: [
          `enc: ${encoding().id}`,
          stats.summary(),
          ...spikeLog.slice(0, 3),
        ].join("\n"),
        contentOffset: 0,
        contentLength: 0,
      }),
    ),
  );
}

function spikePage() {
  return {
    containerTotalNum: 3,
    imageObject: [
      new ImageContainerProperty({
        // Left of centre, with the log beside it — both need to be readable
        // at the same time to judge "did the swap flash?" against "how long
        // did it take?".
        xPosition: 40,
        yPosition: 72,
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        ...IMG_CONTAINER,
      }),
    ],
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        ...EVENT_LAYER,
        content: " ",
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 220,
        yPosition: 72,
        width: 350,
        height: 160,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 6,
        ...IMG_LOG_CONTAINER,
        content: "image spike ready",
        isEventCapture: 0,
      }),
    ],
  };
}

/**
 * Push one frame and time the round trip.
 *
 * Strictly serial: the SDK is explicit that image transmissions must not
 * overlap, and a queue-jumping push is the fastest way to get numbers that
 * mean nothing (or to crash the BLE link).
 */
async function pushFrame(frame: Frame): Promise<void> {
  if (pushing || !imageMode || backgrounded) return;
  pushing = true;
  const payload = encoding().build(frame.canvas);
  const size = typeof payload === "string" ? payload.length : payload.length;
  const started = performance.now();
  try {
    const result = await enqueue(() =>
      bridge.updateImageRawData(
        new ImageRawDataUpdate({ ...IMG_CONTAINER, imageData: payload }),
      ),
    );
    const ms = Math.round(performance.now() - started);
    stats.add({ ms, size, ok: true, detail: JSON.stringify(result) });
    // The host can accept the call and still reject the bytes, so the result
    // value matters as much as the absence of a throw.
    logSpike(`${encoding().id} ${frame.label} → ${ms}ms (${size}) ${JSON.stringify(result)}`);
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    stats.add({ ms, size, ok: false, detail: String(err) });
    logSpike(`${encoding().id} ${frame.label} FAILED after ${ms}ms: ${err}`);
  } finally {
    pushing = false;
  }
}

async function enterImageMode() {
  if (!frames.length) {
    const t0 = performance.now();
    frames = buildFrames();
    logSpike(
      `rendered ${frames.length} frames on canvas in ${Math.round(performance.now() - t0)}ms`,
    );
  }
  stopPump(); // the sensor page's text pump would fight for the same link
  imageMode = true;
  frameIndex = 0;
  await enqueue(() =>
    bridge.rebuildPageContainer(new RebuildPageContainer(spikePage())),
  );
  logSpike("entered image mode — page rebuilt ONCE; pushes follow");
  // The container is a placeholder until the first push, so seed it.
  await pushFrame(frames[0]);
}

async function nextFrame() {
  if (!imageMode) return;
  frameIndex = (frameIndex + 1) % frames.length;
  await pushFrame(frames[frameIndex]);
}

function stopAutoCycle() {
  if (autoCycle) clearInterval(autoCycle);
  autoCycle = null;
}

async function exitImageMode() {
  stopAutoCycle();
  imageMode = false;
  console.log(`spike: FINAL ${stats.summary()}`);
  await enqueue(() =>
    bridge.rebuildPageContainer(new RebuildPageContainer(probePage("returning…"))),
  );
  pending = true;
  startPump();
}

// Latest-wins render pump. Orientation events arrive at ~60Hz; the panel
// sustains 4-8fps. Pushing every event would saturate the link and starve the
// numbers we are trying to read, so state accumulates and the pump renders
// the latest snapshot twice a second.
const RENDER_INTERVAL_MS = 500;
let pending = false;
let rendering = false;
let renderTimer: ReturnType<typeof setInterval> | null = null;

async function renderGlasses() {
  // The spike owns the panel while it runs — a sensor text upgrade aimed at a
  // container that isn't on the page would both fail and muddy the timings.
  if (rendering || backgrounded || imageMode) return;
  rendering = true;
  try {
    const text = glassesSummary(state, arrows).join("\n");
    mirrorEl.textContent = text;
    await enqueue(() =>
      bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          ...PROBE_CONTAINER,
          content: text,
          contentOffset: 0,
          contentLength: 0,
        }),
      ),
    );
  } catch (err) {
    // A failed panel update must never take the probe down — the phone page
    // is still a complete record of the run.
    console.error("glasses render failed", err);
  } finally {
    rendering = false;
  }
}

function startPump() {
  if (renderTimer) return;
  renderTimer = setInterval(() => {
    if (!pending) return;
    pending = false;
    void renderGlasses();
  }, RENDER_INTERVAL_MS);
}

function stopPump() {
  if (renderTimer) clearInterval(renderTimer);
  renderTimer = null;
}

// Called by every sensor callback. Cheap: flags the pump and refreshes the
// phone DOM, which is the high-detail record.
function onChange() {
  pending = true;
  renderPhone();
}

// ---------------------------------------------------------------------------
// Phone page

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

const mirrorEl = el("mirror");

function setVerdict(id: string, v: Verdict) {
  const node = el(id);
  node.textContent = v;
  node.className =
    "verdict " +
    (v === "OK"
      ? "ok"
      : v === "DENIED" || v === "NOT-SUPPORTED" || v === "ERROR"
        ? "bad"
        : v === "NO-PROMPT" || v === "NO-EVENTS"
          ? "warn"
          : "");
}

function renderPhone() {
  const g = state.geo;
  const o = state.orientation;
  const m = state.motion;

  setVerdict("geo-verdict", g.verdict);
  el("geo-detail").textContent = g.detail;
  el("geo-values").textContent = [
    `lat/lon      ${fmtCoord(g.latitude)}, ${fmtCoord(g.longitude)}`,
    `accuracy     ${g.accuracy === null ? "—" : g.accuracy.toFixed(1) + " m"}`,
    `altitude     ${g.altitude === null ? "—" : g.altitude.toFixed(1) + " m"} (±${g.altitudeAccuracy === null ? "—" : g.altitudeAccuracy.toFixed(1)})`,
    `gps heading  ${g.heading === null ? "— (null: stationary or unsupported)" : g.heading.toFixed(1) + "°"}`,
    `gps speed    ${g.speed === null ? "— (null: stationary or unsupported)" : g.speed.toFixed(2) + " m/s"}`,
    `fixes        ${g.fixes}`,
    `first fix    ${g.firstFixMs === null ? "—" : g.firstFixMs + " ms"}`,
    `since last   ${g.gapMs === null ? "—" : g.gapMs + " ms"}`,
  ].join("\n");

  setVerdict("ori-verdict", o.verdict);
  setVerdict("mot-verdict", m.verdict);
  el("ori-detail").textContent = `compass: ${o.detail}`;
  el("mot-detail").textContent = `motion: ${m.detail}`;
  el("mot-values").textContent = [
    "— DeviceOrientationEvent —",
    `permission     ${o.permission ?? "—"} (settled in ${o.requestMs === null ? "—" : o.requestMs + " ms"})`,
    `events / rate  ${o.events} @ ${o.hz === null ? "—" : o.hz.toFixed(1) + " Hz"}`,
    `compass field  ${o.hasCompassField ? "present" : "ABSENT on the event object"}`,
    `compassHeading ${o.compassHeading === null ? "—" : o.compassHeading.toFixed(1) + "°"}`,
    `compassAccur.  ${o.compassAccuracy === null ? "—" : o.compassAccuracy.toFixed(1)}`,
    `absolute       ${o.absolute === null ? "—" : String(o.absolute)}`,
    `alpha/beta/gam ${fmtTriple(o.alpha, o.beta, o.gamma, 1)}`,
    "",
    "— DeviceMotionEvent —",
    `permission     ${m.permission ?? "—"} (settled in ${m.requestMs === null ? "—" : m.requestMs + " ms"})`,
    `events / rate  ${m.events} @ ${m.hz === null ? "—" : m.hz.toFixed(1) + " Hz"} (interval ${m.interval === null ? "—" : m.interval + " ms"})`,
    `acceleration   ${fmtTriple(m.ax, m.ay, m.az, 3)}`,
    ` + gravity     ${fmtTriple(m.gx, m.gy, m.gz, 3)}`,
    `rotationRate   ${fmtTriple(m.rateAlpha, m.rateBeta, m.rateGamma, 2)}`,
  ].join("\n");
}

function renderStatic() {
  const nav = navigator as Navigator & { standalone?: boolean };
  el("env").textContent = [
    `userAgent     ${nav.userAgent}`,
    `geolocation   ${"geolocation" in navigator ? "present" : "ABSENT"}`,
    `DeviceOrient. ${typeof (globalThis as Record<string, unknown>).DeviceOrientationEvent === "undefined" ? "ABSENT" : "present"}`,
    `  .requestPermission ${typeof (globalThis as { DeviceOrientationEvent?: { requestPermission?: unknown } }).DeviceOrientationEvent?.requestPermission}`,
    `DeviceMotion  ${typeof (globalThis as Record<string, unknown>).DeviceMotionEvent === "undefined" ? "ABSENT" : "present"}`,
    `  .requestPermission ${typeof (globalThis as { DeviceMotionEvent?: { requestPermission?: unknown } }).DeviceMotionEvent?.requestPermission}`,
    `secureContext ${String(globalThis.isSecureContext)}`,
    `origin        ${location.origin}`,
  ].join("\n");

  const present = arrows.filter((a) => a.present);
  const row = el("glyph-row");
  row.textContent = present.length
    ? present.map((a) => a.char).join("")
    : "none of the candidates exist";
  if (!present.length) row.className = "glyphs missing";

  const line = (r: GlyphResult) =>
    `${r.char}  ${r.codepoint}  advW=${String(r.advance).padStart(4)}  ${r.present ? "PRESENT" : "MISSING"}`;
  el("glyph-table").textContent = [
    `candidates: ${present.length}/${arrows.length} present`,
    ...arrows.map(line),
    "",
    "fallback shapes (if the candidates were missing):",
    ...fallbacks.map(line),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Buttons. The motion request MUST stay inside this click handler — iOS
// rejects requestPermission() called from anywhere else, which would look
// exactly like a platform denial and produce a false probe result.

function bindButtons() {
  const geoBtn = el("geo-btn") as HTMLButtonElement;
  const geoStop = el("geo-stop") as HTMLButtonElement;
  const motBtn = el("mot-btn") as HTMLButtonElement;
  const motStop = el("mot-stop") as HTMLButtonElement;

  geoBtn.addEventListener("click", () => {
    stopGeo();
    stopGeo = startGeolocation(state, onChange);
    geoBtn.disabled = true;
    geoStop.disabled = false;
  });

  geoStop.addEventListener("click", () => {
    stopGeo();
    stopGeo = () => {};
    state.geo.detail = `stopped by user after ${state.geo.fixes} fixes`;
    geoBtn.disabled = false;
    geoStop.disabled = true;
    onChange();
  });

  motBtn.addEventListener("click", () => {
    motBtn.disabled = true;
    motStop.disabled = false;
    stopOri();
    stopMot();
    // Both requests fire from this same gesture. Awaiting the first before
    // starting the second is fine on iOS — the gesture token covers the
    // handler, and stacking two dialogs at once is what the finder will do
    // in production anyway.
    void (async () => {
      stopOri = await startOrientation(state, onChange);
      stopMot = await startMotion(state, onChange);
      onChange();
    })();
  });

  motStop.addEventListener("click", () => {
    stopOri();
    stopMot();
    stopOri = () => {};
    stopMot = () => {};
    state.orientation.detail = `stopped by user after ${state.orientation.events} events`;
    state.motion.detail = `stopped by user after ${state.motion.events} events`;
    motBtn.disabled = false;
    motStop.disabled = true;
    onChange();
  });

  // -- Image container spike ------------------------------------------------
  const spikeEnter = el("spike-enter") as HTMLButtonElement;
  const spikeNext = el("spike-next") as HTMLButtonElement;
  const spikeAuto = el("spike-auto") as HTMLButtonElement;
  const spikePack = el("spike-pack") as HTMLButtonElement;
  const spikeExit = el("spike-exit") as HTMLButtonElement;
  const spikeStats = el("spike-stats");

  function refreshSpikeUi() {
    spikeEnter.disabled = imageMode;
    for (const b of [spikeNext, spikeAuto, spikePack, spikeExit]) {
      b.disabled = !imageMode;
    }
    spikeAuto.textContent = autoCycle ? "Stop auto-cycle" : "Auto-cycle 1s";
    spikePack.textContent = `Encoding: ${encoding().id}`;
    spikeStats.textContent = stats.count
      ? stats.summary()
      : imageMode
        ? "in image mode — push a frame"
        : "not started";
  }

  spikeEnter.addEventListener("click", async () => {
    spikeEnter.disabled = true;
    await enterImageMode();
    refreshSpikeUi();
  });

  spikeNext.addEventListener("click", async () => {
    await nextFrame();
    refreshSpikeUi();
  });

  spikeAuto.addEventListener("click", () => {
    if (autoCycle) {
      stopAutoCycle();
    } else {
      // 1s is well inside the panel's budget and matches how the finder would
      // actually use this — direction changes are seconds apart while walking,
      // so throughput was never the binding constraint. Flash is.
      autoCycle = setInterval(() => {
        void nextFrame().then(refreshSpikeUi);
      }, 1000);
    }
    refreshSpikeUi();
  });

  spikePack.addEventListener("click", async () => {
    encodingIndex = (encodingIndex + 1) % ENCODINGS.length;
    stats.reset();
    logSpike(`encoding → ${encoding().label}`);
    await pushFrame(frames[frameIndex]);
    refreshSpikeUi();
  });

  spikeExit.addEventListener("click", async () => {
    await exitImageMode();
    refreshSpikeUi();
  });

  refreshSpikeUi();
}

// ---------------------------------------------------------------------------
// Glasses events

function stopAllSensors() {
  stopGeo();
  stopOri();
  stopMot();
  stopGeo = () => {};
  stopOri = () => {};
  stopMot = () => {};
}

let unsubscribe: () => void = () => {};

function subscribeEvents() {
  unsubscribe = bridge.onEvenHubEvent((event) => {
    // Protobuf drops zero-value fields, so CLICK_EVENT (0) arrives as
    // undefined — coalesce only when the envelope itself is present.
    const sysType = event.sysEvent ? (event.sysEvent.eventType ?? 0) : null;
    const textType = event.textEvent ? (event.textEvent.eventType ?? 0) : null;

    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      const now = Date.now();
      if (now - lastDoubleClickAt < 800) return;
      lastDoubleClickAt = now;
      // In the image spike a double-tap leaves the spike rather than the app,
      // so the owner can get back to the sensor page one-handed while walking.
      if (imageMode) {
        void exitImageMode();
        return;
      }
      // Straight to the system exit dialog — the probe has no menu layer.
      // Cleanup waits for SYSTEM_EXIT: the user can still cancel.
      void bridge.shutDownPageContainer(1);
      return;
    }

    // Single tap in the spike advances the frame, so flash/no-flash can be
    // judged on the glasses without reaching for the phone.
    if (
      imageMode &&
      (sysType === OsEventTypeList.CLICK_EVENT ||
        textType === OsEventTypeList.CLICK_EVENT)
    ) {
      void nextFrame();
      return;
    }

    if (
      sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
      sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      // The whole point of the exit path: no watcher outlives the app.
      stopAllSensors();
      stopAutoCycle();
      stopPump();
      unsubscribe();
      return;
    }

    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      // Backgrounded: the page is not on the glasses, so nothing may render.
      // Sensors keep running deliberately — "do fixes keep arriving while
      // backgrounded?" is itself useful for the finder, and the counters
      // will show it on return. The finder itself will stop them.
      backgrounded = true;
      return;
    }

    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      backgrounded = false;
      pending = true;
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Boot. First frame to the glasses before anything else — a slow start must
// never show a black panel.

const createResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(
    probePage(
      [
        "SENSOR PROBE ready",
        // Rendered by the firmware itself, before any button is pressed: if a
        // glyph is missing here it silently vanishes, and the gap in this row
        // is the answer to the arrow question on real hardware.
        `arrows: ${arrows.map((a) => a.char).join(" ")}`,
        "",
        "Use the phone page:",
        "1 start geolocation",
        "2 request motion+compass",
        "Double-tap to exit",
      ].join("\n"),
    ),
  ),
);

if (createResult !== 0) {
  console.error(`Startup page creation failed (${createResult}) — exiting`);
  void bridge.shutDownPageContainer(0);
} else {
  subscribeEvents();
  renderStatic();
  renderPhone();
  bindButtons();
  startPump();
  // ?spike=1 jumps straight into the image spike. The phone buttons are the
  // normal route; this exists because the simulator's automation API can only
  // drive the glasses, not the phone page — and because it's one less tap
  // when re-running the spike on hardware.
  if (new URLSearchParams(location.search).has("spike")) {
    void enterImageMode();
  }
}
