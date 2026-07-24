/** Awaiting-permission detection and the granted-once marker.
 *
 *  The one thing these tests protect: a first-run phone with the prompt open
 *  behind a locked screen must read as "unlock your phone", and a since-granted
 *  phone that's merely slow to fix must NOT — the difference between an honest
 *  instruction and crying wolf on every entry.
 */

import { describe, expect, it } from "vitest";

import {
  type KvStore,
  type PermissionProbe,
  isAwaitingPermission,
  loadGrantedOnce,
  probePermission,
  saveGrantedOnce,
} from "./location-permission";

function fakeKv(initial: Record<string, string> = {}): KvStore & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getLocalStorage: async (k) => (k in store ? store[k] : null),
    setLocalStorage: async (k, v) => {
      store[k] = v;
      return true;
    },
  };
}

describe("granted-once flag", () => {
  it("round-trips through the KV store", async () => {
    const kv = fakeKv();
    expect(await loadGrantedOnce(kv)).toBe(false);
    await saveGrantedOnce(kv);
    expect(await loadGrantedOnce(kv)).toBe(true);
  });

  it("treats a read failure as not-yet-granted", async () => {
    const kv: KvStore = {
      getLocalStorage: async () => {
        throw new Error("bridge asleep");
      },
      setLocalStorage: async () => true,
    };
    expect(await loadGrantedOnce(kv)).toBe(false);
  });

  it("swallows a write failure — one extra walkthrough, never a crash", async () => {
    const kv: KvStore = {
      getLocalStorage: async () => null,
      setLocalStorage: async () => {
        throw new Error("bridge asleep");
      },
    };
    await expect(saveGrantedOnce(kv)).resolves.toBeUndefined();
  });
});

describe("probePermission", () => {
  it("returns the API's state when it answers", async () => {
    const nav = {
      permissions: { query: async () => ({ state: "prompt" }) },
    } as unknown as Navigator;
    expect(await probePermission(nav)).toBe("prompt");
  });

  it("returns 'unknown' when the WebView has no Permissions API", async () => {
    expect(await probePermission({ permissions: undefined } as never)).toBe(
      "unknown",
    );
  });

  it("returns 'unknown' when the query throws (unsupported name)", async () => {
    const nav = {
      permissions: {
        query: async () => {
          throw new Error("geolocation not a recognised permission");
        },
      },
    } as unknown as Navigator;
    expect(await probePermission(nav)).toBe("unknown");
  });

  it("maps an unrecognised state to 'unknown' rather than trusting it", async () => {
    const nav = {
      permissions: { query: async () => ({ state: "weird" }) },
    } as unknown as Navigator;
    expect(await probePermission(nav)).toBe("unknown");
  });
});

describe("isAwaitingPermission", () => {
  const base = {
    hasFix: false,
    problem: null,
    grantedOnce: false,
    permission: "unknown" as PermissionProbe,
    watchStarted: true,
  };

  it("waits on the first run when the API is silent and nothing granted yet", () => {
    expect(isAwaitingPermission(base)).toBe(true);
  });

  it("does not wait before the watch has even started", () => {
    expect(isAwaitingPermission({ ...base, watchStarted: false })).toBe(false);
  });

  it("stops waiting once a fix proves permission was granted", () => {
    expect(isAwaitingPermission({ ...base, hasFix: true })).toBe(false);
  });

  it("stops waiting once the phone has been granted before", () => {
    // Since-granted but slow to fix ⇒ honest "Locating…", never a false alarm.
    expect(isAwaitingPermission({ ...base, grantedOnce: true })).toBe(false);
  });

  it("trusts the API's 'prompt' even on a phone granted before", () => {
    expect(
      isAwaitingPermission({
        ...base,
        grantedOnce: true,
        permission: "prompt",
      }),
    ).toBe(true);
  });

  it("does not wait when the API reports already granted", () => {
    expect(isAwaitingPermission({ ...base, permission: "granted" })).toBe(false);
  });

  it("lets a hard problem outrank the guess", () => {
    expect(isAwaitingPermission({ ...base, problem: "denied" })).toBe(false);
    expect(isAwaitingPermission({ ...base, problem: "unavailable" })).toBe(
      false,
    );
  });
});
