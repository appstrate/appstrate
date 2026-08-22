// SPDX-License-Identifier: Apache-2.0

/**
 * Unit half of the request-side scope alias (#1177). The end-to-end claim —
 * that a client still sending `documents:read` is not refused at
 * `/oauth2/authorize` — lives in
 * `test/integration/services/oauth-legacy-scope-compat.test.ts`; this pins the
 * three edges that integration test cannot express cheaply.
 */

import { describe, it, expect } from "bun:test";
import { canonicalizeScopeParam, canonicalizeScopes } from "../../auth/scopes.ts";

describe("canonicalizeScopeParam", () => {
  it("returns null when nothing needs rewriting", () => {
    // The overwhelmingly common case. Returning null is what lets the hook
    // leave the request context untouched instead of rebuilding it per call.
    expect(canonicalizeScopeParam("openid profile files:read")).toBeNull();
    expect(canonicalizeScopeParam("")).toBeNull();
    expect(canonicalizeScopeParam(undefined)).toBeNull();
  });

  it("rewrites a retired resource spelling in place", () => {
    expect(canonicalizeScopeParam("openid documents:read")).toBe("openid files:read");
    expect(canonicalizeScopeParam("documents:delete")).toBe("files:delete");
  });

  it("collapses a client that sends BOTH spellings into one scope", () => {
    // A client hedging across the rename would otherwise get `files:read`
    // twice in the granted scope string.
    expect(canonicalizeScopeParam("documents:read files:read")).toBe("files:read");
    expect(canonicalizeScopeParam("files:read documents:read")).toBe("files:read");
  });

  it("passes an unknown scope through unchanged so the plugin still rejects it", () => {
    // This canonicalizes; it must never widen. `superadmin:*` has to reach
    // Better Auth's own filter intact and be refused there.
    expect(canonicalizeScopeParam("openid superadmin:*")).toBeNull();
    expect(canonicalizeScopes(["openid", "superadmin:*"])).toEqual(["openid", "superadmin:*"]);
  });
});
