// SPDX-License-Identifier: Apache-2.0

/**
 * A browser preference is a convenience: a corrupt value or a storage that
 * refuses (blocked site data, a full quota) costs the preference, never the
 * click that changes it nor the module load that reads it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  LOCAL_STORAGE_KEYS,
  SESSION_STORAGE_KEYS,
  createLocalStore,
  flagCodec,
  jsonCodec,
  scalarCodec,
  storageKey,
  type LocalStorageEntry,
} from "../src/local-storage.ts";

const data = new Map<string, string>();
const memory = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => void data.set(key, value),
  removeItem: (key: string) => void data.delete(key),
};
const refuse = () => {
  throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
};
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const install = (value: unknown) =>
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value });

beforeEach(() => install(memory));
afterEach(() => {
  data.clear();
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const entry = (key: string, scope?: "user"): LocalStorageEntry => ({ zone: "web", key, scope });
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const notify = (key: string | null, area: unknown = memory) =>
  globalThis.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea: area }));

describe("the key inventory", () => {
  it("names every key appstrate:<zone>:<key>, once", () => {
    const keys = [...Object.values(LOCAL_STORAGE_KEYS), ...Object.values(SESSION_STORAGE_KEYS)];
    const stored = keys.map((e) => storageKey(e));
    expect(stored.every((key) => /^appstrate:(auth|chat|web):[A-Za-z]+$/.test(key))).toBe(true);
    expect(new Set(stored).size).toBe(stored.length);
  });

  it("appends a sub-key after the entry's key", () => {
    expect(storageKey(LOCAL_STORAGE_KEYS.sidebarTips, "usr_1")).toBe(
      "appstrate:web:sidebarTips:usr_1",
    );
  });
});

describe("createLocalStore", () => {
  it("reads back what it wrote, per sub-key", () => {
    const store = createLocalStore(
      entry("rw"),
      jsonCodec((v) => strings(v)),
    );
    store.write(["status"], "runs");
    expect(data.get("appstrate:web:rw:runs")).toBe('["status"]');
    expect(store.read("runs")).toEqual(["status"]);
    expect(store.read("other")).toEqual([]);
  });

  it("reads a value that is not JSON, or of the wrong shape, through the parser's null", () => {
    const store = createLocalStore(
      entry("bad"),
      jsonCodec((v) => strings(v)),
    );
    data.set("appstrate:web:bad:a", "[not json");
    data.set("appstrate:web:bad:b", '{"status":true}');
    expect(store.read("a")).toEqual([]);
    expect(store.read("b")).toEqual([]);
  });

  it("answers an unreadable value with the supplied fallback", () => {
    const store = createLocalStore(
      entry("unreadable"),
      jsonCodec(
        (v) => (v === null ? "absent" : String(v)),
        () => "broken",
      ),
    );
    expect(store.read()).toBe("absent");
    data.set("appstrate:web:unreadable", "{nope");
    expect(store.read()).toBe("broken");
  });

  it("writes a scalar as a string and removes the key on null", () => {
    const store = createLocalStore(
      entry("id"),
      scalarCodec<string | null>((raw) => raw),
    );
    store.write("org_1");
    expect(data.get("appstrate:web:id")).toBe("org_1");
    store.write(null);
    expect(data.has("appstrate:web:id")).toBe(false);
  });

  it("stores only a flag's departure from its default", () => {
    const store = createLocalStore(entry("flag"), flagCodec(true));
    expect(store.read()).toBe(true);
    store.write(false);
    expect(data.get("appstrate:web:flag")).toBe("off");
    store.write(true);
    expect(data.size).toBe(0);
  });

  it("notifies subscribers on a write, and again after another tab changes the key", () => {
    const store = createLocalStore(
      entry("tab"),
      jsonCodec((v) => strings(v)),
    );
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.write(["a"], "runs");
    expect(calls).toBe(1);
    notify("unrelated");
    notify("appstrate:web:tab:runs", {});
    expect(calls).toBe(1);
    data.set("appstrate:web:tab:runs", '["b"]');
    notify("appstrate:web:tab:runs");
    expect(calls).toBe(2);
    expect(store.read("runs")).toEqual(["b"]);
    notify(null);
    expect(calls).toBe(3);
    unsubscribe();
    store.write(["c"], "runs");
    expect(calls).toBe(3);
  });

  it("scopes a user entry to the bound user, and persists nothing while unbound", () => {
    const store = createLocalStore(entry("user", "user"), flagCodec(true));
    store.write(false);
    expect(data.size).toBe(0);
    expect(store.read()).toBe(false);

    store.bind("usr_a");
    expect(store.read()).toBe(true);
    store.write(false);
    expect(data.get("appstrate:web:user:usr_a")).toBe("off");

    store.bind("usr_b");
    expect(store.read()).toBe(true);
    store.bind("usr_a");
    expect(store.read()).toBe(false);
    store.bind(null);
    expect(store.read()).toBe(true);
  });

  it("costs the preference, never the call, when storage refuses", () => {
    const store = createLocalStore(
      entry("blocked"),
      jsonCodec((v) => strings(v)),
    );
    install({ getItem: refuse, setItem: refuse, removeItem: refuse });
    expect(store.read("runs")).toEqual([]);
    expect(() => store.write(["status"], "runs")).not.toThrow();
    expect(store.read("runs")).toEqual(["status"]);
  });

  it("does not notify when a write changes nothing", () => {
    const store = createLocalStore(entry("same"), flagCodec(true));
    let calls = 0;
    store.subscribe(() => calls++);
    store.write(true);
    store.write(false);
    store.write(false);
    expect(calls).toBe(1);
  });
});
