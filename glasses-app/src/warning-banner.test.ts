// @vitest-environment happy-dom
/**
 * The phone's warning banner, driven against the REAL index.html markup.
 *
 * What this catches that warnings.test.ts cannot: an id that drifts between
 * the markup and the lookup. That failure is silent and fails OPEN — the
 * banner simply never appears — on the one surface that lists every active
 * warning rather than just the most severe. The glasses would still show
 * their single line, so nothing else would look wrong.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { WARNING_COPY, renderWarningBanner, warningLines } from "./warnings";

const HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

function loadPageBody() {
  const body = HTML.slice(HTML.indexOf("<body>") + 6, HTML.indexOf("</body>"));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

const banner = () => document.getElementById("warning-banner") as HTMLElement;
const lines = () =>
  Array.from(
    document.getElementById("warning-list")?.children ?? [],
  ).map((el) => el.textContent);

describe("phone warning banner", () => {
  beforeEach(loadPageBody);

  it("ships hidden — a healthy car is the normal case", () => {
    expect(banner().hidden).toBe(true);
    expect(lines()).toEqual([]);
  });

  it("lists every active warning, most severe first", () => {
    // The phone is complete where the glasses are brief: it has room, and the
    // user is already looking at it.
    renderWarningBanner(
      document,
      warningLines({
        warnings: ["washer_fluid_low", "brake_fluid_low", "tyre_pressure_low"],
      }),
    );
    expect(banner().hidden).toBe(false);
    expect(lines()).toEqual([
      WARNING_COPY.brake_fluid_low,
      WARNING_COPY.tyre_pressure_low,
      WARNING_COPY.washer_fluid_low,
    ]);
  });

  it("hides again when the warnings clear — and leaves no stale lines", () => {
    renderWarningBanner(document, warningLines({ warnings: ["brake_fluid_low"] }));
    renderWarningBanner(document, []);
    expect(banner().hidden).toBe(true);
    expect(lines()).toEqual([]);
  });

  it("has a dismiss control that is reachable and labelled", () => {
    // Dismissal is the phone's answer to the glasses' 5 s auto-clear. On the
    // HUD a tap hides the display, so there can be no button there; here
    // there must be one, and it must be findable by a screen reader.
    const btn = document.getElementById("warning-dismiss") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toMatch(/dismiss/i);
  });

  it("does nothing at all on a host with no phone DOM", () => {
    document.body.innerHTML = "";
    expect(() =>
      renderWarningBanner(document, [WARNING_COPY.brake_fluid_low]),
    ).not.toThrow();
  });
});
