// @vitest-environment happy-dom
/**
 * Save's disabled-until-dirty gate: does EVERY control still reach it?
 *
 * THE RISK THIS PINS: the gate is fed by one delegated `input`/`change`
 * listener in the capture phase on `#app`. That is deliberately broad — a
 * hand-written list of fields is what leaves a newly added control unable to
 * enable Save — but it moves the failure somewhere quieter: any control that
 * changes a persisted value WITHOUT emitting a bubbling input/change event
 * leaves Save permanently dead, with nothing on screen saying why. Two controls
 * on this form are exactly that shape, because neither is the element the value
 * actually lives in:
 *
 *   · the +/- climate steppers, which drive `#climate-temp` through
 *     stepUp()/stepDown() — a programmatic value change, which fires nothing at
 *     all unless we dispatch it ourselves;
 *   · the Celsius/Fahrenheit segmented switch, whose visible control is two
 *     <button>s that write to a hidden <select id="temp-unit"> — and buttons
 *     emit no change event of their own.
 *
 * Both synthesise `bubbles: true` events on purpose. Delete that flag from
 * either and Save silently stops responding to that control; these tests fail
 * instead. The plain form fields are swept too, so the gate is proven for the
 * whole form and not just the interesting parts.
 *
 * Driven through the real `index.html` body and `main.ts`: the property under
 * test is "the wiring in the page reaches the gate in the module", and nothing
 * smaller than the module can observe it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./settings";

const SETTINGS_KEY = "connect-remote.settings";
const storage = new Map<string, string>();

/** A host that attaches but refuses the startup page: settings are read and the
 *  form hydrates, and nothing reaches the glasses or the network. */
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

const saveDisabled = () => el<HTMLButtonElement>("save-btn").disabled;

/**
 * Import main.ts and wait until the settings read has reached the form — which
 * is also the moment Save settles back to disabled.
 *
 * The saved account deliberately has no password, so `isConfigured` is false
 * and no backend client is ever built. Saving re-polls the car
 * (`persistForm` → connect/poll), and with a client that path would fire real
 * requests at a proxy that isn't there, whose teardown fills the run with
 * AbortErrors. None of these tests are about the network.
 */
async function boot(saved: Record<string, unknown> = {}) {
  storage.set(
    SETTINGS_KEY,
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      username: "owner@example.com",
      password: "",
      pin: "4417",
      ...saved,
    }),
  );
  await import("./main");
  await vi.waitFor(() =>
    expect(el<HTMLInputElement>("acct-username").value).toBe(
      "owner@example.com",
    ),
  );
  // Hydration is programmatic assignment: it must not have dirtied anything.
  expect(saveDisabled()).toBe(true);
}

/** Type into a text field the way a user does. */
function type(id: string, value: string) {
  const input = el<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pick(id: string, value: string) {
  const select = el<HTMLSelectElement>(id);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Save's disabled-until-dirty gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    storage.clear();
    loadPageBody();
    // happy-dom omits the legacy `Option` factory that real WebViews expose
    // and `bindPhoneUi` uses to fill the region/charge-limit selects.
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
  afterEach(() => {
    vi.unstubAllEnvs();
    document.body.innerHTML = "";
  });

  describe("controls that emit nothing of their own", () => {
    it("enables Save from the + stepper", async () => {
      await boot();
      const before = el<HTMLInputElement>("climate-temp").value;

      el<HTMLButtonElement>("temp-up").click();

      expect(el<HTMLInputElement>("climate-temp").value).not.toBe(before);
      expect(saveDisabled()).toBe(false);
    });

    it("enables Save from the − stepper", async () => {
      await boot();
      const before = el<HTMLInputElement>("climate-temp").value;

      el<HTMLButtonElement>("temp-down").click();

      expect(el<HTMLInputElement>("climate-temp").value).not.toBe(before);
      expect(saveDisabled()).toBe(false);
    });

    it("enables Save from the Fahrenheit segment, and from Celsius back", async () => {
      await boot();

      el<HTMLButtonElement>("unit-f").click();
      expect(el<HTMLSelectElement>("temp-unit").value).toBe("F");
      expect(el("climate-temp-unit").textContent).toBe("°F");
      expect(saveDisabled()).toBe(false);

      // And the way back, from a form that has settled again.
      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() => expect(saveDisabled()).toBe(true));

      el<HTMLButtonElement>("unit-c").click();
      expect(el<HTMLSelectElement>("temp-unit").value).toBe("C");
      expect(saveDisabled()).toBe(false);
    });

    it("does not dirty the form when the segment is already the active one", async () => {
      await boot();
      // Celsius is already selected; re-tapping it changes nothing, so it must
      // not manufacture a change event (which would also re-run the conversion
      // and could nudge the value).
      el<HTMLButtonElement>("unit-c").click();
      expect(saveDisabled()).toBe(true);
    });
  });

  describe("the rest of the form", () => {
    const textFields = ["acct-username", "acct-password", "acct-pin"];
    for (const id of textFields) {
      it(`enables Save from #${id}`, async () => {
        await boot();
        type(id, "changed");
        expect(saveDisabled()).toBe(false);
      });
    }

    const selects: [string, string][] = [
      ["acct-region", "2"],
      ["charge-limit-ac", "70"],
      ["charge-limit-dc", "100"],
    ];
    for (const [id, value] of selects) {
      it(`enables Save from #${id}`, async () => {
        await boot();
        pick(id, value);
        expect(saveDisabled()).toBe(false);
      });
    }

    const toggles = ["climate-defrost", "climate-heating"];
    for (const id of toggles) {
      it(`enables Save from #${id}`, async () => {
        await boot();
        el<HTMLInputElement>(id).click();
        expect(saveDisabled()).toBe(false);
      });
    }

    it("enables Save from typing straight into the climate field", async () => {
      await boot();
      type("climate-temp", "25");
      expect(saveDisabled()).toBe(false);
    });
  });

  describe("across the states the form has", () => {
    it("re-disables after a successful save, and re-enables on the next edit", async () => {
      await boot();
      type("acct-pin", "1234");
      expect(saveDisabled()).toBe(false);

      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() => expect(saveDisabled()).toBe(true));

      type("acct-pin", "9999");
      expect(saveDisabled()).toBe(false);
    });

    it("survives hydration landing after the user has already typed", async () => {
      // The form is live from bind time, which is BEFORE the settings read
      // resolves. A user who types in that window must keep both their text
      // and an enabled Save when the real settings arrive.
      storage.set(
        SETTINGS_KEY,
        JSON.stringify({ ...DEFAULT_SETTINGS, username: "saved@example.com" }),
      );
      await import("./main");
      type("acct-username", "typed@example.com");
      expect(saveDisabled()).toBe(false);

      await vi.waitFor(() =>
        expect(el<HTMLSelectElement>("acct-region").options.length).toBeGreaterThan(0),
      );
      expect(el<HTMLInputElement>("acct-username").value).toBe(
        "typed@example.com",
      );
      expect(saveDisabled()).toBe(false);
    });

    it("reaches the gate from the Kia-US enrolment section too", async () => {
      // The enrolment section is inserted into the same form; its controls sit
      // under the same delegated listener and must not be a dead zone.
      vi.stubEnv("VITE_BRAND", "kia");
      await boot({ region: 3 });
      expect(el("enroll-section").style.display).not.toBe("none");

      // Step 1: the channel select.
      pick("enroll-notify-type", "SMS");
      expect(saveDisabled()).toBe(false);

      el<HTMLButtonElement>("save-btn").click();
      await vi.waitFor(() => expect(saveDisabled()).toBe(true));

      // Step 2: the code field, with the verify step on screen.
      el("enroll-start-area").style.display = "none";
      el("enroll-verify-area").style.display = "";
      type("enroll-code", "418902");
      expect(saveDisabled()).toBe(false);
    });

    for (const brand of ["genesis", "kia", "hyundai"]) {
      it(`gates the same way on a ${brand} build`, async () => {
        vi.stubEnv("VITE_BRAND", brand);
        await boot();

        el<HTMLButtonElement>("temp-up").click();
        expect(saveDisabled()).toBe(false);

        el<HTMLButtonElement>("save-btn").click();
        await vi.waitFor(() => expect(saveDisabled()).toBe(true));

        el<HTMLButtonElement>("unit-f").click();
        expect(saveDisabled()).toBe(false);
      });
    }
  });
});
