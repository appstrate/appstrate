// SPDX-License-Identifier: Apache-2.0

import { afterAll } from "bun:test";

/** In-memory `Storage`, for suites whose stores read or write `localStorage`. */
class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

/**
 * Install a `localStorage` on `globalThis` — plus a `window` carrying it when
 * `windowExtras` is given — and restore the previous descriptors when the suite
 * ends, so the next suite in the process still sees the DOM-less environment
 * the harness promises.
 *
 * Call it at module top level, BEFORE the dynamic `await import(…)` of anything
 * that reads either at module init.
 */
export function installFakeStorage(windowExtras?: Record<string, unknown>): Storage {
  const storage = new FakeStorage();
  const previous: [string, PropertyDescriptor | undefined][] = [];
  const define = (name: string, value: unknown) => {
    previous.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };

  define("localStorage", storage);
  if (windowExtras) define("window", { ...windowExtras, localStorage: storage });

  afterAll(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  return storage;
}
