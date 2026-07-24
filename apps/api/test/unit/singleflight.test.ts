// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock } from "bun:test";
import { singleflight } from "../../src/lib/singleflight.ts";

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleflight", () => {
  it("runs the work once and hands every concurrent caller the same result", async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    const gate = deferred<string>();
    const fn = mock(() => gate.promise);

    const a = singleflight(inFlight, "img", fn);
    const b = singleflight(inFlight, "img", fn);
    gate.resolve("pulled");

    expect(await a).toBe("pulled");
    expect(await b).toBe("pulled");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct keys independent", async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    const fn = mock((value: string) => Promise.resolve(value));

    const [a, b] = await Promise.all([
      singleflight(inFlight, "pi", () => fn("pi")),
      singleflight(inFlight, "sidecar", () => fn("sidecar")),
    ]);

    expect(a).toBe("pi");
    expect(b).toBe("sidecar");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("releases the key once settled so a later call does fresh work", async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    const fn = mock(() => Promise.resolve("ok"));

    await singleflight(inFlight, "img", fn);
    expect(inFlight.size).toBe(0);

    await singleflight(inFlight, "img", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every joined caller", async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    const gate = deferred<string>();
    const fn = mock(() => gate.promise);

    const a = singleflight(inFlight, "img", fn);
    const b = singleflight(inFlight, "img", fn);
    gate.reject(new Error("manifest unknown"));

    await expect(a).rejects.toThrow(/manifest unknown/);
    await expect(b).rejects.toThrow(/manifest unknown/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clears the key after a failure so the next caller can retry", async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    let calls = 0;
    const fn = mock(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("registry flake")) : Promise.resolve("ok");
    });

    await expect(singleflight(inFlight, "img", fn)).rejects.toThrow(/registry flake/);
    expect(inFlight.size).toBe(0);
    await expect(singleflight(inFlight, "img", fn)).resolves.toBe("ok");
  });
});
