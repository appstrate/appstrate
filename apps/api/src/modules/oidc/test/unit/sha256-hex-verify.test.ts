// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `sha256HexVerify` — the constant-time client-secret
 * comparator used by the Better Auth oauth-provider plugin.
 *
 * Coverage focuses on the runtime invariants added on top of
 * `crypto.timingSafeEqual`: both the computed and stored hashes MUST be
 * 64-character SHA-256 hex strings. A drift in either side is a deny-all
 * footgun that must NOT be silent — see the rationale in plugins.ts.
 *
 * The "computed.length wrong" case is intentionally not covered here:
 * it would require stubbing `hashSecret` (which lives in a sibling
 * module imported at top level), and `mock.module()` is banned per the
 * codebase mocking policy. The invariant is documented inline in
 * plugins.ts and is reachable in production only via an algorithm-drift
 * bug — covered by code review + the runtime `logger.error` audit event.
 */

import { describe, it, expect } from "bun:test";
import { sha256HexVerify } from "../../auth/plugins.ts";
import { hashSecret } from "../../services/oauth-admin.ts";

describe("sha256HexVerify", () => {
  it("returns true for a matching hash (happy path)", async () => {
    const secret = "correct-horse-battery-staple";
    const stored = await hashSecret(secret);
    expect(stored.length).toBe(64);
    expect(await sha256HexVerify(secret, stored)).toBe(true);
  });

  it("returns false for a non-matching hash of correct length", async () => {
    const stored = await hashSecret("the-real-secret");
    // Wrong secret, but stored hash is a valid 64-char SHA-256 hex.
    expect(await sha256HexVerify("not-the-secret", stored)).toBe(false);
  });

  it("returns false (without throwing) when storedHash is too short", async () => {
    // 32 hex chars — half a SHA-256 digest. Could happen via a corrupt
    // row or mid-migration truncation. Must reject the verification but
    // not take down the token path.
    const truncated = "a".repeat(32);
    expect(await sha256HexVerify("any-secret", truncated)).toBe(false);
  });

  it("returns false (without throwing) when storedHash is too long", async () => {
    // 128 hex chars — looks like SHA-512 output. Rejects without throwing
    // because this is a data-level issue, not a code-level invariant.
    const tooLong = "a".repeat(128);
    expect(await sha256HexVerify("any-secret", tooLong)).toBe(false);
  });

  it("returns false (without throwing) when storedHash is empty", async () => {
    expect(await sha256HexVerify("any-secret", "")).toBe(false);
  });
});
