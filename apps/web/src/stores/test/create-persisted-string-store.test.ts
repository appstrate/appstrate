// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { createPersistedStringStore } from "../create-persisted-string-store.ts";

const storage = installFakeStorage();

const refuse = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("createPersistedStringStore", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    storage.clear();
  });

  it("starts from the stored id, writes a new one and removes it on null", () => {
    storage.setItem("t-org", "org_1");
    const store = createPersistedStringStore("t-org");
    expect(store.getState().id).toBe("org_1");

    store.getState().setId("org_2");
    expect(storage.getItem("t-org")).toBe("org_2");

    store.getState().setId(null);
    expect(store.getState().id).toBeNull();
    expect(storage.getItem("t-org")).toBeNull();
  });

  it("is created, and keeps the id for the tab, when every storage access throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: refuse, setItem: refuse, removeItem: refuse },
    });
    restore = () => Object.defineProperty(globalThis, "localStorage", descriptor);

    const store = createPersistedStringStore("t-org");
    expect(store.getState().id).toBeNull();
    expect(() => store.getState().setId("org_1")).not.toThrow();
    expect(store.getState().id).toBe("org_1");
    expect(() => store.getState().setId(null)).not.toThrow();
  });
});
