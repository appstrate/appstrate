// SPDX-License-Identifier: Apache-2.0

/**
 * Who owns the subscription a pairing produces: `owner_type` on
 * `POST /api/model-providers-oauth/pairing` follows the rule of an API key.
 * `org` needs `write` and makes an organization connection; `user` needs
 * `connect` and makes the caller's personal one. Both are filed under the
 * configuration of the provider's family, whose models they serve.
 * A reconnect names a credential and no owner, and is accepted exactly when the
 * credential lists `reconnect` for the caller. The redeem judges the member who
 * minted the pairing again, on their grants at that moment.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { decryptCredentials } from "@appstrate/connect";
import {
  auditEvents,
  modelProviderCredentials,
  modelProviderPairings,
  organizationMembers,
} from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedModelConfigFor, seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { expectRejectedField } from "../../helpers/body-validation.ts";
import {
  TEST_OAUTH_HOOKS_PROVIDER_ID,
  TEST_OAUTH_MODEL_ID,
  TEST_OAUTH_PROVIDER_ID,
} from "../../helpers/test-oauth-provider.ts";
import { consumePairing, createPairing } from "../../../src/services/model-providers/pairings.ts";
import { updateModelConfig } from "../../../src/services/model-configs.ts";

const app = getTestApp();

const PAIRINGS = "/api/model-providers-oauth/pairing";
const REDEEM = "/api/model-providers-oauth/pair/redeem";

interface CredentialRow {
  id: string;
  owner_type: "org" | "user";
  owner_id: string | null;
  config_id: string;
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

function redeemWith(token: string, body: Record<string, unknown>) {
  return app.request(REDEEM, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function redeem(token: string, accessToken = "redeemed-access") {
  return redeemWith(token, {
    providerId: TEST_OAUTH_PROVIDER_ID,
    access_token: accessToken,
    refresh_token: "redeemed-refresh",
    expiresAt: Date.now() + 3_600_000,
  });
}

/** Mint then redeem; returns the credential the pairing produced. */
async function pair(ctx: TestContext, body: Record<string, unknown> = {}): Promise<string> {
  const minted = await mint(ctx, body);
  expect(minted.status).toBe(201);
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
  expect(minted.status).toBe(201);
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

async function mintPairing(ctx: TestContext): Promise<{ id: string; token: string }> {
  const minted = await mint(ctx, { owner_type: "org" });
  expect(minted.status).toBe(201);
  return (await minted.json()) as { id: string; token: string };
}

/** A pairing as stored and as its minter's poll reads it. */
async function pairingOutcome(ctx: TestContext, id: string) {
  const [row] = await db
    .select()
    .from(modelProviderPairings)
    .where(eq(modelProviderPairings.id, id));
  const res = await app.request(`${PAIRINGS}/${id}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const read = (await res.json()) as { status: string; credentialId: string | null };
  return {
    stored: {
      consumed: row!.consumedAt !== null,
      failed: row!.failedAt !== null,
      credentialId: row!.credentialId,
    },
    read: { status: read.status, credentialId: read.credentialId },
  };
}

/** Move a pairing past its TTL. */
async function expirePairing(id: string): Promise<void> {
  await db
    .update(modelProviderPairings)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(modelProviderPairings.id, id));
}

async function credentialCount(orgId: string): Promise<number> {
  const rows = await db
    .select({ id: modelProviderCredentials.id })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.orgId, orgId));
  return rows.length;
}

async function configOf(credentialId: string): Promise<string> {
  const [row] = await db
    .select({ configId: modelProviderCredentials.configId })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId));
  return row!.configId!;
}

async function createModel(ctx: TestContext, credentialId: string) {
  return app.request("/api/models", {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify({ modelId: TEST_OAUTH_MODEL_ID, config_id: await configOf(credentialId) }),
  });
}

async function seedModels(ctx: TestContext, credentialId: string) {
  return app.request("/api/models/seed", {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify({
      config_id: await configOf(credentialId),
      model_ids: [TEST_OAUTH_MODEL_ID],
    }),
  });
}

/** Switch personal connections off on the configuration test-oauth is filed under. */
async function disablePersonal(orgId: string): Promise<void> {
  const configId = await seedModelConfigFor(orgId, TEST_OAUTH_PROVIDER_ID);
  await updateModelConfig(orgId, configId, { personalConnectionsAllowed: false });
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
      expect((await mint(admin)).status).toBe(201);
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

    it("serves an organization model of its configuration, by creation and by seed", async () => {
      const created = await createModel(admin, await pair(admin));
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ billed_to: "org" });

      // A second subscription lands in the same configuration; seeding the model
      // id it already serves creates nothing new.
      const second = await pair(admin);
      const seeded = await seedModels(admin, second);
      expect(seeded.status).toBe(201);
      expect(((await seeded.json()) as { created: number }).created).toBe(0);
    });

    it("is untouched by the personal-credentials policy, at the mint and at the redeem", async () => {
      await disablePersonal(admin.orgId);
      const id = await pair(admin, { owner_type: "org" });
      expect((await storedCredential(id)).ownerUserId).toBeNull();

      const res = await redeem(await mintToken(admin, { credentialId: id }), "rotated");
      expect(res.status).toBe(200);
      expect((await storedCredential(id)).accessToken).toBe("rotated");
    });
  });

  describe("owner_type: user", () => {
    it("redeems into the caller's personal connection, filed under the family configuration", async () => {
      const id = await pair(admin, { owner_type: "user" });

      expect((await storedCredential(id)).ownerUserId).toBe(admin.user.id);
      const listed = await listedCredential(admin, id);
      expect(listed).toMatchObject({ owner_type: "user", owner_id: admin.user.id });
      expect(listed!.config_id).toBe(await seedModelConfigFor(admin.orgId, TEST_OAUTH_PROVIDER_ID));

      // A model of that configuration is created; with no organization
      // connection, nobody is billed at the organization level.
      const created = await createModel(admin, id);
      expect(created.status).toBe(201);
      expect(((await created.json()) as { billed_to: string | null }).billed_to).not.toBe("org");
    });

    it("is refused with 403 while the configuration has personal connections off, an admin included", async () => {
      await disablePersonal(admin.orgId);
      for (const ctx of [admin, member]) {
        const res = await mint(ctx, { owner_type: "user" });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe("personal_connections_disabled");
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
          { id: (await seed(null)).id, on: manages(role), policyOff: manages(role) ? 201 : 404 },
          { id: (await seed(caller.user.id)).id, on: true, policyOff: 403 },
          { id: (await seed(member.user.id)).id, on: false, policyOff: 404 },
        ];

        for (const { id, on } of cases) {
          const offered =
            (await listedCredential(caller, id))?.allowed_actions.includes("reconnect") ?? false;
          expect(offered).toBe(on);
          expect((await mint(caller, { credentialId: id })).status).toBe(on ? 201 : 404);
        }

        await disablePersonal(admin.orgId);
        for (const { id, policyOff } of cases) {
          const offered =
            (await listedCredential(caller, id))?.allowed_actions.includes("reconnect") ?? false;
          expect(offered).toBe(policyOff === 201);
          expect((await mint(caller, { credentialId: id })).status).toBe(policyOff);
        }
      });
    }
  });

  describe("the pairing records the outcome of its redeem", () => {
    it("a redeem that wrote a credential reads connected, with that credential", async () => {
      const { id, token } = await mintPairing(admin);
      const res = await redeem(token);
      expect(res.status).toBe(200);
      const { credentialId } = (await res.json()) as { credentialId: string };

      const outcome = {
        stored: { consumed: true, failed: false, credentialId },
        read: { status: "connected", credentialId },
      };
      expect(await pairingOutcome(admin, id)).toEqual(outcome);
      await expirePairing(id);
      expect(await pairingOutcome(admin, id)).toEqual(outcome);
    });

    it("a redeem refused on its minter's grants reads failed, and a retry is 410", async () => {
      const secondAdmin = await memberContext(admin, "admin");
      const { id, token } = await mintPairing(secondAdmin);
      await setOrgRole(secondAdmin, "guest");
      expect((await redeem(token)).status).toBe(403);

      const outcome = {
        stored: { consumed: true, failed: true, credentialId: null },
        read: { status: "failed", credentialId: null },
      };
      expect(await pairingOutcome(secondAdmin, id)).toEqual(outcome);
      await expirePairing(id);
      expect(await pairingOutcome(secondAdmin, id)).toEqual(outcome);
      expect((await redeem(token)).status).toBe(410);
      expect(await credentialCount(admin.orgId)).toBe(0);
    });

    for (const [refusal, body, problem] of [
      [
        "a body the redeem does not accept",
        { providerId: TEST_OAUTH_PROVIDER_ID },
        { code: "validation_failed" },
      ],
      [
        // A registered OAuth provider: the body schema accepts it, the pairing check refuses it.
        "another provider than the pairing's",
        { providerId: TEST_OAUTH_HOOKS_PROVIDER_ID, access_token: "a", refresh_token: "r" },
        {
          code: "invalid_request",
          param: "providerId",
          detail: `providerId in body (${TEST_OAUTH_HOOKS_PROVIDER_ID}) does not match pairing (${TEST_OAUTH_PROVIDER_ID})`,
        },
      ],
    ] as const) {
      it(`a redeem refused for ${refusal} reads failed`, async () => {
        const { id, token } = await mintPairing(admin);
        const res = await redeemWith(token, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject(problem);

        expect(await pairingOutcome(admin, id)).toEqual({
          stored: { consumed: true, failed: true, credentialId: null },
          read: { status: "failed", credentialId: null },
        });
      });
    }

    it("a consumed pairing with no recorded outcome reads pending, then expired past its expiry", async () => {
      const { id, token } = await mintPairing(admin);
      await consumePairing(token);
      const unrecorded = { consumed: true, failed: false, credentialId: null };

      expect(await pairingOutcome(admin, id)).toEqual({
        stored: unrecorded,
        read: { status: "pending", credentialId: null },
      });

      await expirePairing(id);
      expect(await pairingOutcome(admin, id)).toEqual({
        stored: unrecorded,
        read: { status: "expired", credentialId: null },
      });
    });
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

    it("a pairing with no recorded owner is an organization pairing: its minter needs write", async () => {
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

    it("never records a personal creation for another user than its minter", async () => {
      const refused = await createPairing({
        userId: member.user.id,
        orgId: admin.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        ownerUserId: secondAdmin.user.id,
        platformUrl: "http://localhost:3000",
        ttlSeconds: 300,
      }).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(String((refused as { cause?: unknown } | undefined)?.cause)).toContain(
        "model_provider_pairings_owner_is_minter",
      );
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

    it("keeps a personal reconnect for an owner demoted to guest, until the configuration turns personal connections off", async () => {
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

      await disablePersonal(admin.orgId);
      const refused = await redeem(second, "after-policy");
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "personal_connections_disabled",
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
