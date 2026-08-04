// @vitest-environment happy-dom
/**
 * Boot order — the phone screen must work without the glasses.
 *
 * THE BUG THIS PINS: `main.ts` opened with `const bridge = await
 * waitForEvenAppBridge()`. That promise has no timeout and no reject path, so
 * on a host that never injected the bridge the entire module body never ran.
 * The phone settings page still rendered — it is static HTML — but nothing was
 * ever bound to it. "Find my car" did nothing. So did "Copy diagnostic report",
 * which is why five hardware rounds produced no report to read.
 *
 * The test drives the real `index.html` body with a bridge that never arrives,
 * imports `main.ts` exactly as the page does, and clicks the button. It fails
 * on the old boot order and passes on the new one. It is deliberately a DOM
 * test rather than a unit test: the property that broke was "the module gets to
 * the end", and nothing smaller than the module can observe that.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A bridge that never arrives — the exact hardware failure. `importActual`
// keeps every enum and container class real, so main.ts builds the same page
// objects it always does; only the handshake is replaced.
vi.mock("@evenrealities/even_hub_sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@evenrealities/even_hub_sdk")
  >("@evenrealities/even_hub_sdk");
  return { ...actual, waitForEvenAppBridge: () => new Promise(() => {}) };
});

// `import.meta.url` is an http URL under the happy-dom environment, so resolve
// from the vitest root (glasses-app/) instead.
const HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

/** The page's own markup, minus the module script tag (the test imports
 *  main.ts itself, and innerHTML would not execute it anyway). */
function loadPageBody() {
  const body = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

describe("boot with no host bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPageBody();
    // happy-dom omits the legacy `Option` factory that real WebViews expose
    // and `bindPhoneUi` uses to fill the region/charge-limit selects.
    if (typeof (globalThis as Record<string, unknown>).Option !== "function") {
      (globalThis as Record<string, unknown>).Option = class {
        constructor(label: string, value: string) {
          const el = document.createElement("option");
          el.textContent = label;
          el.setAttribute("value", value);
          return el as unknown as never;
        }
      };
    }
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("binds the phone UI even though the bridge never arrives", async () => {
    await import("./main");

    const screen = document.getElementById("finder-screen") as HTMLElement;
    const open = document.getElementById("finder-open") as HTMLButtonElement;
    // Closed to begin with (the stylesheet's display: none).
    expect(screen.style.display).not.toBe("flex");

    open.click();
    // Opening is synchronous up to the display flip; the glasses mirroring
    // that follows is what needs the bridge, and it is allowed to fail.
    await vi.waitFor(() => expect(screen.style.display).toBe("flex"));
  });

  it("closes again from the Back button", async () => {
    await import("./main");
    const screen = document.getElementById("finder-screen") as HTMLElement;
    (document.getElementById("finder-open") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(screen.style.display).toBe("flex"));

    (document.getElementById("finder-back") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(screen.style.display).toBe("none"));
  });

  it("binds the diagnostic report button — the one that had to work", async () => {
    // Same gate, and the reason the failure went five rounds without evidence:
    // the tool for reporting the bug was disabled by the bug.
    await import("./main");
    const diag = document.getElementById("diag-btn") as HTMLButtonElement;
    const status = document.getElementById("diag-status") as HTMLElement;
    diag.click();
    // It reports something — copied, or a copy failure with the text to hand.
    await vi.waitFor(() => expect(status.textContent).toBeTruthy());
  });

  it("leaves the settings form usable", async () => {
    await import("./main");
    // The region select is populated by bindPhoneUi; empty means it never ran.
    const region = document.getElementById("acct-region") as HTMLSelectElement;
    expect(region.options.length).toBeGreaterThan(0);
  });

  it("still binds the finder when the settings form fails to bind", async () => {
    // The two surfaces bind in order, finder last. A throw in the settings
    // form used to take the finder's listeners with it, silently — the very
    // "bindPhoneFinder never ran" theory this bug was first blamed on. Here the
    // form is sabotaged by removing an element it dereferences.
    document.getElementById("acct-region")?.remove();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./main");

    // It really did fail...
    expect(errors).toHaveBeenCalled();
    // ...and the finder works anyway.
    const screen = document.getElementById("finder-screen") as HTMLElement;
    (document.getElementById("finder-open") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(screen.style.display).toBe("flex"));
    errors.mockRestore();
  });
});
