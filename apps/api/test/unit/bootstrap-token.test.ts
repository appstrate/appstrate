// SPDX-License-Identifier: Apache-2.0

// Pure-logic tests for the in-memory bootstrap-token state machine.
// DB-backed `isBootstrapTokenRedeemable` lives in the integration suite.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  _resetBootstrapTokenForTesting,
  isBootstrapTokenConfigured,
  isBootstrapTokenPending,
  markBootstrapTokenConsumed,
  releaseRedemption,
  tryAcquireRedemption,
  verifyBootstrapToken,
} from "../../src/lib/bootstrap-token.ts";

const SNAPSHOT = { AUTH_BOOTSTRAP_TOKEN: process.env.AUTH_BOOTSTRAP_TOKEN };

function setToken(value: string | undefined): void {
  if (value === undefined) delete process.env.AUTH_BOOTSTRAP_TOKEN;
  else process.env.AUTH_BOOTSTRAP_TOKEN = value;
  _resetCacheForTesting();
}

afterAll(() => {
  if (SNAPSHOT.AUTH_BOOTSTRAP_TOKEN === undefined) delete process.env.AUTH_BOOTSTRAP_TOKEN;
  else process.env.AUTH_BOOTSTRAP_TOKEN = SNAPSHOT.AUTH_BOOTSTRAP_TOKEN;
  _resetCacheForTesting();
  _resetBootstrapTokenForTesting();
});

describe("bootstrap-token state machine", () => {
  beforeEach(() => {
    _resetBootstrapTokenForTesting();
    setToken(undefined);
  });

  it("isConfigured reflects env var presence", () => {
    expect(isBootstrapTokenConfigured()).toBe(false);
    setToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk");
    expect(isBootstrapTokenConfigured()).toBe(true);
  });

  it("isPending mirrors isConfigured before any consume", () => {
    setToken("abcDEF123_-abcDEF123_-X");
    expect(isBootstrapTokenPending()).toBe(true);
  });

  it("isPending flips false after markConsumed (in-memory)", () => {
    setToken("abcDEF123_-abcDEF123_-X");
    markBootstrapTokenConsumed();
    expect(isBootstrapTokenPending()).toBe(false);
  });

  it("markConsumed is idempotent (no exceptions on second call)", () => {
    setToken("abcDEF123_-abcDEF123_-X");
    markBootstrapTokenConsumed();
    expect(() => markBootstrapTokenConsumed()).not.toThrow();
    expect(isBootstrapTokenPending()).toBe(false);
  });

  it("isPending stays false when env is unset, even if never consumed", () => {
    setToken(undefined);
    expect(isBootstrapTokenPending()).toBe(false);
  });

  it("_resetForTesting unflips the consumed flag (test seam only)", () => {
    setToken("abcDEF123_-abcDEF123_-X");
    markBootstrapTokenConsumed();
    expect(isBootstrapTokenPending()).toBe(false);
    _resetBootstrapTokenForTesting();
    expect(isBootstrapTokenPending()).toBe(true);
  });
});

describe("verifyBootstrapToken", () => {
  beforeEach(() => {
    _resetBootstrapTokenForTesting();
    setToken(undefined);
  });

  it("returns false when no env token is configured", () => {
    expect(verifyBootstrapToken("anything")).toBe(false);
  });

  it("returns true on exact byte match", () => {
    setToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk");
    expect(verifyBootstrapToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk")).toBe(true);
  });

  it("returns false on bytes mismatch (same length)", () => {
    setToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk");
    // Flip one char — same length so the timing-safe compare runs the
    // real branch, not the length-mismatch dummy.
    expect(verifyBootstrapToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRX")).toBe(false);
  });

  it("returns false on length mismatch (and does not throw)", () => {
    setToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk");
    expect(verifyBootstrapToken("short")).toBe(false);
    expect(verifyBootstrapToken("")).toBe(false);
    expect(verifyBootstrapToken("a".repeat(200))).toBe(false);
  });

  it("does not return true after consume (env still set)", () => {
    // verify() does not consult the consume flag; the route layer's
    // `isBootstrapTokenRedeemable` is the gate that combines both. This
    // test is here to lock down the invariant — verify() is a pure
    // string compare, nothing more.
    setToken("matchingMatchingMatching");
    markBootstrapTokenConsumed();
    expect(verifyBootstrapToken("matchingMatchingMatching")).toBe(true);
  });
});

// Audit fix: in-process compare-and-swap to serialize parallel redeem
// calls within the same Bun process. JS is single-threaded, so a CAS
// expressed as `if (!_inFlight) { _inFlight = true; }` is race-free
// at the language level — these tests pin the contract.
describe("tryAcquireRedemption / releaseRedemption", () => {
  beforeEach(() => {
    _resetBootstrapTokenForTesting();
    setToken("kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk");
  });

  it("first acquire wins, second observes the in-flight flag", () => {
    expect(tryAcquireRedemption()).toBe("acquired");
    expect(tryAcquireRedemption()).toBe("in_flight");
    releaseRedemption();
  });

  it("release re-opens the slot for a retry", () => {
    expect(tryAcquireRedemption()).toBe("acquired");
    releaseRedemption();
    expect(tryAcquireRedemption()).toBe("acquired");
    releaseRedemption();
  });

  it("markConsumed locks the slot permanently — subsequent acquires return 'consumed'", () => {
    expect(tryAcquireRedemption()).toBe("acquired");
    markBootstrapTokenConsumed();
    expect(tryAcquireRedemption()).toBe("consumed");
    // Even an explicit release does not re-open after consume.
    releaseRedemption();
    expect(tryAcquireRedemption()).toBe("consumed");
  });

  it("rejects acquire when the token has already been consumed", () => {
    markBootstrapTokenConsumed();
    expect(tryAcquireRedemption()).toBe("consumed");
  });
});
