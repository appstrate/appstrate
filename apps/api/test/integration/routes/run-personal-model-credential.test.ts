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
import { updateOrgSettings } from "../../../src/services/organizations.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { clearResolvedModelCache } from "../../../src/services/resolved-model-cache.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import type { AppstrateModule, BeforeUsageParams, ModuleInitContext } from "@appstrate/core/module";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { TEST_OAUTH_MODEL_ID } from "../../helpers/test-oauth-provider.ts";

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

  it("stops the sidecar's subscription door for a holder's pinned run once personal credentials are switched off", async () => {
    const agentId = `@${ctx.org.slug}/door-agent`;
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    const oauth = await seedOrgModelProviderOAuth({ orgId: ctx.orgId });
    await db
      .update(modelProviderCredentials)
      .set({ ownerUserId: ctx.user.id })
      .where(eq(modelProviderCredentials.id, oauth.id));
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      modelCredentialId: oauth.id,
    });
    const token = await signRunToken(run.id);
    const read = () =>
      app.request(`/internal/oauth-token/${oauth.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    try {
      expect((await read()).status).toBe(200);
      await updateOrgSettings(ctx.orgId, { personal_model_credentials: false });
      expect((await read()).status).toBe(403);
    } finally {
      await db.update(runs).set({ status: "success" }).where(eq(runs.modelCredentialId, oauth.id));
    }
  });

  // ── the other doors ───────────────────────────────────────

  it("lists a model as billed to the caller's own key, and to the org for an API key", async () => {
    await seedBoundDefault();
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id, "member-key");
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: member.user.id,
      scopes: ["models:read"],
    });
    const [model] = await db
      .select({ id: orgModels.id })
      .from(orgModels)
      .where(eq(orgModels.orgId, ctx.orgId));
    const orgModelId = model!.id;

    const billedTo = async (headers: Record<string, string>) => {
      const res = await app.request("/api/models", { headers });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { id: string; billed_to: string | null }[] };
      return data.find((m) => m.id === orgModelId)?.billed_to;
    };

    expect(await billedTo(authHeaders(member))).toBe("user");
    expect(await billedTo({ Authorization: `Bearer ${key.rawKey}` })).toBe("org");
  });

  it("refuses to discover another member's personal credential as absent", async () => {
    const member = await memberContext(ctx, "member", "builder");
    const personalId = await seedPersonalKey(member.user.id, "member-key");

    const res = await app.request("/api/model-provider-credentials/discover", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentialId: personalId }),
    });
    expect(res.status).toBe(404);
  });
});

describe("run admission — the credential a run spends is the one admitted", () => {
  const SYSTEM_MODEL = "sys-admission-gpt";
  let ctx: TestContext;
  let member: TestContext;
  let personalId: string;

  function fakeInitCtx(): ModuleInitContext {
    return {
      redisUrl: null,
      appUrl: "http://localhost:3000",
      getSendMail: async () => async () => {},
      getOrgOwnerEmails: async () => [],
      getOrgMembers: async () => [],
      getOrgName: async () => null,
      services: {} as ModuleInitContext["services"],
    };
  }

  /** A gate whose `beforeUsage` runs `beforeAdmit` and then admits the run. */
  function gateModule(
    beforeAdmit: () => Promise<void>,
    calls: BeforeUsageParams[],
  ): AppstrateModule {
    return {
      manifest: { id: "test-admission-gate", name: "Gate", version: "0.0.0" },
      async init() {},
      hooks: {
        beforeUsage: async (params) => {
          calls.push(params);
          await beforeAdmit();
          return null;
        },
      },
    };
  }

  /**
   * The member's own openai key serves `modelId` (the system model by default): the
   * run is admitted on it.
   */
  async function launchAsMember(modelId: string = SYSTEM_MODEL) {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(member), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: inlineAgentManifest(),
        prompt: "do the thing",
        modelId,
      }),
    });
  }

  /**
   * An org model bound to the organization's own key. The member's personal key of
   * the same family serves it before the org key does, so the gate admits the run on
   * the personal key (source "org"), and the org key is the next credential in line.
   */
  async function seedOrgBoundModel(): Promise<string> {
    const orgCredentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      ownerUserId: null,
      label: "Org key",
      providerId: "openai",
      apiKey: "sk-org-admission",
    });
    return createOrgModel(ctx.orgId, "Team GPT", "gpt-5.5", ctx.user.id, {
      credentialId: orgCredentialId,
    });
  }

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  beforeEach(async () => {
    await truncateAll();
    resetModules();
    ctx = await createTestContext({ orgSlug: "admission-race" });
    member = await memberContext(ctx, "member", "builder");
    // The system key of the family, and the member's own key of the same family.
    initSystemModelProviderKeys([
      {
        id: "sys-openai-admission",
        providerId: "openai",
        apiKey: "sk-system",
        models: [{ id: SYSTEM_MODEL, modelId: TEST_OAUTH_MODEL_ID }],
      },
    ]);
    personalId = (
      await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        createdBy: member.user.id,
        ownerUserId: member.user.id,
        label: "member-key",
        providerId: "openai",
        apiKey: "sk-personal-member",
      })
    ).id;
  });

  afterEach(waitForRunPipelineSettled);

  afterAll(async () => {
    _setOrchestratorForTesting(null);
    resetModules();
    initSystemModelProviderKeys([]);
    await restoreDiscoveredModules();
  });

  it("refuses a run whose personal credential is removed by the admission gate, and spends no system key", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(async () => {
          await db
            .delete(modelProviderCredentials)
            .where(eq(modelProviderCredentials.id, personalId));
          clearResolvedModelCache();
        }, calls),
      ],
      fakeInitCtx(),
    );

    const res = await launchAsMember();

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_changed");
    // The gate quoted the member's own key; the run was refused before any row existed.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ credentialSource: "org" });
    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId))).toEqual(
      [],
    );
  });

  it("refuses an org-model run whose personal credential is removed by the admission gate, and spends no org key", async () => {
    // The old check compared the credential SOURCE only: the org key is also "org",
    // so the launch went through on it.
    const orgModelId = await seedOrgBoundModel();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(async () => {
          await db
            .delete(modelProviderCredentials)
            .where(eq(modelProviderCredentials.id, personalId));
          clearResolvedModelCache();
        }, calls),
      ],
      fakeInitCtx(),
    );

    const res = await launchAsMember(orgModelId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_changed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ credentialSource: "org" });
    expect(await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId))).toEqual(
      [],
    );
  });

  it("admits the org-model run on the member's personal key when the gate removes nothing (control)", async () => {
    const orgModelId = await seedOrgBoundModel();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(async () => {}, calls)], fakeInitCtx());

    const res = await launchAsMember(orgModelId);

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ credentialSource: "org" });
    const stamped = await db
      .select({ modelCredentialId: runs.modelCredentialId })
      .from(runs)
      .where(eq(runs.orgId, ctx.orgId));
    expect(stamped).toEqual([{ modelCredentialId: personalId }]);
  });

  it("admits the same run when the gate removes nothing (control)", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(async () => {}, calls)], fakeInitCtx());

    const res = await launchAsMember();

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ credentialSource: "org" });
    expect(
      await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId)),
    ).toHaveLength(1);
  });
});
