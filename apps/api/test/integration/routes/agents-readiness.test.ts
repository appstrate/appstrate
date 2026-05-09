// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `GET /api/agents/{scope}/{name}/readiness`
 * — the read-only preflight inspector the CLI hits before triggering a run.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../helpers/db.ts";
import { eq } from "drizzle-orm";
import { userProviderConnections } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedPackage,
  seedConnectionProfile,
  seedConnectionForApp,
  seedProviderCredentials,
} from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

const PROVIDER_ID = "@afps/gmail";
const AGENT_ID = "@readyorg/agent";

async function seedProviderPackage(): Promise<void> {
  await seedPackage({
    id: PROVIDER_ID,
    orgId: null,
    type: "provider",
    source: "system",
    draftManifest: {
      name: PROVIDER_ID,
      type: "provider",
      version: "1.0.0",
      description: "Test provider",
      definition: {
        authMode: "api_key",
        authorizedUris: [],
        allowAllUris: true,
        credentials: {
          schema: {
            type: "object",
            properties: { apiKey: { type: "string" } },
            required: ["apiKey"],
          },
          fieldName: "apiKey",
        },
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer ",
      },
    },
  }).catch(() => {});
}

async function seedAgentWithProvider(orgId: string): Promise<void> {
  await seedPackage({
    id: AGENT_ID,
    orgId,
    type: "agent",
    draftManifest: {
      name: AGENT_ID,
      version: "1.0.0",
      type: "agent",
      description: "Readiness fixture",
      dependencies: { providers: { [PROVIDER_ID]: "^1.0.0" } },
    },
  });
}

describe("GET /api/agents/:scope/:name/readiness", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "readyorg" });
    await seedProviderPackage();
    await seedAgentWithProvider(ctx.orgId);
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT_ID);
  });

  it("returns ready=true when the default profile has the connection", async () => {
    // The default profile is auto-created on first read; pre-create one
    // explicitly so we can attach a connection to it.
    const profile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Default",
      isDefault: true,
    });
    await seedConnectionForApp(profile.id, PROVIDER_ID, ctx.orgId, ctx.defaultAppId, {
      apiKey: "secret",
    });

    const res = await app.request(
      `/api/agents/@readyorg/agent/readiness?connectionProfileId=${profile.id}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; missing: unknown[] };
    expect(body.ready).toBe(true);
    expect(body.missing).toEqual([]);
  });

  it("returns ready=false with the missing provider when no connection exists", async () => {
    const profile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Empty",
      isDefault: false,
    });
    // Provider must be enabled for the app — otherwise the error is
    // `provider_not_enabled` (covered separately below). Add credentials
    // but no user connection.
    await seedProviderCredentials({
      applicationId: ctx.defaultAppId,
      providerId: PROVIDER_ID,
    });

    const res = await app.request(
      `/api/agents/@readyorg/agent/readiness?connectionProfileId=${profile.id}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      missing: Array<{ providerId: string; reason: string; connectionProfileId: string | null }>;
    };
    expect(body.ready).toBe(false);
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0]?.providerId).toBe(PROVIDER_ID);
    expect(body.missing[0]?.reason).toBe("no_connection");
    expect(body.missing[0]?.connectionProfileId).toBe(profile.id);
  });

  it("flags needs_reconnection when the underlying connection is marked stale", async () => {
    const profile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Stale",
      isDefault: false,
    });
    await seedConnectionForApp(profile.id, PROVIDER_ID, ctx.orgId, ctx.defaultAppId, {
      apiKey: "secret",
    });
    // Force `needs_reconnection` on the row so the dependency-validator
    // surfaces it. Mirrors what the platform does after rotating a
    // provider's credential schema.
    await db
      .update(userProviderConnections)
      .set({ needsReconnection: true })
      .where(eq(userProviderConnections.connectionProfileId, profile.id));

    const res = await app.request(
      `/api/agents/@readyorg/agent/readiness?connectionProfileId=${profile.id}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      missing: Array<{ providerId: string; reason: string }>;
    };
    expect(body.ready).toBe(false);
    expect(body.missing[0]?.reason).toBe("needs_reconnection");
  });

  it("honours per-provider override via providerProfile.<id>=<uuid>", async () => {
    const defaultProfile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Default",
      isDefault: true,
    });
    const overrideProfile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Override",
      isDefault: false,
    });
    // Default profile has no connection — would fail.
    // Override profile DOES have one — must succeed when override is used.
    await seedProviderCredentials({
      applicationId: ctx.defaultAppId,
      providerId: PROVIDER_ID,
    });
    await seedConnectionForApp(overrideProfile.id, PROVIDER_ID, ctx.orgId, ctx.defaultAppId, {
      apiKey: "secret",
    });

    const url = `/api/agents/@readyorg/agent/readiness?connectionProfileId=${defaultProfile.id}&providerProfile.${encodeURIComponent(PROVIDER_ID)}=${overrideProfile.id}`;
    const res = await app.request(url, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; missing: unknown[] };
    expect(body.ready).toBe(true);
    expect(body.missing).toEqual([]);
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request("/api/agents/@readyorg/agent/readiness");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await app.request("/api/agents/@readyorg/does-not-exist/readiness", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});
