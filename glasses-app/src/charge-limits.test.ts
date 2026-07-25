// @vitest-environment happy-dom
/**
 * Charge limits: the send is a deliberate action, and Save is not it.
 *
 * THE RULE THESE PIN: every car command in this app is an explicit, separately
 * labelled tap. Charge limits briefly rode along with Save, which made a
 * preference write drive the vehicle as a side effect — a dropdown touched by
 * accident became a command. They don't any more:
 *
 *   · Save persists the limit VALUES like any other preference and sends
 *     nothing, so an unsent limit survives a reload and still offers its send;
 *   · a contextual button appears only while the form disagrees with what the
 *     car is known to hold, names the exact values it will send, and keeps its
 *     own status line;
 *   · a failed send leaves the button up — it IS the retry path for the
 *     sleeping-car case, which the old always-present button used to provide;
 *   · two pushes are never in flight at once.
 *
 * Driven through the real `index.html` body and `main.ts`, with the network
 * intercepted: the property is a wiring one between the form, the button and
 * the client.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./settings";

const SETTINGS_KEY = "connect-remote.settings";
const storage = new Map<string, string>();

vi.mock("@evenrealities/even_hub_sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@evenrealities/even_hub_sdk")
  >("@evenrealities/even_hub_sdk");
  return {
    ...actual,
    waitForEvenAppBridge: async () => ({
      _ready: true,
      getLocalStorage: async (key: string) => storage.get(key) ?? null,
      setLocalStorage: async (key: string, value: string) => {
        storage.set(key, value);
        return true;
      },
      // Refuses the startup page: the phone form binds and hydrates, and boot
      // stops before connecting, so nothing but this test drives the network.
      createStartUpPageContainer: async () => 1,
      rebuildPageContainer: async () => false,
      textContainerUpgrade: async () => false,
      updateImageRawData: async () => 3,
      shutDownPageContainer: async () => undefined,
      onEvenHubEvent: () => () => {},
    }),
  };
});

const HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

function loadPageBody() {
  const body = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const limitsBtn = () => el<HTMLButtonElement>("limits-btn");

/** Every request main.ts makes, and a hook to decide how each one answers. */
interface Call {
  path: string;
  body: unknown;
  settle: (ok: boolean) => void;
}
let calls: Call[] = [];

function stubNetwork() {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://proxy.test").pathname;
    return new Promise((resolvePromise, rejectPromise) => {
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        settle: (ok) =>
          ok
            ? resolvePromise({
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => "{}",
              } as unknown as Response)
            : rejectPromise(new TypeError("network down")),
      });
    });
  });
}

/** The saved state a returning owner has: an account, and limits the car is
 *  known to already hold. */
function savedSettings(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...DEFAULT_SETTINGS,
    username: "owner@example.com",
    password: "not-a-real-password",
    pin: "4417",
    chargeLimitAc: 80,
    chargeLimitDc: 90,
    chargeLimitsSent: { ac: 80, dc: 90, at: Date.now() },
    ...extra,
  });
}

async function boot(saved = savedSettings()) {
  storage.set(SETTINGS_KEY, saved);
  await import("./main");
  await vi.waitFor(() =>
    expect(el<HTMLInputElement>("acct-username").value).toBe(
      "owner@example.com",
    ),
  );
}

function pickLimit(id: string, value: string) {
  const select = el<HTMLSelectElement>(id);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the contextual charge-limit send", () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    calls = [];
    loadPageBody();
    stubNetwork();
    if (typeof (globalThis as Record<string, unknown>).Option !== "function") {
      (globalThis as Record<string, unknown>).Option = class {
        constructor(label: string, value: string) {
          const opt = document.createElement("option");
          opt.textContent = label;
          opt.setAttribute("value", value);
          return opt as unknown as never;
        }
      };
    }
  });
  afterEach(async () => {
    // Let anything still in flight finish against the stub rather than a
    // torn-down window (which surfaces as a teardown AbortError). Failing one
    // request can start another — the app re-polls — so drain until quiet.
    // Rounds run unconditionally: a request kicked off by the last assertion
    // (Save re-polls the car) may not have reached the stub yet.
    for (let round = 0; round < 5; round++) {
      const pending = calls;
      calls = [];
      for (const call of pending) call.settle(false);
      await new Promise((tick) => setTimeout(tick, 0));
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    document.body.innerHTML = "";
  });

  it("stays out of the way while the car already holds these limits", async () => {
    await boot();
    expect(limitsBtn().hidden).toBe(true);
  });

  it("appears naming the exact values once one of them is changed", async () => {
    await boot();
    pickLimit("charge-limit-dc", "100");

    expect(limitsBtn().hidden).toBe(false);
    expect(limitsBtn().textContent).toBe("Send 80% / 100% to car");

    // And follows further edits rather than going stale.
    pickLimit("charge-limit-ac", "70");
    expect(limitsBtn().textContent).toBe("Send 70% / 100% to car");
  });

  it("goes away again if the values are put back", async () => {
    await boot();
    pickLimit("charge-limit-dc", "100");
    expect(limitsBtn().hidden).toBe(false);

    pickLimit("charge-limit-dc", "90");
    expect(limitsBtn().hidden).toBe(true);
  });

  it("sends only when tapped, and stands down once the car has them", async () => {
    await boot();
    pickLimit("charge-limit-dc", "100");
    expect(calls).toHaveLength(0); // changing the dropdown sent nothing

    limitsBtn().click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toBe("/charge-limits");
    expect(calls[0].body).toMatchObject({ ac: 80, dc: 100 });
    expect(el("limits-status").textContent).toBe("Sending…");

    calls[0].settle(true);
    await vi.waitFor(() => expect(limitsBtn().hidden).toBe(true));
    expect(el("limits-status").textContent).toContain("Sent");
  });

  it("keeps the button up after a failure — it is the retry", async () => {
    await boot();
    pickLimit("charge-limit-dc", "100");
    limitsBtn().click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    calls[0].settle(false);
    await vi.waitFor(() => expect(limitsBtn().disabled).toBe(false));
    expect(limitsBtn().hidden).toBe(false);
    expect(limitsBtn().textContent).toBe("Send 80% / 100% to car");
    expect(el("limits-status").classList.contains("err")).toBe(true);

    // ...and the retry is a plain second tap.
    limitsBtn().click();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].settle(true);
    await vi.waitFor(() => expect(limitsBtn().hidden).toBe(true));
  });

  it("never has two pushes in flight", async () => {
    await boot();
    pickLimit("charge-limit-dc", "100");

    limitsBtn().click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(limitsBtn().disabled).toBe(true);
    expect(limitsBtn().textContent).toBe("Sending…");

    // A second tap while in flight is ignored outright — not queued.
    limitsBtn().click();
    limitsBtn().click();
    expect(calls).toHaveLength(1);

    calls[0].settle(true);
    await vi.waitFor(() => expect(limitsBtn().hidden).toBe(true));
    expect(calls).toHaveLength(1);
  });

  describe("Save", () => {
    it("persists the limit values and sends nothing to the car", async () => {
      await boot();
      pickLimit("charge-limit-dc", "100");

      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() =>
        expect(
          JSON.parse(storage.get(SETTINGS_KEY) as string).chargeLimitDc,
        ).toBe(100),
      );

      // The only requests Save is allowed to make are the status re-poll it
      // has always made; a /charge-limits push is not one of them.
      expect(calls.filter((c) => c.path === "/charge-limits")).toHaveLength(0);
    });

    it("leaves an unsent limit offering its send after a reload", async () => {
      await boot();
      pickLimit("charge-limit-dc", "100");
      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() =>
        expect(
          JSON.parse(storage.get(SETTINGS_KEY) as string).chargeLimitDc,
        ).toBe(100),
      );
      // Saving must not have claimed the car now holds it.
      expect(
        JSON.parse(storage.get(SETTINGS_KEY) as string).chargeLimitsSent,
      ).toEqual({ ac: 80, dc: 90, at: expect.any(Number) });

      // Reopen the app on that saved state.
      const saved = storage.get(SETTINGS_KEY) as string;
      document.body.innerHTML = "";
      loadPageBody();
      vi.resetModules();
      // Settle before discarding: an in-flight request whose handle is thrown
      // away outlives the window and surfaces as a teardown AbortError.
      for (const call of calls) call.settle(false);
      calls = [];
      await boot(saved);

      expect(el<HTMLSelectElement>("charge-limit-dc").value).toBe("100");
      expect(limitsBtn().hidden).toBe(false);
      expect(limitsBtn().textContent).toBe("Send 80% / 100% to car");
    });

    it("remembers a successful send across a save", async () => {
      await boot();
      pickLimit("charge-limit-dc", "100");
      limitsBtn().click();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      calls[0].settle(true);
      await vi.waitFor(() => expect(limitsBtn().hidden).toBe(true));

      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() =>
        expect(
          JSON.parse(storage.get(SETTINGS_KEY) as string).chargeLimitsSent.dc,
        ).toBe(100),
      );
      // A plain Save must not forget it and start nagging to re-send.
      expect(limitsBtn().hidden).toBe(true);
    });
  });

  it("offers nothing on a car that cannot plug in", async () => {
    await boot(savedSettings({ lastPowertrain: "ICE", chargeLimitDc: 100 }));
    expect(el("charge-limits-section").style.display).toBe("none");
    expect(limitsBtn().hidden).toBe(true);
  });

  it("offers nothing before an account is saved", async () => {
    // First run: the dropdowns are there, but a send could only fail. Booted
    // by hand — `boot` waits on a saved username, and there isn't one.
    storage.set(
      SETTINGS_KEY,
      JSON.stringify({ ...DEFAULT_SETTINGS, username: "", password: "" }),
    );
    await import("./main");
    await vi.waitFor(() =>
      expect(
        el<HTMLSelectElement>("charge-limit-ac").options.length,
      ).toBeGreaterThan(0),
    );
    expect(el("charge-limits-section").style.display).not.toBe("none");
    expect(limitsBtn().hidden).toBe(true);
  });
});
