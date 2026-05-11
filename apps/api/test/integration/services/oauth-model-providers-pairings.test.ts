// SPDX-License-Identifier: Apache-2.0

/**
 * `pairings` service — single-use pairing token lifecycle.
 *
 * The single-statement UPDATE in `consumePairing()` is what guarantees
 * one-shot semantics under concurrent retries; the concurrent test below
 * locks that contract in (a regression to a SELECT-then-UPDATE pair would
 * let two callers both succeed and both receive the same minted credentials
 * downstream — an authentication bypass).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg, type TestOrg } from "../../helpers/auth.ts";
import {
  cleanupExpiredPairings,
  consumePairing,
  createPairing,
  getPairing,
} from "../../../src/services/oauth-model-providers/pairings.ts";
import { hashPairingSecret } from "@appstrate/connect-helper/pairing-token";
import { modelProviderPairings } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { ApiError } from "../../../src/lib/errors.ts";

interface Fixture {
  userId: string;
  org: TestOrg;
  defaultAppId: string;
}

async function setup(): Promise<Fixture> {
  const user = await createTestUser();
  const { org, defaultAppId } = await createTestOrg(user.id);
  return { userId: user.id, org, defaultAppId };
}

const PLATFORM_URL = "http://localhost:3000";

describe("createPairing", () => {
  let fix: Fixture;
  beforeEach(async () => {
    await truncateAll();
    fix = await setup();
  });

  it("inserts a row with the SHA-256 of the secret portion (plaintext never persisted)", async () => {
    const result = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: 300,
    });

    expect(result.id).toMatch(/^pair_[A-Za-z0-9_-]+$/);
    expect(result.token).toMatch(/^appp_/);
    expect(result.expiresAt).toBeInstanceOf(Date);

    const expectedHash = await hashPairingSecret(result.token);
    const [row] = await db
      .select()
      .from(modelProviderPairings)
      .where(eq(modelProviderPairings.id, result.id));

    expect(row).toBeDefined();
    expect(row!.tokenHash).toBe(expectedHash);
    // Plaintext token MUST NOT appear in the row — only its hash.
    expect(row!.tokenHash).not.toContain(result.token);
    expect(row!.providerId).toBe("codex");
    expect(row!.consumedAt).toBeNull();
  });
});

describe("consumePairing", () => {
  let fix: Fixture;
  beforeEach(async () => {
    await truncateAll();
    fix = await setup();
  });

  async function mint(ttlSeconds = 300, providerId = "codex"): Promise<string> {
    const { token } = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId,
      platformUrl: PLATFORM_URL,
      ttlSeconds,
    });
    return token;
  }

  it("happy path — flips consumed_at and returns the row", async () => {
    const token = await mint();
    const consumed = await consumePairing(token, "127.0.0.1");
    expect(consumed.providerId).toBe("codex");
    expect(consumed.orgId).toBe(fix.org.id);
    expect(consumed.consumedAt).toBeInstanceOf(Date);
  });

  it("throws gone on expired token", async () => {
    const token = await mint(-1); // already expired (past timestamp)
    let err: unknown;
    try {
      await consumePairing(token);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(410);
  });

  it("throws gone on second consumption (idempotent — no replay of credentials)", async () => {
    const token = await mint();
    await consumePairing(token);
    let err: unknown;
    try {
      await consumePairing(token);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(410);
  });

  it("only one of two concurrent consumptions wins", async () => {
    const token = await mint();
    // Fire both in parallel against the same row — the predicate-guarded
    // UPDATE means only one observes a non-empty RETURNING.
    const [a, b] = await Promise.allSettled([consumePairing(token), consumePairing(token)]);
    const successes = [a, b].filter((r) => r.status === "fulfilled");
    const failures = [a, b].filter((r) => r.status === "rejected");
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failure = failures[0] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ApiError);
    expect((failure.reason as ApiError).status).toBe(410);
  });
});

describe("getPairing", () => {
  let fix: Fixture;
  beforeEach(async () => {
    await truncateAll();
    fix = await setup();
  });

  it("returns the row for the same org", async () => {
    const { id } = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: 300,
    });
    const row = await getPairing(id, fix.org.id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
  });

  it("returns null for a different org (no enumeration)", async () => {
    const { id } = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: 300,
    });
    const otherUser = await createTestUser();
    const { org: otherOrg } = await createTestOrg(otherUser.id);
    const row = await getPairing(id, otherOrg.id);
    expect(row).toBeNull();
  });
});

describe("cleanupExpiredPairings", () => {
  let fix: Fixture;
  beforeEach(async () => {
    await truncateAll();
    fix = await setup();
  });

  it("drops only rows past the 1h grace window, keeps fresh + recently-expired rows", async () => {
    const fresh = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: 300,
    });
    // Recently expired — past expires_at but still inside the grace window.
    const recent = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: -60, // expired 60s ago
    });
    // Old: backdate expires_at to 2h ago — outside the 1h grace window.
    const old = await createPairing({
      userId: fix.userId,
      orgId: fix.org.id,
      providerId: "codex",
      platformUrl: PLATFORM_URL,
      ttlSeconds: 300,
    });
    await db
      .update(modelProviderPairings)
      .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(modelProviderPairings.id, old.id));

    const deleted = await cleanupExpiredPairings();
    expect(deleted).toBe(1);

    expect(await getPairing(fresh.id, fix.org.id)).not.toBeNull();
    expect(await getPairing(recent.id, fix.org.id)).not.toBeNull();
    expect(await getPairing(old.id, fix.org.id)).toBeNull();
  });
});
