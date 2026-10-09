// SPDX-License-Identifier: Apache-2.0

/**
 * Whose credential a run spends (#1875).
 *
 * The payer is the run's user when the run was not triggered by an API key:
 * their personal credential serves an org model of the same provider family,
 * otherwise the model's own org binding does. An API-key run has no payer and
 * never spends a personal credential. A model with no usable credential for
 * its payer is refused at kickoff (`model_credential_required`).
 *
 * The sidecar OAuth door serves a personal credential only to runs of its
 * holder: the same pin that gates the run, plus the payer check.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, orgModels, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedApiKey,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedRun,
} from "../../helpers/seed.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";

const app = getTestApp();

const postInline = (headers: Record<string, string>) =>
  app.request("/api/runs/inline", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: inlineAgentManifest(), prompt: "do the thing" }),
  });

describe("run payer — personal model credentials", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "payer-cred" });
  });

  afterEach(waitForRunPipelineSettled);

  /** Org API-key credential bound to an org-default `gpt-5.5`. Returns the credential id. */
  async function seedBoundDefault(): Promise<string> {
    const credentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      ownerUserId: null,
      label: "Org key",
      providerId: "openai",
      apiKey: "sk-org-test-key",
    });
    const modelDbId = await createOrgModel(ctx.orgId, "Team GPT", "gpt-5.5", ctx.user.id, {
      credentialId,
    });
    await setDefaultModel(ctx.orgId, modelDbId);
    return credentialId;
  }

  /** Org-default `gpt-5.5` with no credential: each payer must bring their own. */
  async function seedUnboundDefault(): Promise<void> {
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Shared GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });
    await setDefaultModel(ctx.orgId, row!.id);
  }

  /**
   * A personal openai API-key credential held by `ownerId`. Seeded directly: the
   * harness makes every provider `baseUrlOverridable`, which the service refuses
   * for a personal credential (`personal_credential_custom_endpoint`).
   */
  async function seedPersonalKey(ownerId: string, label: string): Promise<string> {
    const row = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      createdBy: ownerId,
      ownerUserId: ownerId,
      label,
      providerId: "openai",
      apiKey: `sk-personal-${label}`,
    });
    return row.id;
  }

  /**
   * Launch an inline run as `launchHeaders` and return the `model_credential_id`
   * it stamped, read back as `readHeaders` (a key may launch but not read).
   */
  async function launchedCredentialId(
    launchHeaders: Record<string, string>,
    readHeaders: Record<string, string> = launchHeaders,
  ): Promise<string | null> {
    const res = await postInline(launchHeaders);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const detail = await app.request(`/api/runs/${id}`, { headers: readHeaders });
    expect(detail.status).toBe(200);
    return ((await detail.json()) as { modelCredentialId: string | null }).modelCredentialId;
  }

  it("a member's manual run spends their own key on an org model", async () => {
    await seedBoundDefault();
    const member = await memberContext(ctx, "member", "builder");
    const personalId = await seedPersonalKey(member.user.id, "member-key");

    expect(await launchedCredentialId(authHeaders(member))).toBe(personalId);
  });

  it("the org owner without a personal key still runs on the org credential", async () => {
    const orgCredentialId = await seedBoundDefault();

    expect(await launchedCredentialId(authHeaders(ctx))).toBe(orgCredentialId);
  });

  it("an API-key run spends the org credential, never a personal one", async () => {
    const orgCredentialId = await seedBoundDefault();
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id, "member-key");
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: member.user.id,
      scopes: ["agents:write", "agents:run"],
    });

    expect(
      await launchedCredentialId({ Authorization: `Bearer ${key.rawKey}` }, authHeaders(ctx)),
    ).toBe(orgCredentialId);
  });

  it("refuses a run on an unbound model when the payer has no personal key", async () => {
    await seedUnboundDefault();
    const member = await memberContext(ctx, "member", "builder");

    const res = await postInline(authHeaders(member));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("serves an unbound model through the payer's personal key", async () => {
    await seedUnboundDefault();
    const member = await memberContext(ctx, "member", "builder");
    const personalId = await seedPersonalKey(member.user.id, "member-key");

    expect(await launchedCredentialId(authHeaders(member))).toBe(personalId);
  });

  it("serves a personal OAuth credential only to runs of its holder", async () => {
    const member = await memberContext(ctx, "member", "builder");
    const agentId = `@${ctx.org.slug}/payer-agent`;
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    const oauth = await seedOrgModelProviderOAuth({ orgId: ctx.orgId });
    await db
      .update(modelProviderCredentials)
      .set({ ownerUserId: ctx.user.id })
      .where(eq(modelProviderCredentials.id, oauth.id));

    const pinnedRun = (userId: string) =>
      seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId,
        status: "running",
        modelCredentialId: oauth.id,
      });
    const tokenOf = async (userId: string) => signRunToken((await pinnedRun(userId)).id);
    const read = (token: string) =>
      app.request(`/internal/oauth-token/${oauth.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    try {
      expect((await read(await tokenOf(member.user.id))).status).toBe(403);
      expect((await read(await tokenOf(ctx.user.id))).status).toBe(200);
    } finally {
      // The door serves only runs still `running`; settle them so the afterEach
      // pipeline wait sees every run terminal.
      await db.update(runs).set({ status: "success" }).where(eq(runs.modelCredentialId, oauth.id));
    }
  });
});
