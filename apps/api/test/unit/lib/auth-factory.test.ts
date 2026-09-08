// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { getAuth, createAuth } from "@appstrate/db/auth";
import { betterAuthRateLimitStorage } from "../../../src/infra/rate-limit/better-auth-storage.ts";
import { CLIENT_IP_HEADER } from "../../../src/lib/client-ip.ts";

describe("Better Auth factory", () => {
  // NOTE: `createAuth()` is already called by the test preload
  // (`test/setup/preload.ts`), so `getAuth()` is expected to succeed here.

  it("getAuth returns the constructed Better Auth instance", () => {
    const instance = getAuth();
    expect(instance).toBeDefined();
    expect(instance.handler).toBeDefined();
    expect(typeof instance.handler).toBe("function");
  });

  it("createAuth is idempotent — second call does not rebuild", () => {
    const before = getAuth();
    createAuth({
      plugins: () => [],
      rateLimitStorage: betterAuthRateLimitStorage(),
      clientIpHeader: CLIENT_IP_HEADER,
    }); // no-op
    const after = getAuth();
    expect(after).toBe(before); // reference equality
  });
});
