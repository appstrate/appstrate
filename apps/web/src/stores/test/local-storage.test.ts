// SPDX-License-Identifier: Apache-2.0

/**
 * A browser preference is a convenience: a corrupt value or a storage that
 * refuses (blocked site data, a full quota) costs the preference, never the
 * click that changes it nor the module load that reads it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { createKeyedLocalStore, persistedJson, persistedValue } from "../local-storage.ts";

const storage = installFakeStorage();

const refuse = () => {
  throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
};

/** Every access to `localStorage` throws, as in a sandboxed frame. */
function blockStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: refuse, setItem: refuse, removeItem: refuse },
  });
  return () => Object.defineProperty(globalThis, "localStorage", descriptor);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

describe("createKeyedLocalStore", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    storage.clear();
  });

  it("reads back what it wrote, under its prefix", () => {
    const store = createKeyedLocalStore("t-rw-", strings, []);
    store.write("runs", ["status"]);
    expect(storage.getItem("t-rw-runs")).toBe('["status"]');
    expect(createKeyedLocalStore("t-rw-", strings, []).read("runs")).toEqual(["status"]);
  });

  it("reads a value that is not JSON as empty", () => {
    storage.setItem("t-corrupt-runs", "[not json");
    const empty: string[] = [];
    expect(createKeyedLocalStore("t-corrupt-", strings, empty).read("runs")).toBe(empty);
  });

  it("reads a value of the wrong shape through its parser", () => {
    storage.setItem("t-shape-runs", '{"status":true}');
    expect(createKeyedLocalStore("t-shape-", strings, []).read("runs")).toEqual([]);
  });

  it("keeps a write for the session when storage refuses it", () => {
    const store = createKeyedLocalStore("t-blocked-", strings, []);
    restore = blockStorage();
    expect(store.read("runs")).toEqual([]);
    expect(() => store.write("runs", ["status"])).not.toThrow();
    expect(store.read("runs")).toEqual(["status"]);
  });
});

describe("persistedValue", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    storage.clear();
  });

  const view = (raw: string | null) => (raw === "cards" ? "cards" : "table");

  it("parses what is stored, and what is not", () => {
    storage.setItem("t-view", "cards");
    expect(persistedValue("t-view", view).read()).toBe("cards");
    storage.setItem("t-view", "garbage");
    expect(persistedValue("t-view", view).read()).toBe("table");
  });

  it("writes the value as a string", () => {
    persistedValue("t-open", (raw) => raw !== "false").write(false);
    expect(storage.getItem("t-open")).toBe("false");
  });

  it("removes the key when written null", () => {
    storage.setItem("t-id", "org_1");
    persistedValue("t-id", (raw) => raw).write(null);
    expect(storage.getItem("t-id")).toBeNull();
  });

  it("falls back to the parser's default, and writes nothing, when storage refuses", () => {
    restore = blockStorage();
    const value = persistedValue("t-view", view);
    expect(value.read()).toBe("table");
    expect(() => value.write("cards")).not.toThrow();
  });
});

describe("persistedJson", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    storage.clear();
  });

  const list = (value: unknown) => strings(value);

  it("round-trips a JSON value and removes the key when written null", () => {
    const value = persistedJson<string[]>("t-list", list);
    value.write(["a", "b"]);
    expect(storage.getItem("t-list")).toBe('["a","b"]');
    expect(value.read()).toEqual(["a", "b"]);
    value.write(null);
    expect(storage.getItem("t-list")).toBeNull();
  });

  it("hands absent and unparseable values to the parser as null", () => {
    const seen: unknown[] = [];
    const value = persistedJson("t-raw", (raw) => {
      seen.push(raw);
      return raw;
    });
    value.read();
    storage.setItem("t-raw", "{not json");
    value.read();
    expect(seen).toEqual([null, null]);
  });

  it("falls back to the parser's default, and writes nothing, when storage refuses", () => {
    restore = blockStorage();
    const value = persistedJson<string[]>("t-list", list);
    expect(value.read()).toEqual([]);
    expect(() => value.write(["a"])).not.toThrow();
  });
});
