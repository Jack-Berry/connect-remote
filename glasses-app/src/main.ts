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
import { applyBrand } from "./brand";
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
  isConfigured,
  loadSettings,
  saveSettings,
} from "./settings";

const bridge = await waitForEvenAppBridge();

let settings: AppSettings = await loadSettings(bridge);
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
// Guard against rapid repeat double-taps: without it, HUD→menu can
// immediately chain into menu→close-app.
let lastDoubleClickAt = 0;

function rebuildClient() {
  client = isConfigured(settings)
    ? new BackendClient(settings.backendUrl, settings.token)
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

// Single tap on the HUD toggles "glasses off". Unhide paints last-known data
// immediately, then refreshes in the background — never a stale-blank wait.
async function toggleHudHidden() {
  hudHidden = !hudHidden;
  await updateHud();
  if (!hudHidden) void pollStatus();
}

function updateMenuInfo(content: string) {
  return upgradeText(MENU_INFO_CONTAINER, content);
}

function showHud(note = "") {
  view = "hud";
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

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Auth failed: check token in phone app";
    if (err.status === 502) return "Genesis unreachable";
    // Backend reached Genesis but couldn't parse the reply — our bug, not
    // a connectivity problem, so don't send the user chasing credentials.
    if (err.status === 500) return "Backend parse bug — please report";
    return `Backend error ${err.status}`;
  }
  if (err instanceof TimeoutError)
    return "Backend timeout — waking? retry in 1 min";
  return "Backend unreachable: check URL/network";
}

const NOT_CONFIGURED =
  "Not configured — open app on phone,\nenter backend URL + token";

// Re-render the current view from lastStatus. Menu items are rebuilt only
// when the context-aware set actually changed (rebuild flickers; the info
// panel upgrade does not).
async function renderCurrent(note = "") {
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
    // Keep showing the last-known data with the error appended — never blank.
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
  if (!client) {
    connectState = "failed";
    await upgradeText(CONNECT_SPIN_CONTAINER, " ");
    await upgradeText(CONNECT_CONTAINER, formatConnectFail(NOT_CONFIGURED));
    return;
  }
  connectState = "connecting";
  await upgradeText(CONNECT_CONTAINER, CONNECTING_TEXT);
  await upgradeText(CONNECT_SPIN_CONTAINER, spinnerFrame(0));
  startSpinner();
  try {
    // Same wake-aware probe as the phone app's Test connection: /healthz
    // with backoff until the backend answers, and only then /status. A
    // single launch /status was one dropped request during a Render cold
    // start away from never waking the backend at all.
    await client.wake();
    lastStatus = await client.getStatus();
    stopSpinner();
    await showHud();
  } catch (err) {
    stopSpinner();
    connectState = "failed";
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
    await showHud(`${note} — car applies in 30-90s`);
    scheduleRepoll(15_000);
  } catch (err) {
    await updateMenuInfo(formatMenuInfo(lastStatus, describeError(err)));
  }
}

// ---------------------------------------------------------------------------
// Startup page + events

const createResult = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(connectPage(CONNECTING_TEXT, spinnerFrame(0))),
);
console.log(
  "Page created:",
  createResult === 0 ? "success" : `failed (${createResult})`,
);

const unsubscribe = bridge.onEvenHubEvent((event) => {
  // Protobuf drops zero-value fields: CLICK_EVENT (0) and item index 0
  // arrive as undefined, so coalesce with ?? 0 — but only when the
  // envelope itself is present.
  const sysType = event.sysEvent ? (event.sysEvent.eventType ?? 0) : null;
  const textType = event.textEvent ? (event.textEvent.eventType ?? 0) : null;
  const listIndex = event.listEvent
    ? (event.listEvent.currentSelectItemIndex ?? 0)
    : null;

  // Double-tap: HUD → open the actions menu; menu → system "close app?"
  // Yes/No dialog. Cleanup happens on SYSTEM_EXIT/ABNORMAL_EXIT, not here —
  // the user can still cancel the dialog. (The simulator does not render the
  // dialog and just blanks the panel; hardware shows Yes/No.)
  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    const now = Date.now();
    if (now - lastDoubleClickAt < 800) return;
    lastDoubleClickAt = now;
    if (view === "connect") {
      // Mid-connect taps are ignored; after a failure, double-tap retries.
      if (connectState === "failed") void connectToBackend();
    } else if (view === "hud") {
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
    unsubscribe();
    return;
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (view === "connect") {
      if (connectState === "failed") void connectToBackend();
    } else {
      void pollStatus();
    }
    return;
  }

  // Menu: the firmware scrolls the list natively; a single tap reports the
  // selected item. R1 ring gestures arrive through the same events.
  if (listIndex !== null && view === "menu") {
    void selectMenuItem(listIndex);
    return;
  }

  // HUD: single tap toggles "glasses off" (hide/show everything). Double-tap
  // still opens the menu from either state, handled above. Swipes do nothing.
  if (
    view === "hud" &&
    (sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT)
  ) {
    void toggleHudHidden();
    return;
  }
});

void connectToBackend();

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
  const urlEl = document.getElementById("backend-url") as HTMLInputElement;
  const tokenEl = document.getElementById("api-token") as HTMLInputElement;
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

  for (const el of [acEl, dcEl]) {
    for (let pct = 50; pct <= 100; pct += 10) {
      el.add(new Option(`${pct}%`, String(pct)));
    }
  }

  // First run: walk the user through setup. Once configured, collapse it.
  guideEl.open = !isConfigured(settings);
  urlEl.value = settings.backendUrl;
  tokenEl.value = settings.token;
  tempEl.value = String(settings.climateTemp);
  defrostEl.checked = settings.climateDefrost;
  heatingEl.checked = settings.climateHeating;
  acEl.value = String(settings.chargeLimitAc);
  dcEl.value = String(settings.chargeLimitDc);

  // Probe with the current field values (not saved state) so users can test
  // before saving. healthz first isolates reachability from auth problems.
  testBtn.addEventListener("click", async () => {
    const url = urlEl.value.trim();
    if (!url) {
      setStatus(testStatus, "Enter a backend URL first.", true);
      return;
    }
    const probe = new BackendClient(url, tokenEl.value.trim());
    testBtn.disabled = true;
    setStatus(
      testStatus,
      "Testing… (can take up to a minute if the backend is waking)",
    );
    try {
      try {
        await probe.healthz();
      } catch (err) {
        setStatus(
          testStatus,
          err instanceof TimeoutError
            ? "Timed out — a free-tier backend may still be waking. Try again in a minute."
            : "Backend unreachable — check the URL.",
          true,
        );
        return;
      }
      try {
        const status = await probe.getStatus();
        setStatus(
          testStatus,
          `Connected — car responded (battery ${status.soc_percent ?? "?"}%).`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setStatus(
            testStatus,
            "Backend OK, but the token was rejected — check the API token.",
            true,
          );
        } else if (err instanceof ApiError && err.status === 502) {
          setStatus(
            testStatus,
            "Backend OK, but it could not reach Genesis — check the Genesis credentials in its environment.",
            true,
          );
        } else if (err instanceof ApiError && err.status === 500) {
          setStatus(
            testStatus,
            "Backend OK and Genesis reachable, but the car data could not be parsed — a backend bug, please report it.",
            true,
          );
        } else if (err instanceof TimeoutError) {
          setStatus(
            testStatus,
            "Backend OK, but the car status timed out — try again in a minute.",
            true,
          );
        } else {
          setStatus(
            testStatus,
            "Backend OK, but the status check failed.",
            true,
          );
        }
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  limitsBtn.addEventListener("click", async () => {
    const url = urlEl.value.trim();
    const token = tokenEl.value.trim();
    if (!url || !token) {
      setStatus(limitsStatus, "Configure the backend first.", true);
      return;
    }
    limitsBtn.disabled = true;
    setStatus(limitsStatus, "Sending…");
    try {
      await new BackendClient(url, token).setChargeLimits(
        Number(acEl.value),
        Number(dcEl.value),
      );
      setStatus(limitsStatus, "Limits sent — the car applies them in 30–90 s.");
    } catch (err) {
      setStatus(limitsStatus, describeError(err), true);
    } finally {
      limitsBtn.disabled = false;
    }
  });

  saveBtn.addEventListener("click", async () => {
    const temp = parseFloat(tempEl.value);
    settings = {
      backendUrl: urlEl.value.trim(),
      token: tokenEl.value.trim(),
      climateTemp: isNaN(temp) ? 21 : Math.min(30, Math.max(14, temp)),
      climateDefrost: defrostEl.checked,
      climateHeating: heatingEl.checked,
      chargeLimitAc: Number(acEl.value),
      chargeLimitDc: Number(dcEl.value),
    };
    rebuildClient();
    const ok = await enqueue(() => saveSettings(bridge as Bridge, settings));
    setStatus(saveStatus, ok ? "Saved." : "Save failed — try again.", !ok);
    if (ok) guideEl.open = !isConfigured(settings);
    // Still on the connect page (first run: user just typed the URL/token
    // the connect attempt was missing) → kick off a fresh connect; after
    // that, a plain re-poll updates the HUD/menu in place.
    if (view === "connect") {
      if (connectState === "failed") void connectToBackend();
    } else {
      void pollStatus();
    }
  });
}

bindPhoneUi();
