// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { createStore } from "zustand/vanilla";
import { persistedScalar } from "../persisted-scalar-store.ts";

const storage = installFakeStorage();

const refuse = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("persistedScalar for an id", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    storage.clear();
  });

  it("starts from the stored id, writes a new one and removes it on null", () => {
    storage.setItem("t-org", "org_1");
    const store = createStore(persistedScalar("t-org", (raw) => raw, "id", "setId"));
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

    const store = createStore(persistedScalar("t-org", (raw) => raw, "id", "setId"));
    expect(store.getState().id).toBeNull();
    expect(() => store.getState().setId("org_1")).not.toThrow();
    expect(store.getState().id).toBe("org_1");
    expect(() => store.getState().setId(null)).not.toThrow();
  });
});

describe("persistedScalar", () => {
  afterEach(() => storage.clear());

  it("names its field and setter, and parses what is stored", () => {
    storage.setItem("t-open", "false");
    const open = (raw: string | null) => raw !== "false";
    const store = createStore(persistedScalar("t-open", open, "open", "setOpen"));
    expect(store.getState().open).toBe(false);

    store.getState().setOpen(true);
    expect(store.getState().open).toBe(true);
    expect(storage.getItem("t-open")).toBe("true");
  });

  it("reads the parser's default when nothing is stored", () => {
    const view = (raw: string | null) => (raw === "cards" ? "cards" : "table");
    const store = createStore(persistedScalar("t-view", view, "view", "setView"));
    expect(store.getState().view).toBe("table");
  });
});
