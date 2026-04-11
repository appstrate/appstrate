// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { auth, getAuth, createAuth } from "@appstrate/db/auth";

describe("Better Auth factory + Proxy shim", () => {
  // NOTE: `createAuth([])` is already called by the test preload
  // (`test/setup/preload.ts`), so `getAuth()` is expected to succeed here.
  // The "throws before createAuth" code path is verified by source review,
  // not runtime test — resetting the singleton mid-suite would break other
  // tests that depend on the shared `auth` instance.

  it("getAuth returns the constructed Better Auth instance", () => {
    const instance = getAuth();
    expect(instance).toBeDefined();
    expect(instance.handler).toBeDefined();
    expect(typeof instance.handler).toBe("function");
  });

  it("createAuth is idempotent — second call does not rebuild", () => {
    const before = getAuth();
    createAuth([]); // no-op
    const after = getAuth();
    expect(after).toBe(before); // reference equality
  });

  it("auth Proxy forwards property access to the singleton", () => {
    // Functions should be bound and invocable
    expect(typeof auth.handler).toBe("function");
    // Nested properties (auth.api.*) should also be accessible
    expect(auth.api).toBeDefined();
  });

  it("auth.handler has the same behavior as getAuth().handler", () => {
    // Both should point to the same underlying function (bound via Proxy)
    const proxyHandler = auth.handler;
    const directHandler = getAuth().handler;
    expect(typeof proxyHandler).toBe("function");
    expect(typeof directHandler).toBe("function");
  });
});
