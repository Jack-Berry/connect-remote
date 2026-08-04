/**
 * The host-bridge gate — what the app uses instead of awaiting the bridge.
 *
 * WHY THIS MODULE EXISTS: `waitForEvenAppBridge()` resolves only once the host
 * injects `window.evenAppBridge` and marks it ready. It has **no timeout and no
 * reject path** — read the SDK bundle if you doubt it. `main.ts` awaited it at
 * module top level, so on any host that never injected the bridge the *entire
 * module body* never ran: no `bindPhoneUi()`, no `bindPhoneFinder()`, no
 * listeners at all. The phone settings page still rendered (it is static HTML),
 * so the failure looked like "the Find my car button does nothing" rather than
 * "the app never booted". Every button on that page was equally dead, including
 * "Copy diagnostic report" — which is why five hardware rounds produced no
 * report to read.
 *
 * The gate inverts that. The module body never blocks: it gets a bridge object
 * immediately, and glasses work is scheduled through `onReady` for whenever (or
 * whether) the host turns up. Two rules make the placeholder safe:
 *
 *  1. **Calls fail the way the host fails.** These APIs report failure in the
 *     RESOLVED value, never by rejecting (see `recordHostOp` in main.ts), so the
 *     placeholder resolves the host's own failure encodings — `false` for a
 *     rebuild, `1` (invalid) for a startup page, `3` (sendFailed) for an image
 *     push. Existing call sites detect a missing host through the code path
 *     they already have for a refusing one; nothing hangs, nothing throws.
 *  2. **It never invents a method it doesn't have.** `geo.ts` feature-detects
 *     the App Location API with `typeof bridge.startAppLocationUpdates ===
 *     "function"` (SDK 0.0.10 has no such method). A blanket proxy answering
 *     every property with a function would make that check lie, so unknown
 *     properties read as `undefined` until a real host is attached.
 */

import type { Bridge } from "./settings";

/**
 * What each call answers while no host is attached, in the host's own failure
 * encoding. Deliberately NOT a catch-all: a name absent from this table reads
 * as `undefined`, which is what keeps feature detection honest (rule 2 above).
 *
 * The App Location methods are omitted for exactly that reason — a disconnected
 * gate must look like the SDK 0.0.10 host that genuinely lacks them, not like
 * one whose calls merely fail.
 */
const NO_HOST: Record<string, () => unknown> = {
  // 0 = success; 1 = invalid. Anything non-zero routes main.ts's boot down the
  // "no glasses page" branch.
  createStartUpPageContainer: () => Promise.resolve(1),
  rebuildPageContainer: () => Promise.resolve(false),
  textContainerUpgrade: () => Promise.resolve(false),
  // 3 = sendFailed, so `ImageRawDataUpdateResult.isSuccess` is false and
  // `pushImage` throws into its glyph fallback exactly as on a refusing host.
  updateImageRawData: () => Promise.resolve(3),
  // No host, no storage. `loadSettings` reads null as "nothing saved" and
  // returns defaults; `saveSettings` reports false so the phone's Save button
  // can say so out loud instead of silently dropping the user's credentials.
  getLocalStorage: () => Promise.resolve(null),
  setLocalStorage: () => Promise.resolve(false),
  shutDownPageContainer: () => Promise.resolve(undefined),
  // Subscription APIs return their unsubscribe function synchronously.
  onEvenHubEvent: () => () => {},
};

export interface BridgeGate {
  /** Safe to call from the first line of the module: forwards to the host once
   *  it lands, fails fast (never hangs) until then. */
  bridge: Bridge;
  /** True once a real host bridge is attached. */
  isReady(): boolean;
  /**
   * Run `cb` when the host bridge attaches — immediately if it already has,
   * never if it never does. This is where glasses-only work belongs; anything
   * the phone screen needs must run outside it.
   */
  onReady(cb: (bridge: Bridge) => void): void;
  /**
   * The bounded wait, for diagnostics and tests: resolves with the host bridge,
   * or `null` if it hasn't arrived within `timeoutMs`. Resolving `null` does not
   * cancel anything — a late host still attaches and still fires `onReady`.
   */
  ready: Promise<Bridge | null>;
}

/** How long `ready` waits before reporting "no host" — long enough for a slow
 *  injection, short enough that a diagnostic report doesn't sit on it. Nothing
 *  user-visible blocks on this; it only decides when the gate says so. */
export const BRIDGE_WAIT_MS = 5000;

export function createBridgeGate(
  wait: () => Promise<Bridge>,
  opts: { timeoutMs?: number } = {},
): BridgeGate {
  const timeoutMs = opts.timeoutMs ?? BRIDGE_WAIT_MS;
  let host: Bridge | null = null;
  const pending: ((bridge: Bridge) => void)[] = [];

  const bridge = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (host) {
          // Forward to the real thing. Non-function properties (the SDK's
          // `ready` getter) pass through untouched; methods are bound so `this`
          // survives the hop.
          const value = (host as unknown as Record<string, unknown>)[prop];
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(host)
            : value;
        }
        const fallback = NO_HOST[prop];
        // Unknown property with no host: `undefined`, not a function. See rule 2.
        return fallback ? () => fallback() : undefined;
      },
      // Keep `in` and feature detection consistent with `get`.
      has(_target, prop: string) {
        return host ? prop in (host as unknown as object) : prop in NO_HOST;
      },
    },
  ) as unknown as Bridge;

  const attach = (real: Bridge) => {
    if (host) return;
    host = real;
    // Copied first: a callback that schedules more work must not mutate the
    // list we are walking.
    const waiting = pending.splice(0, pending.length);
    for (const cb of waiting) {
      try {
        cb(real);
      } catch (err) {
        // One bad consumer must not strand the others — and must not become an
        // unhandled rejection that takes the phone UI down with it.
        console.error("bridge gate: onReady callback threw", err);
      }
    }
  };

  // The SDK promise is unbounded by design; this is the only place that awaits
  // it, and nothing user-visible is downstream of the await.
  const arrival = wait().then(
    (real) => {
      attach(real);
      return real;
    },
    (err) => {
      // Documented as never rejecting — but "documented" is not "observed", and
      // a rejection here must not become an unhandled one.
      console.error("bridge gate: waitForEvenAppBridge rejected", err);
      return null;
    },
  );

  const ready = Promise.race([
    arrival,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]).then((real) => real ?? null);

  return {
    bridge,
    isReady: () => host != null,
    onReady(cb) {
      if (host) cb(host);
      else pending.push(cb);
    },
    ready,
  };
}
