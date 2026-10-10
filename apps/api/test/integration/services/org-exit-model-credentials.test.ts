// SPDX-License-Identifier: Apache-2.0

/**
 * Leaving an organization takes the member's personal model credentials and
 * pairings with it, and leaves organization credentials and other members' alone.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, modelProviderPairings } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import {
  createApiKeyCredential,
  createOAuthCredential,
} from "../../../src/services/model-providers/credentials.ts";
import { createPairing } from "../../../src/services/model-providers/pairings.ts";
import { leaveOrganization, provisionMember } from "../../../src/services/organizations.ts";

const FIXED_KEY_PROVIDER = "test-fixed-apikey";
const OAUTH_PROVIDER = "test-oauth";

async function addMember(ctx: TestContext): Promise<string> {
  const user = await createTestUser();
  await db.transaction((tx) => provisionMember(tx, ctx.orgId, user.id, "member"));
  return user.id;
}

async function credentialIdsOwnedBy(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: modelProviderCredentials.id })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.ownerUserId, userId));
  return rows.map((r) => r.id);
}

async function pairingIdsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: modelProviderPairings.id })
    .from(modelProviderPairings)
    .where(eq(modelProviderPairings.userId, userId));
  return rows.map((r) => r.id);
}

describe("leaving an organization — model provider credentials and pairings", () => {
  let ctx: TestContext;
  let leaver: string;
  let stayer: string;

  beforeEach(async () => {
    await truncateAll();
    seedTestModelProviders();
    registerModelProvider({
      providerId: FIXED_KEY_PROVIDER,
      displayName: "Fixed Key Provider",
      iconUrl: "openai",
      apiShape: "openai-completions",
      defaultBaseUrl: "https://fixed-key.test/v1",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    ctx = await createTestContext();
    leaver = await addMember(ctx);
    stayer = await addMember(ctx);
  });

  it("deletes the leaver's personal credentials and pairings, keeps org credentials", async () => {
    const orgCredentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Org key",
      providerId: FIXED_KEY_PROVIDER,
      apiKey: "sk-org",
    });
    await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: leaver,
      label: "Leaver key",
      providerId: FIXED_KEY_PROVIDER,
      apiKey: "sk-leaver",
      ownerUserId: leaver,
    });
    await createOAuthCredential({
      orgId: ctx.orgId,
      userId: leaver,
      label: "Leaver subscription",
      providerId: OAUTH_PROVIDER,
      accessToken: "at-leaver",
      refreshToken: "rt-leaver",
    });
    await createPairing({
      userId: leaver,
      orgId: ctx.orgId,
      providerId: OAUTH_PROVIDER,
      platformUrl: "http://localhost:3000",
      ttlSeconds: 300,
    });
    const stayerKeyId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: stayer,
      label: "Stayer key",
      providerId: FIXED_KEY_PROVIDER,
      apiKey: "sk-stayer",
      ownerUserId: stayer,
    });
    await createPairing({
      userId: stayer,
      orgId: ctx.orgId,
      providerId: OAUTH_PROVIDER,
      platformUrl: "http://localhost:3000",
      ttlSeconds: 300,
    });

    await leaveOrganization(ctx.orgId, leaver);

    expect(await credentialIdsOwnedBy(leaver)).toEqual([]);
    expect(await pairingIdsOf(leaver)).toEqual([]);

    const remaining = await db
      .select({ id: modelProviderCredentials.id })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.orgId, ctx.orgId));
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual([orgCredentialId, stayerKeyId].sort());
    expect(await pairingIdsOf(stayer)).toHaveLength(1);
  });
});
