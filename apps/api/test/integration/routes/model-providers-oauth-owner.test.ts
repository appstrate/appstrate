// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns the subscription a pairing produces: `owner_type` on
 * `POST /api/model-providers-oauth/pairing` follows the rule of an API key.
 * `org` needs `write` and makes an organization credential, bindable to a model;
 * `user` needs `connect` and makes the caller's personal one, bound to nothing.
 * A reconnect names a credential and no owner, and is accepted exactly when the
 * credential lists `reconnect` for the caller. The redeem judges the member who
 * minted the pairing again, on their grants at that moment.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { decryptCredentials } from "@appstrate/connect";
import { auditEvents, modelProviderCredentials, organizationMembers } from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
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
import { expectRejectedField } from "../../helpers/body-validation.ts";
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

async function mintToken(ctx: TestContext, body: Record<string, unknown> = {}): Promise<string> {
  const minted = await mint(ctx, body);
  expect(minted.status).toBe(200);
  return ((await minted.json()) as { token: string }).token;
}

function setOrgRole(ctx: TestContext, role: OrgRole) {
  return db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, ctx.user.id)),
    );
}

async function credentialCount(orgId: string): Promise<number> {
  const rows = await db
    .select({ id: modelProviderCredentials.id })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.orgId, orgId));
  return rows.length;
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

      const res = await redeem(await mintToken(admin, { credentialId: id }), "rotated");
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
    it("an admin reconnects an organization subscription in place; to a member it is absent", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "stale",
        createdBy: member.user.id,
      });
      const target = { credentialId: orgSubscription.id };

      expect((await mint(member, target)).status).toBe(404);

      const res = await redeem(await mintToken(admin, target), "fresh");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { credentialId: string }).credentialId).toBe(
        orgSubscription.id,
      );
      expect(await storedCredential(orgSubscription.id)).toMatchObject({
        ownerUserId: null,
        accessToken: "fresh",
      });
    });

    it("refuses owner_type on a reconnect with 400: the credential names its owner", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
      });
      const res = await mint(admin, { credentialId: orgSubscription.id, owner_type: "org" });
      await expectRejectedField(res, "owner_type");
    });

    /**
     * The mint accepts a reconnect exactly when the list offers `reconnect`, for
     * every org role. `policyOff` is the status once the organization turns
     * personal credentials off: an owner is told so (403), anyone else still
     * reads the credential as absent.
     */
    const roles: OrgRole[] = ["owner", "admin", "member", "guest"];
    const manages = (role: OrgRole) => role === "owner" || role === "admin";
    for (const role of roles) {
      it(`${role}: the mint accepts a reconnect exactly when the list offers it`, async () => {
        const caller = role === "owner" ? admin : await memberContext(admin, role);
        const seed = (ownerUserId: string | null) =>
          seedOrgModelProviderOAuth({
            orgId: admin.orgId,
            providerId: TEST_OAUTH_PROVIDER_ID,
            ownerUserId,
          });
        const cases = [
          { id: (await seed(null)).id, on: manages(role), policyOff: manages(role) ? 200 : 404 },
          { id: (await seed(caller.user.id)).id, on: true, policyOff: 403 },
          { id: (await seed(member.user.id)).id, on: false, policyOff: 404 },
        ];

        for (const { id, on } of cases) {
          const offered =
            (await listedCredential(caller, id))?.allowed_actions.includes("reconnect") ?? false;
          expect(offered).toBe(on);
          expect((await mint(caller, { credentialId: id })).status).toBe(on ? 200 : 404);
        }

        await updateOrgSettings(admin.orgId, { personal_model_credentials: false });
        for (const { id, policyOff } of cases) {
          const offered =
            (await listedCredential(caller, id))?.allowed_actions.includes("reconnect") ?? false;
          expect(offered).toBe(policyOff === 200);
          expect((await mint(caller, { credentialId: id })).status).toBe(policyOff);
        }
      });
    }
  });

  describe("the redeem judges the minter again", () => {
    let secondAdmin: TestContext;

    beforeEach(async () => {
      secondAdmin = await memberContext(admin, "admin");
    });

    it("refuses an organization creation once its minter is demoted", async () => {
      const token = await mintToken(secondAdmin, { owner_type: "org" });
      await setOrgRole(secondAdmin, "guest");

      expect((await redeem(token)).status).toBe(403);
      expect(await credentialCount(admin.orgId)).toBe(0);
    });

    it("refuses an organization reconnect once its minter is demoted, and keeps the stored tokens", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "org-access",
      });
      const token = await mintToken(secondAdmin, { credentialId: orgSubscription.id });
      await setOrgRole(secondAdmin, "guest");

      expect((await redeem(token, "ex-admin-access")).status).toBe(404);
      expect((await storedCredential(orgSubscription.id)).accessToken).toBe("org-access");
    });

    it("refuses a pairing with no owner whose minter holds connect alone, as one in flight when the column appeared", async () => {
      const { token } = await createPairing({
        userId: member.user.id,
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        ownerUserId: null,
        platformUrl: "http://localhost:3000",
        ttlSeconds: 300,
      });

      expect((await redeem(token)).status).toBe(403);
      expect(await credentialCount(admin.orgId)).toBe(0);
    });

    it("refuses every redeem of a minter who is no longer a member", async () => {
      const own = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "own-access",
        ownerUserId: secondAdmin.user.id,
      });
      const creation = await mintToken(secondAdmin, { owner_type: "org" });
      const reconnect = await mintToken(secondAdmin, { credentialId: own.id });
      // The membership row alone: an exit through the service also deletes the pairings.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, admin.orgId),
            eq(organizationMembers.userId, secondAdmin.user.id),
          ),
        );

      expect((await redeem(creation)).status).toBe(403);
      expect((await redeem(reconnect, "gone-access")).status).toBe(404);
      expect(await credentialCount(admin.orgId)).toBe(1);
      expect((await storedCredential(own.id)).accessToken).toBe("own-access");
    });

    it("keeps a personal reconnect for an owner demoted to guest, until the organization turns personal credentials off", async () => {
      const own = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "own-access",
        ownerUserId: secondAdmin.user.id,
      });
      const first = await mintToken(secondAdmin, { credentialId: own.id });
      const second = await mintToken(secondAdmin, { credentialId: own.id });
      await setOrgRole(secondAdmin, "guest");

      expect((await redeem(first, "guest-access")).status).toBe(200);
      expect((await storedCredential(own.id)).accessToken).toBe("guest-access");

      await updateOrgSettings(admin.orgId, { personal_model_credentials: false });
      const refused = await redeem(second, "after-policy");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "personal_model_credentials_disabled",
      );
      expect((await storedCredential(own.id)).accessToken).toBe("guest-access");
    });

    it("judges the credential as it is, not the owner its pairing recorded", async () => {
      const orgSubscription = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "org-access",
      });
      const others = await seedOrgModelProviderOAuth({
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "others-access",
        ownerUserId: secondAdmin.user.id,
      });
      const forged = (userId: string, ownerUserId: string | null, target: string) =>
        createPairing({
          userId,
          orgId: admin.orgId,
          providerId: TEST_OAUTH_PROVIDER_ID,
          ownerUserId,
          reconnectCredentialId: target,
          platformUrl: "http://localhost:3000",
          ttlSeconds: 300,
        });

      // A member reconnects neither, whatever owner the row claims.
      for (const [owner, target] of [
        [null, orgSubscription.id],
        [member.user.id, orgSubscription.id],
        [member.user.id, others.id],
      ] as const) {
        const { token } = await forged(member.user.id, owner, target);
        expect((await redeem(token, "hijacked")).status).toBe(404);
      }
      // An admin reconnects the organization's; the row's owner claim moves nothing.
      const { token } = await forged(admin.user.id, admin.user.id, orgSubscription.id);
      expect((await redeem(token, "admin-access")).status).toBe(200);

      expect(await storedCredential(orgSubscription.id)).toMatchObject({
        ownerUserId: null,
        accessToken: "admin-access",
      });
      expect(await storedCredential(others.id)).toMatchObject({
        ownerUserId: secondAdmin.user.id,
        accessToken: "others-access",
      });
    });
  });
});
