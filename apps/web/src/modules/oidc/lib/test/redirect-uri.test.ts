// SPDX-License-Identifier: Apache-2.0

/**
 * The form pre-check must never be stricter than the API validator
 * (`apps/api/src/modules/oidc/services/redirect-uri.ts`). #1012: the dashboard
 * form used to require the literal hostname `localhost`, so a native/CLI
 * client with `http://127.0.0.1/callback` was blocked in the UI even once the
 * API accepted it.
 */

import { describe, it, expect } from "bun:test";
import { looksLoopback } from "../redirect-uri";

describe("looksLoopback", () => {
  it("accepts every loopback form the API accepts", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "tenant.localhost",
      "127.0.0.1",
      "127.5.6.7",
      "[::1]",
      "::1",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
    ]) {
      expect(looksLoopback(host)).toBe(true);
    }
  });

  it("rejects hosts that only look loopback", () => {
    for (const host of [
      "example.com",
      "127.example.com",
      "localhost.evil.com",
      "10.0.0.1",
      "128.0.0.1",
      "169.254.169.254",
      "[::]",
    ]) {
      expect(looksLoopback(host)).toBe(false);
    }
  });
});
