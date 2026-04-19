// SPDX-License-Identifier: Apache-2.0

/**
 * Guard test for the AsyncLocalStorage-based social override.
 *
 * Two concurrent "requests" each run inside their own async context (via
 * `AsyncLocalStorage.run`, which is how Bun/Node wraps HTTP handlers) and
 * each set a different per-app override. The test asserts that reads inside
 * one context never see the other's override, even when the two contexts
 * interleave their awaits.
 *
 * This is the regression guard for the concern raised during PR review:
 * `enterWith` + BA's lazy getters could, in theory, leak credentials across
 * requests if contexts were reused. The test proves the isolation holds as
 * long as each request has a distinct async root.
 */

import { describe, it, expect } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { enterSocialOverride, getSocialOverride } from "@appstrate/db/auth";

describe("social override isolation", () => {
  it("per-request enterWith does not leak between concurrent async contexts", async () => {
    const requestRoot = new AsyncLocalStorage<string>();

    async function simulateRequest(
      tag: string,
      creds: { clientId: string; clientSecret: string },
    ): Promise<{ tag: string; seen: string | undefined }> {
      return requestRoot.run(tag, async () => {
        enterSocialOverride({ google: creds });
        // Interleave with another microtask boundary to exercise the worst
        // case — without proper per-request scoping, one request's override
        // would bleed into the other here.
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 5));
        const seen = getSocialOverride()?.google?.clientId;
        return { tag, seen };
      });
    }

    const [a, b] = await Promise.all([
      simulateRequest("A", { clientId: "app-a.client", clientSecret: "secret-a" }),
      simulateRequest("B", { clientId: "app-b.client", clientSecret: "secret-b" }),
    ]);

    expect(a.seen).toBe("app-a.client");
    expect(b.seen).toBe("app-b.client");
  });

  it("getSocialOverride returns undefined outside any request context", () => {
    // Fresh top-level call — no BA `before` hook has run, so no store is set.
    // If a prior test leaked state globally, this assertion would fail.
    expect(getSocialOverride()).toBeUndefined();
  });
});
