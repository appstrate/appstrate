// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0042` against the test database: a subscription whose creator is still a member
 * becomes theirs; an orphan (no creator, or a creator who has left the organization) and its
 * pairings are deleted; every organization model bound to a subscription is unbound; an API-key
 * credential is left alone; a dry run writes nothing; a re-run is a no-op; the report names the
 * members who ran on a subscription they do not own; a blob that does not decrypt is reported and
 * kept, and fails `--apply` at the end; an aliased model or a pending/running run pinned to a
 * subscription makes `--apply` refuse its organization (the dry run reports both), and so do a
 * schedule overriding its model with a model it unbinds and two models it would unbind to one
 * (provider, model) pair; a pending reconnect pairing minted by anyone but the new owner is
 * deleted; the organization default and the agents on an unbound model are reported.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  modelProviderCredentials,
  modelProviderPairings,
  organizationMembers,
  organizations,
  orgModels,
} from "@appstrate/db/schema";
import { runPersonalModelSubscriptions } from "../migration/0042-personal-model-subscriptions.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../apps/api/test/helpers/auth.ts";
import {
  corruptCredentialBlob,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedPackage,
  seedRun,
  seedSchedule,
  seedSpacePackage,
} from "../../apps/api/test/helpers/seed.ts";

const AGENT = "@mig0042/agent";
const SUBSCRIPTION_PROVIDER = "test-oauth";

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) =>
  runPersonalModelSubscriptions({ apply, out: (line) => lines.push(line) });

async function rowOf(id: string) {
  const [row] = await db
    .select()
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, id));
  return row;
}

async function modelOf(id: string) {
  const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
  return row!;
}

async function seedPairing(credentialId: string): Promise<string> {
  const id = `pair_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(modelProviderPairings).values({
    id,
    tokenHash: crypto.randomUUID(),
    userId: ctx.user.id,
    orgId: ctx.orgId,
    providerId: SUBSCRIPTION_PROVIDER,
    expiresAt: new Date(Date.now() + 3600_000),
    credentialId,
  });
  return id;
}

async function seedReconnectPairing(credentialId: string, userId: string): Promise<string> {
  const id = `pair_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.insert(modelProviderPairings).values({
    id,
    tokenHash: crypto.randomUUID(),
    userId,
    orgId: ctx.orgId,
    providerId: SUBSCRIPTION_PROVIDER,
    expiresAt: new Date(Date.now() + 3600_000),
    reconnectCredentialId: credentialId,
  });
  return id;
}

async function pairingExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: modelProviderPairings.id })
    .from(modelProviderPairings)
    .where(eq(modelProviderPairings.id, id));
  return rows.length > 0;
}

describe("0042 — model subscriptions become personal", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0042" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId });
  });

  it("a dry run reports what it would do and writes nothing", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
      label: "Abonnement",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-dry",
    });

    const result = await run(false);

    expect(lines.at(-1)).toContain("DRY RUN");
    expect(lines).toContain("to migrate: 1");
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]!.owned.map((r) => r.id)).toEqual([owned.id]);
    expect((await rowOf(owned.id))!.ownerUserId).toBeNull();
    expect((await modelOf(model.id)).credentialId).toBe(owned.id);
  });

  it("apply re-homes subscriptions, deletes orphans and their pairings, unbinds models, leaves API keys", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const orphan = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: null,
    });
    const orphanPairing = await seedPairing(orphan.id);
    const ownedModel = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-owned",
    });
    const orphanModel = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: orphan.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-orphan",
    });
    const apiKey = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "openai",
      createdBy: ctx.user.id,
    });
    const keyModel = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: apiKey.id,
      providerId: "openai",
      modelId: "m-key",
    });
    const apiKeyBefore = await rowOf(apiKey.id);

    await run(true);

    expect(lines.at(-1)).toBe("0042: APPLIED — committed.");
    expect((await rowOf(owned.id))!.ownerUserId).toBe(ctx.user.id);
    expect(await rowOf(orphan.id)).toBeUndefined();
    expect(await pairingExists(orphanPairing)).toBe(false);
    expect((await modelOf(ownedModel.id)).credentialId).toBeNull();
    expect((await modelOf(ownedModel.id)).providerId).toBe(SUBSCRIPTION_PROVIDER);
    expect((await modelOf(orphanModel.id)).credentialId).toBeNull();
    expect((await modelOf(keyModel.id)).credentialId).toBe(apiKey.id);
    expect(await rowOf(apiKey.id)).toEqual(apiKeyBefore!);
  });

  it("a subscription whose creator has left the organization is an orphan: deleted with its pairings", async () => {
    const leaver = await createTestUser();
    await addOrgMember(ctx.orgId, leaver.id, "member");
    const subscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: leaver.id,
    });
    const pairing = await seedPairing(subscription.id);
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: subscription.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-leaver",
    });
    await db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, leaver.id)),
      );

    const result = await run(true);

    expect(result.orgs[0]!.owned).toEqual([]);
    expect(result.orgs[0]!.orphans.map((r) => r.id)).toEqual([subscription.id]);
    expect(await rowOf(subscription.id)).toBeUndefined();
    expect(await pairingExists(pairing)).toBe(false);
    expect((await modelOf(model.id)).credentialId).toBeNull();
    expect((await modelOf(model.id)).providerId).toBe(SUBSCRIPTION_PROVIDER);
  });

  it("a re-run is a no-op", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-rerun",
    });
    await run(true);
    const after = await rowOf(owned.id);

    lines.length = 0;
    const result = await run(true);

    expect(lines).toContain("to migrate: 0");
    expect(lines).toContain("left to migrate: 0");
    expect(result.orgs).toEqual([]);
    expect(await rowOf(owned.id)).toEqual(after!);
  });

  it("reports the members who ran on a subscription they do not own, orphans included", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const orphan = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: null,
    });
    const seedRunOn = (userId: string, modelCredentialId: string) =>
      seedRun({
        packageId: AGENT,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId,
        modelCredentialId,
      });
    await seedRunOn(member.id, owned.id);
    await seedRunOn(member.id, owned.id);
    await seedRunOn(ctx.user.id, owned.id);
    await seedRunOn(member.id, orphan.id);

    const result = await run(false);

    expect(result.orgs[0]!.usersOnOthersSubscriptions.map((u) => u.id)).toEqual([member.id]);
    expect(lines).toContain(
      `  users on subscriptions they do not own: ${member.email} (${member.id})`,
    );
  });

  it("a blob that does not decrypt is reported and kept, not deleted", async () => {
    const broken = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: null,
      label: "Illisible",
    });
    await corruptCredentialBlob(broken.id);

    const result = await run(false);

    expect(result.unreadable.map((r) => r.id)).toEqual([broken.id]);
    expect(lines).toContain(`unreadable, skipped (not deleted): ${broken.id} "Illisible"`);
    expect(await rowOf(broken.id)).toBeDefined();
  });

  it("apply fails at the end while an unreadable org-owned blob remains; other organizations stay committed", async () => {
    const broken = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: null,
      label: "Illisible",
    });
    await corruptCredentialBlob(broken.id);
    const other = await createTestContext({ orgSlug: "mig0042b" });
    const owned = await seedOrgModelProviderOAuth({
      orgId: other.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: other.user.id,
    });

    await expect(run(true)).rejects.toThrow(`${broken.id} "Illisible"`);

    expect((await rowOf(owned.id))!.ownerUserId).toBe(other.user.id);
    expect(await rowOf(broken.id)).toBeDefined();
  });

  it("an aliased model bound to a subscription: the dry run reports it, apply refuses and writes nothing for that org", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-alias",
      label: "Alias",
      aliased: true,
    });

    const dry = await run(false);

    expect(dry.orgs[0]!.aliasedModels.map((m) => m.id)).toEqual([model.id]);
    expect(lines).toContain(`  aliased model ${model.id} "Alias" blocks --apply`);
    expect((await modelOf(model.id)).credentialId).toBe(owned.id);

    await expect(run(true)).rejects.toThrow(`${model.id} "Alias"`);

    expect((await rowOf(owned.id))!.ownerUserId).toBeNull();
    expect((await modelOf(model.id)).credentialId).toBe(owned.id);
  });

  it("a running run pinned to a subscription: the dry run reports it, apply refuses and writes nothing for that org", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-busy",
    });
    const busy = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelCredentialId: owned.id,
      status: "running",
    });

    const dry = await run(false);

    expect(dry.orgs[0]!.activeRuns.map((r) => r.id)).toEqual([busy.id]);
    expect(lines).toContain(`  active run ${busy.id} blocks --apply`);

    await expect(run(true)).rejects.toThrow(busy.id);

    expect((await rowOf(owned.id))!.ownerUserId).toBeNull();
    expect((await modelOf(model.id)).credentialId).toBe(owned.id);
  });

  it("a finished run pinned to a subscription does not block apply", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-done",
    });
    await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelCredentialId: owned.id,
      status: "success",
    });

    const result = await run(true);

    expect(result.orgs[0]!.activeRuns).toEqual([]);
    expect(lines.at(-1)).toBe("0042: APPLIED — committed.");
    expect((await rowOf(owned.id))!.ownerUserId).toBe(ctx.user.id);
    expect((await modelOf(model.id)).credentialId).toBeNull();
  });

  it("deletes a pending reconnect pairing minted by anyone but the subscription's new owner", async () => {
    const admin = await createTestUser();
    await addOrgMember(ctx.orgId, admin.id, "admin");
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const byAdmin = await seedReconnectPairing(owned.id, admin.id);
    const byOwner = await seedReconnectPairing(owned.id, ctx.user.id);

    const result = await run(true);

    expect(result.orgs[0]!.pairingsDeleted).toBe(1);
    expect(await pairingExists(byAdmin)).toBe(false);
    expect(await pairingExists(byOwner)).toBe(true);
  });

  it("a schedule overriding its model with a model it unbinds: reported, apply refuses", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-scheduled",
    });
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelIdOverride: model.id,
    });

    const dry = await run(false);

    expect(dry.orgs[0]!.scheduleOverrides).toEqual([{ id: schedule.id, modelId: model.id }]);
    await expect(run(true)).rejects.toThrow(schedule.id);
    expect((await rowOf(owned.id))!.ownerUserId).toBeNull();
    expect((await modelOf(model.id)).credentialId).toBe(owned.id);
  });

  it("two models it would unbind to one provider and model id: reported, apply refuses", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const mine = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const theirs = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: member.id,
    });
    await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: mine.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-twin",
    });
    const twin = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: theirs.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-twin",
    });

    const dry = await run(false);

    expect(dry.orgs[0]!.duplicateUnbound.map((m) => m.id)).toEqual([twin.id]);
    await expect(run(true)).rejects.toThrow(twin.id);
    expect((await modelOf(twin.id)).credentialId).toBe(theirs.id);
  });

  it("reports the organization default and the agents left on a model it unbinds", async () => {
    const owned = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: SUBSCRIPTION_PROVIDER,
      createdBy: ctx.user.id,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: owned.id,
      providerId: SUBSCRIPTION_PROVIDER,
      modelId: "m-default",
    });
    await db
      .update(organizations)
      .set({ defaultModelId: model.id })
      .where(eq(organizations.id, ctx.orgId));
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: model.id });

    const result = await run(true);

    expect(result.orgs[0]!.defaultModelUnbound).toBe(model.id);
    expect(result.orgs[0]!.agentModels).toEqual([
      { spaceId: ctx.defaultSpaceId, packageId: AGENT, modelId: model.id },
    ]);
    expect((await modelOf(model.id)).credentialId).toBeNull();
  });
});
