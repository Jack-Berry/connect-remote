/**
 * The gate exists because an unbounded `await waitForEvenAppBridge()` at module
 * top level meant a missing host silently un-booted the entire app — phone
 * settings screen included. These tests pin the two properties that keep that
 * from happening again: nothing hangs, and nothing pretends to be a host.
 */
import { describe, expect, it, vi } from "vitest";
import { createBridgeGate } from "./bridge-gate";
import type { Bridge } from "./settings";

/** A host that answers everything successfully, minus the 12 methods this app
 *  actually calls being spelled out — only the ones a test exercises. */
function fakeHost(overrides: Record<string, unknown> = {}) {
  return {
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async () => true),
    getLocalStorage: vi.fn(async () => '{"username":"real"}'),
    setLocalStorage: vi.fn(async () => true),
    onEvenHubEvent: vi.fn(() => () => {}),
    // Present only on SDK 0.0.11+; absent here, like the pinned 0.0.10.
    ...overrides,
  } as unknown as Bridge;
}

describe("createBridgeGate", () => {
  it("never blocks: calls resolve before any host exists", async () => {
    // A host that never arrives — the exact case that killed the phone UI.
    const gate = createBridgeGate(() => new Promise<Bridge>(() => {}), {
      timeoutMs: 10,
    });

    expect(gate.isReady()).toBe(false);
    // Each of these would previously have been unreachable code.
    await expect(gate.bridge.rebuildPageContainer({} as never)).resolves.toBe(
      false,
    );
    await expect(gate.bridge.getLocalStorage("k")).resolves.toBe(null);
    await expect(gate.bridge.setLocalStorage("k", "v")).resolves.toBe(false);
    await expect(gate.ready).resolves.toBe(null);
  });

  it("reports a startup-page failure rather than a false success", async () => {
    const gate = createBridgeGate(() => new Promise<Bridge>(() => {}), {
      timeoutMs: 10,
    });
    // 0 means success. Anything else routes boot down the "no glasses" branch,
    // so the placeholder must never answer 0.
    await expect(
      gate.bridge.createStartUpPageContainer({} as never),
    ).resolves.not.toBe(0);
  });

  it("returns a synchronous unsubscribe from onEvenHubEvent", () => {
    const gate = createBridgeGate(() => new Promise<Bridge>(() => {}), {
      timeoutMs: 10,
    });
    // Not a promise: callers store this and call it on SYSTEM_EXIT.
    const unsubscribe = gate.bridge.onEvenHubEvent(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does NOT invent methods the host lacks (geo.ts feature-detects them)", async () => {
    const gate = createBridgeGate(() => new Promise<Bridge>(() => {}), {
      timeoutMs: 10,
    });
    const probe = gate.bridge as unknown as Record<string, unknown>;
    // geo.ts decides between the bridge location source and WebView geolocation
    // with exactly this check. A blanket proxy would make it choose a source
    // that cannot deliver a single fix.
    expect(typeof probe.startAppLocationUpdates).not.toBe("function");
    expect(typeof probe.stopAppLocationUpdates).not.toBe("function");
    expect(typeof probe.onAppLocationChanged).not.toBe("function");
  });

  it("forwards to the host once it attaches", async () => {
    const host = fakeHost();
    const gate = createBridgeGate(async () => host);
    await gate.ready;

    expect(gate.isReady()).toBe(true);
    await expect(gate.bridge.rebuildPageContainer({} as never)).resolves.toBe(
      true,
    );
    await expect(gate.bridge.getLocalStorage("k")).resolves.toBe(
      '{"username":"real"}',
    );
    expect(host.rebuildPageContainer).toHaveBeenCalledOnce();
  });

  it("exposes the host's own methods once attached", async () => {
    const host = fakeHost({ startAppLocationUpdates: vi.fn(async () => true) });
    const gate = createBridgeGate(async () => host);
    await gate.ready;
    const probe = gate.bridge as unknown as Record<string, unknown>;
    // Same check as above, opposite verdict: a host that HAS the API must be
    // detected as having it.
    expect(typeof probe.startAppLocationUpdates).toBe("function");
  });

  it("runs onReady callbacks when the host attaches, and at once thereafter", async () => {
    let attach: (b: Bridge) => void = () => {};
    const host = fakeHost();
    const gate = createBridgeGate(
      () => new Promise<Bridge>((resolve) => { attach = resolve; }),
    );

    const early = vi.fn();
    gate.onReady(early);
    expect(early).not.toHaveBeenCalled();

    attach(host);
    await gate.ready;
    expect(early).toHaveBeenCalledOnce();

    // Registered after the fact: fires immediately rather than never.
    const late = vi.fn();
    gate.onReady(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("a throwing onReady callback does not strand the others", async () => {
    const host = fakeHost();
    const gate = createBridgeGate(async () => host);
    const boom = vi.fn(() => {
      throw new Error("consumer blew up");
    });
    const after = vi.fn();
    gate.onReady(boom);
    gate.onReady(after);
    await gate.ready;
    expect(boom).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
  });

  it("a late host still attaches after `ready` has reported none", async () => {
    let attach: (b: Bridge) => void = () => {};
    const host = fakeHost();
    const gate = createBridgeGate(
      () => new Promise<Bridge>((resolve) => { attach = resolve; }),
      { timeoutMs: 5 },
    );

    // The bounded wait gives up...
    await expect(gate.ready).resolves.toBe(null);
    expect(gate.isReady()).toBe(false);

    // ...but a host arriving afterwards is still honoured, so a slow phone
    // doesn't cost the user their glasses for the whole session.
    const cb = vi.fn();
    gate.onReady(cb);
    attach(host);
    await vi.waitFor(() => expect(gate.isReady()).toBe(true));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("survives the SDK promise rejecting, which it claims never to do", async () => {
    const gate = createBridgeGate(async () => {
      throw new Error("bridge exploded");
    });
    await expect(gate.ready).resolves.toBe(null);
    expect(gate.isReady()).toBe(false);
    // Still usable, still failing the way the host fails.
    await expect(gate.bridge.rebuildPageContainer({} as never)).resolves.toBe(
      false,
    );
  });
});
