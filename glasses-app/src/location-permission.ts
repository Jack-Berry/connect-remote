/**
 * Telling "the permission dialog is still waiting" apart from "a fix is merely
 * still coming" — the fix for the field-tested stuck state.
 *
 * Field evidence: fresh store install, finder started from the glasses with the
 * phone pocketed → iOS drew the location prompt on the *locked* screen where
 * nobody saw it, and the glasses sat on "Locating…" forever. The honest screen
 * is "Unlock your phone to allow location access", but the WebView never tells
 * us a dialog is open, so we infer it from two independent signals:
 *
 *  1. `navigator.permissions.query({name:'geolocation'})` — when the WebView
 *     honours it, `state === "prompt"` is ground truth that the dialog is
 *     pending. Whether the Even WebView implements it at all is UNVERIFIED
 *     (the Stage 0 probe never tested it), so it is opportunistic: any
 *     throw / absence / "unknown" falls through to (2).
 *  2. A persisted "granted at least once" flag in bridge KV. On the very first
 *     run it is absent, so "watch started + no fix + no error + never granted"
 *     is the heuristic that the user simply hasn't answered the prompt yet.
 *     Once the first fix lands we set the flag, and every later run trusts it —
 *     a slow fix on a since-granted phone reads as "Locating…", not a lie about
 *     a dialog that isn't there.
 *
 * Everything here is pure or injectable so the decision is unit-tested without
 * a WebView, a real `navigator`, or the bridge.
 */

import type { FinderProblem } from "./finder";

/** Bridge KV surface this module needs — structural so tests fake it and
 *  main.ts hands over the real EvenAppBridge as-is (same two methods
 *  settings.ts uses for durable storage; localStorage is unreliable here). */
export interface KvStore {
  getLocalStorage(key: string): Promise<string | null>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

/** `navigator.permissions` outcome, plus "unknown" for the (likely) case that
 *  the Even WebView doesn't implement the Permissions API. */
export type PermissionProbe = "granted" | "denied" | "prompt" | "unknown";

/** Deliberately its own key, not a field in the user's AppSettings: this is an
 *  app-lifecycle marker, not a preference, and must never ride along in a
 *  settings save the user triggered. Renaming it just re-arms the first-run
 *  flow once (harmless). */
const GRANTED_ONCE_KEY = "connect-remote.locationGrantedOnce";

/** Has location been granted on this install before? Any read failure is
 *  treated as "no" — the first-run flow showing once too often is a far
 *  smaller sin than suppressing it when it's genuinely needed. */
export async function loadGrantedOnce(kv: KvStore): Promise<boolean> {
  try {
    return (await kv.getLocalStorage(GRANTED_ONCE_KEY)) === "1";
  } catch (err) {
    console.warn("finder: could not read location-granted flag", err);
    return false;
  }
}

/** Persist that location has now been granted (called on the first usable
 *  fix). Best-effort: a failed write only costs one extra walkthrough. */
export async function saveGrantedOnce(kv: KvStore): Promise<void> {
  try {
    await kv.setLocalStorage(GRANTED_ONCE_KEY, "1");
  } catch (err) {
    console.warn("finder: could not persist location-granted flag", err);
  }
}

/**
 * Best-effort read of the geolocation permission. Returns "unknown" for every
 * way the WebView can decline to answer — no Permissions API, an unsupported
 * `geolocation` name, or a throw — so the caller's heuristic takes over.
 */
export async function probePermission(
  nav: Pick<Navigator, "permissions"> = navigator,
): Promise<PermissionProbe> {
  try {
    const perms = nav.permissions;
    if (!perms || typeof perms.query !== "function") return "unknown";
    const status = await perms.query({
      name: "geolocation" as PermissionName,
    });
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt"
      ? state
      : "unknown";
  } catch {
    return "unknown";
  }
}

export interface AwaitingInput {
  /** A usable fix has arrived — ground truth that permission is granted. */
  hasFix: boolean;
  /** A hard problem from the watch (denied/unavailable/no-car) — outranks any
   *  guess about a pending dialog. */
  problem: FinderProblem | null;
  /** The persisted first-run marker. */
  grantedOnce: boolean;
  /** Latest `probePermission` result; "unknown" when the API is unavailable. */
  permission: PermissionProbe;
  /** The position watch has actually been started (we've asked the platform).
   *  Before that there is no dialog to be waiting on. */
  watchStarted: boolean;
}

/**
 * The single decision, pure. True ⇒ render "Unlock your phone…" instead of
 * "Locating…".
 */
export function isAwaitingPermission(input: AwaitingInput): boolean {
  const { hasFix, problem, grantedOnce, permission, watchStarted } = input;
  // Ground truth beats every heuristic below.
  if (hasFix || problem) return false;
  // Haven't asked the platform yet ⇒ nothing is waiting.
  if (!watchStarted) return false;
  // The API, when it works, is authoritative.
  if (permission === "prompt") return true;
  if (permission === "granted" || permission === "denied") return false;
  // API silent (the expected WebView case): first run only.
  return !grantedOnce;
}
