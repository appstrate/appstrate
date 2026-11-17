// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's package-authoring switch, client side: a per-user preference,
 * on unless that user opted out. The gate itself is `agents:write`, dropped
 * from the turn's token server-side (`chat-stream-handler.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  bindPackageAuthoringUser,
  getPackageAuthoringEnabled,
  setPackageAuthoringEnabled,
  subscribePackageAuthoring,
} from "../src/ui/package-authoring-store.ts";

/** This runner has no `localStorage`; a Map-backed one stands in. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (
    globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }
  ).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return data;
}

beforeEach(() => bindPackageAuthoringUser(null));
afterEach(() => {
  bindPackageAuthoringUser(null);
  setPackageAuthoringEnabled(true);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the package-authoring preference", () => {
  it("is on by default", () => {
    expect(getPackageAuthoringEnabled()).toBe(true);
  });

  it("is kept per user: one account's choice never carries over to another", () => {
    installStorage();
    bindPackageAuthoringUser("usr_a");
    setPackageAuthoringEnabled(false);

    bindPackageAuthoringUser("usr_b");
    expect(getPackageAuthoringEnabled()).toBe(true);

    bindPackageAuthoringUser("usr_a");
    expect(getPackageAuthoringEnabled()).toBe(false);
  });

  it("persists nothing while no user is bound", () => {
    const data = installStorage();
    setPackageAuthoringEnabled(false);
    expect(data.size).toBe(0);
  });

  it("round-trips without storage at all", () => {
    expect(typeof localStorage).toBe("undefined");
    bindPackageAuthoringUser("usr_a");
    setPackageAuthoringEnabled(false);
    expect(getPackageAuthoringEnabled()).toBe(false);
  });

  it("notifies subscribers on a real change only", () => {
    let notifications = 0;
    const unsubscribe = subscribePackageAuthoring(() => {
      notifications += 1;
    });
    try {
      setPackageAuthoringEnabled(true);
      expect(notifications).toBe(0);
      setPackageAuthoringEnabled(false);
      expect(notifications).toBe(1);
      setPackageAuthoringEnabled(false);
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
