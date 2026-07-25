// @vitest-environment happy-dom
/**
 * Kia-US enrolment section: is it on screen when it is needed?
 *
 * THE BUG THIS PINS: the section's visibility was decided ONCE, at bind time,
 * from `regionEl.value`. Bind time is before the settings read resolves (that
 * read goes over the bridge), so the select still held the default Europe and
 * the section stayed hidden. Hydration re-filled the form afterwards but never
 * re-ran the check. A returning Kia-US owner with no stored device token — the
 * exact state you are in when a token expires and you must re-enrol — opened
 * the settings page to no enrolment UI at all. It surfaced only if they touched
 * the region select, or after Test connection came back 409.
 *
 * Driven through the real `index.html` body and `main.ts`, because the property
 * that broke is an ordering one between the settings read and the form: nothing
 * smaller than the module can observe it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "./settings";

const SETTINGS_KEY = "connect-remote.settings";

/** Bridge KV, seeded per test — this is what "previously saved" means. */
const storage = new Map<string, string>();

/**
 * A host that attaches immediately but refuses the startup page (returns 1).
 * That is the "glasses UI disabled, phone settings still usable" branch, and it
 * is deliberate here: boot still reads the settings and hydrates the form, but
 * stops before subscribing to events or reaching the network.
 */
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

/** A configured account, saved in a previous session. Region 3 = USA. */
function savedSettings(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...DEFAULT_SETTINGS,
    username: "kia.owner@example.com",
    password: "not-a-real-password",
    pin: "4417",
    region: 3,
    ...extra,
  });
}

/** Import main.ts and wait until the settings read has reached the form. */
async function bootWithSavedUsername(expected: string) {
  await import("./main");
  await vi.waitFor(() =>
    expect(el<HTMLInputElement>("acct-username").value).toBe(expected),
  );
}

describe("Kia-US enrolment section visibility", () => {
  beforeEach(() => {
    vi.resetModules();
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

  describe("on a Kia build", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_BRAND", "kia");
    });

    it("shows it on load for a saved USA account with no device token", async () => {
      // THE REGRESSION. No interaction of any kind after boot.
      storage.set(SETTINGS_KEY, savedSettings());

      await bootWithSavedUsername("kia.owner@example.com");

      // Guard: the Kia build really is the one under test (a Genesis build
      // would hide the section for the right reason and pass vacuously).
      expect(document.title).toBe("Kia Remote");
      expect(el<HTMLSelectElement>("acct-region").value).toBe("3");
      expect(el("enroll-section").style.display).not.toBe("none");
      // The send-code step, not the verify step.
      expect(el("enroll-verify-area").style.display).toBe("none");
    });

    it("keeps it hidden when a device token is already stored", async () => {
      storage.set(
        SETTINGS_KEY,
        savedSettings({ kiaUsDeviceToken: { device_id: "abc123" } }),
      );

      await bootWithSavedUsername("kia.owner@example.com");

      expect(el("enroll-section").style.display).toBe("none");
    });

    it("keeps it hidden for a saved non-US region", async () => {
      storage.set(SETTINGS_KEY, savedSettings({ region: 1 }));

      await bootWithSavedUsername("kia.owner@example.com");

      expect(el<HTMLSelectElement>("acct-region").value).toBe("1");
      expect(el("enroll-section").style.display).toBe("none");
    });

    it("still shows it when a fresh user picks USA in the form", async () => {
      // The path that always worked, and must keep working: nothing saved, the
      // user selects their region by hand.
      await import("./main");
      const region = el<HTMLSelectElement>("acct-region");
      await vi.waitFor(() => expect(region.options.length).toBeGreaterThan(0));
      expect(el("enroll-section").style.display).toBe("none");

      region.value = "3";
      region.dispatchEvent(new Event("change"));

      expect(el("enroll-section").style.display).not.toBe("none");
    });

    it("does not discard a typed code when the evaluation re-runs", async () => {
      // `syncEnrollSection` is idempotent by design: the hide path resets the
      // code field and the "code sent" line, so a re-run that changes nothing
      // must not touch the DOM.
      storage.set(SETTINGS_KEY, savedSettings());
      await bootWithSavedUsername("kia.owner@example.com");

      const verifyArea = el("enroll-verify-area");
      const code = el<HTMLInputElement>("enroll-code");
      // Stand in for "a code was sent": the verify step is on screen, mid-entry.
      verifyArea.style.display = "";
      code.value = "481032";

      const region = el<HTMLSelectElement>("acct-region");
      region.dispatchEvent(new Event("change"));

      expect(el("enroll-section").style.display).not.toBe("none");
      expect(verifyArea.style.display).toBe("");
      expect(code.value).toBe("481032");
    });
  });

  it("never shows it on a Genesis build, whatever the region", async () => {
    vi.stubEnv("VITE_BRAND", "genesis");
    storage.set(SETTINGS_KEY, savedSettings());

    await bootWithSavedUsername("kia.owner@example.com");

    expect(document.title).toBe("Genesis Remote");
    expect(el("enroll-section").style.display).toBe("none");
  });
});
