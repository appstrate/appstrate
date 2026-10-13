// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns the subscription a pairing produces: `owner_type` on
 * `POST /api/model-providers-oauth/pairing` follows the rule of an API key.
 * `org` needs `write` and makes an organization credential, bindable to a model
 * and reconnected by whoever edits organization credentials; `user` needs
 * `connect` and makes the caller's personal one, bound to nothing. A reconnect
 * never crosses owners, at the mint or at the redeem.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { decryptCredentials } from "@appstrate/connect";
import { auditEvents, modelProviderCredentials } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { TEST_OAUTH_MODEL_ID, TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { createPairing } from "../../../src/services/model-providers/pairings.ts";
import { updateOrgSettings } from "../../../src/services/organizations.ts";

const app = getTestApp();

const PAIRINGS = "/api/model-providers-oauth/pairing";
const REDEEM = "/api/model-providers-oauth/pair/redeem";

interface CredentialRow {
  id: string;
  owner_type: "org" | "user";
  owner_id: string | null;
  bindable: boolean;
  allowed_actions: string[];
}

function jsonHeaders(ctx: TestContext): Record<string, string> {
  return authHeaders(ctx, { "Content-Type": "application/json" });
}

function mint(ctx: TestContext, body: Record<string, unknown> = {}) {
  return app.request(PAIRINGS, {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify({ providerId: TEST_OAUTH_PROVIDER_ID, ...body }),
  });
}

function redeem(token: string, accessToken = "redeemed-access") {
  return app.request(REDEEM, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      providerId: TEST_OAUTH_PROVIDER_ID,
      access_token: accessToken,
      refresh_token: "redeemed-refresh",
      expiresAt: Date.now() + 3_600_000,
    }),
  });
}

/** Mint then redeem; returns the credential the pairing produced. */
async function pair(ctx: TestContext, body: Record<string, unknown> = {}): Promise<string> {
  const minted = await mint(ctx, body);
  expect(minted.status).toBe(200);
  const res = await redeem(((await minted.json()) as { token: string }).token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { credentialId: string }).credentialId;
}

async function storedCredential(id: string) {
  const [row] = await db
    .select()
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, id));
  return {
    ownerUserId: row!.ownerUserId,
    createdBy: row!.createdBy,
    accessToken: decryptCredentials<{ accessToken: string }>(row!.credentialsEncrypted).accessToken,
  };
}

async function listedCredential(ctx: TestContext, id: string): Promise<CredentialRow | undefined> {
  const res = await app.request("/api/model-provider-credentials", { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: CredentialRow[] }).data.find((c) => c.id === id);
}

function createModel(ctx: TestContext, credentialId: string) {
  return app.request("/api/models", {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify({ modelId: TEST_OAUTH_MODEL_ID, credentialId }),
  });
}

function seedModels(ctx: TestContext, credentialId: string) {
  return app.request("/api/models/seed", {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] }),
  });
}

describe("subscription pairings — owner_type", () => {
  let admin: TestContext;
  let member: TestContext;

  beforeEach(async () => {
    await truncateAll();
    seedTestModelProviders();
    admin = await createTestContext();
    member = await memberContext(admin, "member");
  });

  describe("owner_type: org", () => {
    it("is the default, and needs model-provider-credentials:write", async () => {
      expect((await mint(member)).status).toBe(403);
      expect((await mint(member, { owner_type: "org" })).status).toBe(403);
      expect((await mint(admin)).status).toBe(200);
    });

    it("redeems into an organization credential, recorded as such in the audit trail", async () => {
      const id = await pair(admin, { owner_type: "org" });

      expect(await storedCredential(id)).toMatchObject({
        ownerUserId: null,
        createdBy: admin.user.id,
      });
      expect(await listedCredential(admin, id)).toMatchObject({
        owner_type: "org",
        owner_id: null,
        bindable: true,
        allowed_actions: ["edit", "delete", "test", "reconnect"],
      });
      // A member reads no organization credential.
      expect(await listedCredential(member, id)).toBeUndefined();

      const [event] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "oauth_model_provider.imported"),
            eq(auditEvents.resourceId, id),
          ),
        );
      expect(event!.after).toMatchObject({ ownerType: "org", credentialId: id });
    });

    it("binds an organization model, by creation and by seed", async () => {
      const created = await createModel(admin, await pair(admin));
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ binding: "org", billed_to: "org" });

      const seeded = await seedModels(admin, await pair(admin));
      expect(seeded.status).toBe(201);
      expect(((await seeded.json()) as { created: number }).created).toBe(1);
    });

    it("is untouched by the personal-credentials policy, at the mint and at the redeem", async () => {
      await updateOrgSettings(admin.orgId, { personal_model_credentials: false });
      const id = await pair(admin, { owner_type: "org" });
      expect((await storedCredential(id)).ownerUserId).toBeNull();

      const reconnect = await mint(admin, { owner_type: "org", credentialId: id });
      expect(reconnect.status).toBe(200);
      const res = await redeem(((await reconnect.json()) as { token: string }).token, "rotated");
      expect(res.status).toBe(200);
      expect((await storedCredential(id)).accessToken).toBe("rotated");
    });
  });

  describe("owner_type: user", () => {
    it("redeems into the caller's personal credential, which binds no model", async () => {
      const id = await pair(admin, { owner_type: "user" });

      expect((await storedCredential(id)).ownerUserId).toBe(admin.user.id);
      expect(await listedCredential(admin, id)).toMatchObject({
        owner_type: "user",
        owner_id: admin.user.id,
        bindable: false,
      });

      for (const res of [await createModel(admin, id), await seedModels(admin, id)]) {
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe(
          "personal_credential_not_bindable",
        );
      }
    });

    it("is refused with 403 while the organization has personal credentials off, an admin included", async () => {
      await updateOrgSettings(admin.orgId, { personal_model_credentials: false });
      for (const ctx of [admin, member]) {
        const res = await mint(ctx, { owner_type: "user" });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe(
          "personal_model_credentials_disabled",
        );
      }
    });
  });

  describe("reconnecting", () => {
    it("an admin reconnects an organization subscription in place; a member cannot target it", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "stale",
        createdBy: member.user.id,
      });
      const target = { credentialId: orgSubscription.id };

      // The member lacks `write` for an organization pairing, and reads no such credential.
      expect((await mint(member, { ...target, owner_type: "org" })).status).toBe(403);
      expect((await mint(member, { ...target, owner_type: "user" })).status).toBe(404);

      const minted = await mint(admin, { ...target, owner_type: "org" });
      expect(minted.status).toBe(200);
      const res = await redeem(((await minted.json()) as { token: string }).token, "fresh");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { credentialId: string }).credentialId).toBe(
        orgSubscription.id,
      );
      expect(await storedCredential(orgSubscription.id)).toMatchObject({
        ownerUserId: null,
        accessToken: "fresh",
      });
    });

    it("answers 404 when owner_type does not name the targeted credential's owner", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
      });
      const own = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        ownerUserId: admin.user.id,
      });

      // The admin may reconnect both: only the named owner is wrong.
      const mismatched = [
        { credentialId: orgSubscription.id, owner_type: "user" },
        { credentialId: own.id, owner_type: "org" },
      ];
      for (const body of mismatched) {
        const res = await mint(admin, body);
        expect(res.status).toBe(404);
        expect(((await res.json()) as { detail: string }).detail).toBe(
          "Model provider credential not found",
        );
      }
      const matched = [
        { credentialId: orgSubscription.id, owner_type: "org" },
        { credentialId: own.id, owner_type: "user" },
      ];
      for (const body of matched) {
        expect((await mint(admin, body)).status).toBe(200);
      }
    });

    it("a redeem never moves a credential to the pairing's owner", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "org-access",
      });
      const own = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "own-access",
        ownerUserId: admin.user.id,
      });
      // The mint route refuses both pairings; the redeem holds on its own.
      const crossed = [
        { target: orgSubscription.id, ownerUserId: admin.user.id },
        { target: own.id, ownerUserId: null },
      ];
      for (const { target, ownerUserId } of crossed) {
        const { token } = await createPairing({
          userId: admin.user.id,
          orgId: admin.orgId,
          providerId: TEST_OAUTH_PROVIDER_ID,
          ownerUserId,
          reconnectCredentialId: target,
          platformUrl: "http://localhost:3000",
          ttlSeconds: 300,
        });
        expect((await redeem(token, "hijacked")).status).toBe(404);
      }

      expect(await storedCredential(orgSubscription.id)).toMatchObject({
        ownerUserId: null,
        accessToken: "org-access",
      });
      expect(await storedCredential(own.id)).toMatchObject({
        ownerUserId: admin.user.id,
        accessToken: "own-access",
      });
    });
  });
});
