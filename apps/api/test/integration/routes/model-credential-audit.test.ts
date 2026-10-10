// SPDX-License-Identifier: Apache-2.0

/**
 * Audit trail of model provider credentials: who deleted a personal credential
 * (break-glass or the owner), that a rotation is recorded without its key, and
 * which personal credentials a member's removal took with it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { auditEvents } from "@appstrate/db/schema";
import {
  createApiKeyCredential,
  createOAuthCredential,
} from "../../../src/services/model-providers/credentials.ts";

const app = getTestApp();

const CREDENTIALS = "/api/model-provider-credentials";
const OAUTH_PROVIDER = "test-oauth";
const ORG_KEY_PROVIDER = "test-apikey";

async function auditFor(action: string, resourceId: string) {
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, resourceId)));
  return event;
}

describe("model credential audit", () => {
  let admin: TestContext;
  let member: TestContext;
  let otherMember: TestContext;

  beforeEach(async () => {
    await truncateAll();
    seedTestModelProviders();
    admin = await createTestContext();
    member = await memberContext(admin, "member");
    otherMember = await memberContext(admin, "member");
  });

  it("records the owner of a deleted personal credential, and breakGlass only when an admin removes it", async () => {
    const id = await createOAuthCredential({
      orgId: admin.orgId,
      userId: member.user.id,
      label: "Member subscription",
      providerId: OAUTH_PROVIDER,
      accessToken: "at-member",
      refreshToken: "rt-member",
    });

    const res = await app.request(`${CREDENTIALS}/${id}`, {
      method: "DELETE",
      headers: authHeaders(admin),
    });
    expect(res.status).toBe(204);
    const event = await auditFor("model_provider_credential.deleted", id);
    expect(event!.before).toEqual({
      ownerType: "user",
      ownerId: member.user.id,
      providerId: OAUTH_PROVIDER,
      label: "Member subscription",
      breakGlass: true,
    });
  });

  it("records a member's own personal deletion without breakGlass", async () => {
    const id = await createOAuthCredential({
      orgId: admin.orgId,
      userId: member.user.id,
      label: "Own subscription",
      providerId: OAUTH_PROVIDER,
      accessToken: "at-own",
      refreshToken: "rt-own",
    });

    const res = await app.request(`${CREDENTIALS}/${id}`, {
      method: "DELETE",
      headers: authHeaders(member),
    });
    expect(res.status).toBe(204);
    const event = await auditFor("model_provider_credential.deleted", id);
    expect(event!.before).toEqual({
      ownerType: "user",
      ownerId: member.user.id,
      providerId: OAUTH_PROVIDER,
      label: "Own subscription",
    });
    expect(event!.before).not.toHaveProperty("breakGlass");
  });

  it("records a rotation as rotated, and never the key itself", async () => {
    const id = await createApiKeyCredential({
      orgId: admin.orgId,
      userId: admin.user.id,
      label: "Org key",
      providerId: ORG_KEY_PROVIDER,
      apiKey: "sk-before",
    });
    const secret = "sk-rotated-secret-do-not-audit";

    const res = await app.request(`${CREDENTIALS}/${id}`, {
      method: "PATCH",
      headers: authHeaders(admin, { "Content-Type": "application/json" }),
      body: JSON.stringify({ api_key: secret }),
    });
    expect(res.status).toBe(200);
    const event = await auditFor("model_provider_credential.updated", id);
    expect(event!.after).toEqual({ rotated: true });
    expect(JSON.stringify(event!.after)).not.toContain(secret);
  });

  it("lists the personal credentials a removed member took with it", async () => {
    const personalId = await createOAuthCredential({
      orgId: admin.orgId,
      userId: otherMember.user.id,
      label: "Departing subscription",
      providerId: OAUTH_PROVIDER,
      accessToken: "at-departing",
      refreshToken: "rt-departing",
    });

    const res = await app.request(`/api/orgs/${admin.orgId}/members/${otherMember.user.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie },
    });
    expect(res.status).toBe(204);
    const event = await auditFor("org.member_removed", otherMember.user.id);
    expect(
      (event!.after as { deletedModelCredentialIds: string[] }).deletedModelCredentialIds,
    ).toEqual([personalId]);
  });
});
