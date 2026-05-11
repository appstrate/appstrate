// SPDX-License-Identifier: Apache-2.0

/**
 * `scanAndEnqueueRefreshes` filter behavior (cf. SPEC §6).
 *
 * The scan is the production gate that decides which credentials get
 * refreshed proactively. A bug in the predicate could either flood the
 * platform with refresh jobs or silently let tokens expire. These tests
 * lock in the predicate by exercising every gate:
 *
 *   - `provider_id IN <oauth registry ids>` — api-key rows are filtered
 *     out at the SQL level (and api-key blobs would be `kind: "api_key"`
 *     even if a provider id leaked, which the post-decrypt filter catches).
 *   - SQL `expires_at IS NULL OR expires_at <= cutoff` — fresh-token rows
 *     are excluded BEFORE the decrypt loop (denormalized cache, mirrored
 *     from the encrypted blob). `scanned` reports the post-SQL row count,
 *     not the table row count.
 *   - blob `needsReconnection=false` — already-flagged credentials skipped.
 *   - blob `expiresAt < now + REFRESH_LEAD_HOURS` — second-line check
 *     against the source-of-truth blob, in case the cache drifted.
 *   - blob `expiresAt !== null` — credentials without a known expiry are
 *     skipped (the sidecar's reactive 401-retry handles them).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  createApiKeyCredential,
  createOAuthCredential,
  markCredentialNeedsReconnection,
} from "../../../src/services/model-provider-credentials.ts";
import { scanAndEnqueueRefreshes } from "../../../src/services/oauth-model-providers/refresh-worker.ts";

interface SeedFixture {
  orgId: string;
  userId: string;
}

async function setupOrg(): Promise<SeedFixture> {
  const user = await createTestUser();
  const { org } = await createTestOrg(user.id, { slug: "testorg" });
  return { orgId: org.id, userId: user.id };
}

async function seedOauthCred(
  fx: SeedFixture,
  providerId: "codex",
  opts: { expiresAtMs: number | null; needsReconnection?: boolean },
): Promise<string> {
  const id = await createOAuthCredential({
    orgId: fx.orgId,
    userId: fx.userId,
    label: `Test ${providerId}`,
    providerId,
    accessToken: "tok",
    refreshToken: "rt",
    expiresAt: opts.expiresAtMs,
    scopesGranted: ["user:inference"],
  });
  if (opts.needsReconnection) {
    await markCredentialNeedsReconnection(fx.orgId, id);
  }
  return id;
}

describe("scanAndEnqueueRefreshes — filter behavior", () => {
  let fx: SeedFixture;

  beforeEach(async () => {
    await truncateAll();
    fx = await setupOrg();
  });

  it("returns 0/0 when there are no OAuth model provider credentials", async () => {
    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("picks up a credential expiring within the 24h lead window", async () => {
    await seedOauthCred(fx, "codex", {
      expiresAtMs: Date.now() + 60 * 60 * 1000, // 1h from now
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it("ignores a credential whose expiry is far beyond the lead window", async () => {
    await seedOauthCred(fx, "codex", {
      expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const result = await scanAndEnqueueRefreshes();
    // Post-denormalization: SQL filter rejects fresh-expiry rows BEFORE the
    // decrypt loop runs, so they never appear in `scanned` either.
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it("ignores a credential flagged needsReconnection=true", async () => {
    await seedOauthCred(fx, "codex", {
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      needsReconnection: true,
    });

    const result = await scanAndEnqueueRefreshes();
    // The SQL filter qualifies (expiry within window) but the post-decrypt
    // `needsReconnection` gate rejects — so it's counted as scanned, not enqueued.
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("ignores a credential with expiresAt=null (sidecar handles those reactively)", async () => {
    await seedOauthCred(fx, "codex", { expiresAtMs: null });

    const result = await scanAndEnqueueRefreshes();
    // `expires_at IS NULL` qualifies via the backfill branch of the SQL
    // predicate, so the row IS scanned (decrypted) — but the blob's
    // `expiresAt === null` then short-circuits the enqueue.
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("does not decrypt fresh credentials — SQL prefilters them out", async () => {
    // 4 fresh creds (expiry well beyond the lead window) + 1 expiring soon.
    // The SQL filter must reject the 4 fresh rows BEFORE the decrypt loop;
    // observable signal: `scanned` reflects only the rows the worker
    // actually fetched (and would have decrypted), so it must equal 1.
    await seedOauthCred(fx, "codex", { expiresAtMs: Date.now() + 60 * 60 * 1000 });
    for (let i = 0; i < 4; i++) {
      await seedOauthCred(fx, "codex", {
        expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      });
    }

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it("ignores api-key credentials (only OAuth providerIds are scanned)", async () => {
    await createApiKeyCredential({
      orgId: fx.orgId,
      userId: fx.userId,
      label: "openai key",
      providerId: "openai",
      apiKey: "sk-test",
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("processes multiple eligible credentials in a single scan", async () => {
    await seedOauthCred(fx, "codex", {
      expiresAtMs: Date.now() + 30 * 60 * 1000,
    });
    await seedOauthCred(fx, "codex", {
      expiresAtMs: Date.now() + 2 * 60 * 60 * 1000,
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(2);
    expect(result.enqueued).toBe(2);
  });
});
