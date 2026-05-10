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
 *   - blob `needsReconnection=false` — already-flagged credentials skipped.
 *   - blob `expiresAt < now + REFRESH_LEAD_HOURS` — far-future tokens
 *     skipped, near-expiry ones picked up.
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
  providerId: "codex" | "claude-code",
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
    await seedOauthCred(fx, "claude-code", {
      expiresAtMs: Date.now() + 60 * 60 * 1000, // 1h from now
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it("ignores a credential whose expiry is far beyond the lead window", async () => {
    await seedOauthCred(fx, "claude-code", {
      expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1); // SQL filter passes; in-memory expiry filter rejects
    expect(result.enqueued).toBe(0);
  });

  it("ignores a credential flagged needsReconnection=true", async () => {
    await seedOauthCred(fx, "claude-code", {
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      needsReconnection: true,
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  it("ignores a credential with expiresAt=null (sidecar handles those reactively)", async () => {
    await seedOauthCred(fx, "claude-code", { expiresAtMs: null });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(0);
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

  it("processes multiple eligible credentials in a single scan (Codex + Claude)", async () => {
    await seedOauthCred(fx, "claude-code", {
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
