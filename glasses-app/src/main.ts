import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
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
  TimeoutError,
  type VehicleStatus,
} from "./api";
import { BRAND, applyBrand } from "./brand";
import {
  CONNECTING_TEXT,
  CONNECT_CONTAINER,
  CONNECT_SPIN_CONTAINER,
  CONNECT_SPIN_W,
  CONNECT_SPIN_X,
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
  formatHudBottom,
  formatHudRow,
  formatMenuInfo,
  sameMenu,
  spinnerFrame,
} from "./display";
import {
  type AppSettings,
  type Bridge,
  DEFAULT_SETTINGS,
  REGIONS,
  isConfigured,
  loadSettings,
  saveSettings,
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
let view: "connect" | "hud" | "menu" = "connect";
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
        content: hudHidden ? " " : formatHudRow(lastStatus),
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
        content: hudHidden ? " " : formatHudBottom(lastStatus, note),
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
    hudHidden ? " " : formatHudRow(lastStatus),
  );
  await upgradeText(
    HUD_NOTE_CONTAINER,
    hudHidden ? " " : formatHudBottom(lastStatus, note),
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
  menuItems = buildMenuItems(lastStatus, settings);
  return enqueue(() =>
    bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        listObject: [menuListContainer(menuItems)],
        textObject: [menuInfoContainer(formatMenuInfo(lastStatus, note))],
      }),
    ),
  );
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
  } else {
    lastError = { endpoint, status: 0, detail: "network/fetch error" };
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
  if (view === "hud") {
    await updateHud(note);
  } else if (sameMenu(buildMenuItems(lastStatus, settings), menuItems)) {
    await updateMenuInfo(formatMenuInfo(lastStatus, note));
  } else {
    await showMenu(note);
  }
}

async function pollStatus(note = "") {
  if (!client) {
    await renderCurrent(NOT_CONFIGURED);
    return;
  }
  try {
    lastStatus = await client.getStatus();
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
      unsubscribe();
      return;
    }

    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      backgrounded = false;
      if (view === "connect") {
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
  tempEl.value = String(settings.climateTemp);
  defrostEl.checked = settings.climateDefrost;
  heatingEl.checked = settings.climateHeating;
  acEl.value = String(settings.chargeLimitAc);
  dcEl.value = String(settings.chargeLimitDc);

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
        setStatus(
          testStatus,
          `Connected. Car responded (battery ${status.soc_percent ?? "?"}%).`,
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
        // Already trusted — no OTP needed.
        settings.kiaUsDeviceToken = result.device_token;
        rebuildClient();
        await enqueue(() => saveSettings(bridge as Bridge, settings));
        setStatus(enrollStatus, "Device already trusted. Saved.");
        hideEnrollSection();
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
      settings.kiaUsDeviceToken = result.device_token;
      rebuildClient();
      const ok = await enqueue(() => saveSettings(bridge as Bridge, settings));
      if (ok) {
        setStatus(
          enrollStatus,
          "Device enrolled and saved. Tap Test connection to verify.",
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

  saveBtn.addEventListener("click", async () => {
    const temp = parseFloat(tempEl.value);
    // Different username ⇒ different account ⇒ old device token is stale.
    const usernameChanged =
      usernameEl.value.trim().toLowerCase() !==
      settings.username.trim().toLowerCase();
    if (usernameChanged && settings.kiaUsDeviceToken) {
      delete settings.kiaUsDeviceToken;
      if (needsEnrollment()) showEnrollSection();
    }
    settings = {
      username: usernameEl.value.trim(),
      password: passwordEl.value,
      pin: pinEl.value.trim(),
      region: Number(regionEl.value),
      climateTemp: isNaN(temp) ? 21 : Math.min(30, Math.max(14, temp)),
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
    };
    rebuildClient();
    const ok = await enqueue(() => saveSettings(bridge as Bridge, settings));
    setStatus(saveStatus, ok ? "Saved." : "Save failed. Try again.", !ok);
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
  rebuildClient();
  subscribeEvents();
  void connectToBackend();
  bindPhoneUi();
}
