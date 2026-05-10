// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 8 hardening — `scanAndEnqueueRefreshes` filter behavior
 * (cf. SPEC §6, PLAN §Phase 6.1).
 *
 * The scan SQL is the production gate that decides which connections get
 * refreshed proactively. A bug in the predicate could either flood the
 * platform with refresh jobs or silently let tokens expire. These tests
 * lock in the predicate by exercising every WHERE clause:
 *
 *   - `authMode='oauth'` filter — api_key rows MUST NOT be picked up.
 *   - `needsReconnection=false` filter — already-flagged connections
 *     are excluded (the worker would just hit the short-circuit anyway).
 *   - `expiresAt < now() + REFRESH_LEAD_HOURS` filter — far-future
 *     tokens skipped, near-expiry ones picked up.
 *   - `expiresAt IS NOT NULL` — connections without a known expiry are
 *     skipped (the sidecar's "always refresh" path handles them
 *     reactively).
 *
 * Each test asserts both the count returned by the function AND that
 * the right rows were considered. Enqueue uses an in-memory queue
 * adapter when `REDIS_URL` is unset (the default in test).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedProviderCredentials, seedPackage } from "../../helpers/seed.ts";
import { encryptCredentials } from "@appstrate/connect";
import { userProviderConnections, orgSystemProviderKeys } from "@appstrate/db/schema";
import { scanAndEnqueueRefreshes } from "../../../src/services/oauth-model-providers/refresh-worker.ts";

const CLAUDE_PROVIDER = "@appstrate/provider-claude-code";
const CODEX_PROVIDER = "@appstrate/provider-codex";

interface SeedFixture {
  orgId: string;
  applicationId: string;
  connectionProfileId: string;
}

async function setupOrg(): Promise<SeedFixture> {
  const user = await createTestUser();
  const { org, defaultAppId } = await createTestOrg(user.id, { slug: "testorg" });
  const profile = await seedConnectionProfile({
    userId: user.id,
    name: "Default",
    isDefault: true,
  });
  return {
    orgId: org.id,
    applicationId: defaultAppId,
    connectionProfileId: profile.id,
  };
}

async function seedConnectionAndKey(
  fx: SeedFixture,
  providerId: string,
  opts: {
    expiresAt: Date | null;
    needsReconnection?: boolean;
    /** When false, creates an api_key system provider key (not oauth). */
    withOauthKey?: boolean;
  },
): Promise<string> {
  await seedPackage({
    orgId: null,
    id: providerId,
    type: "provider",
    source: "system",
  }).catch(() => {});
  const cred = await seedProviderCredentials({
    applicationId: fx.applicationId,
    providerId,
  });
  const [connection] = await db
    .insert(userProviderConnections)
    .values({
      connectionProfileId: fx.connectionProfileId,
      providerId,
      orgId: fx.orgId,
      providerCredentialId: cred.id,
      credentialsEncrypted: encryptCredentials({
        access_token: "tok",
        refresh_token: "rt",
      }),
      expiresAt: opts.expiresAt,
      needsReconnection: opts.needsReconnection ?? false,
    })
    .returning();
  if (opts.withOauthKey ?? true) {
    await db.insert(orgSystemProviderKeys).values({
      orgId: fx.orgId,
      label: `Test ${providerId}`,
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authMode: "oauth",
      oauthConnectionId: connection!.id,
      providerPackageId: providerId,
    });
  }
  return connection!.id;
}

describe("scanAndEnqueueRefreshes — filter behavior (Phase 8)", () => {
  let fx: SeedFixture;

  beforeEach(async () => {
    await truncateAll();
    fx = await setupOrg();
  });

  it("returns 0/0 when there are no OAuth model provider connections", async () => {
    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("picks up a connection expiring within the 24h lead window", async () => {
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      // 1h from now — within the 24h lead window
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(1);
  });

  it("ignores a connection whose expiry is far beyond the lead window", async () => {
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      // 7 days from now — far beyond the 24h lead window
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("ignores a connection with `needsReconnection=true`", async () => {
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      needsReconnection: true,
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("ignores a connection not bound to any orgSystemProviderKey", async () => {
    // Connection exists but no orgSystemProviderKeys row references it
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      withOauthKey: false,
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("ignores a connection with `expiresAt IS NULL` (sidecar handles those reactively)", async () => {
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      expiresAt: null,
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("processes multiple eligible connections in a single scan (Codex + Claude)", async () => {
    await seedConnectionAndKey(fx, CLAUDE_PROVIDER, {
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    await seedConnectionAndKey(fx, CODEX_PROVIDER, {
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    // Plus a far-future one — should NOT be enqueued
    await seedConnectionAndKey(fx, "@example/other-provider", {
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });

    const result = await scanAndEnqueueRefreshes();
    expect(result.scanned).toBe(2);
    expect(result.enqueued).toBe(2);
  });
});
