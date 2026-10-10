// SPDX-License-Identifier: Apache-2.0

/**
 * `checkUsageAllowed` — the chat-surface entry into the unified `beforeUsage`
 * admission hook (`services/chat-platform-services.ts`). The chat module calls it
 * before starting ANY turn — built-in, API-key, or oauth-subscription. The gate
 * resolves system-provided vs. org-owned SERVER-SIDE so the chat module stays
 * dumb, but that resolution is REPORTED, not used to pre-filter:
 *
 *   - every turn dispatches the hook, carrying `credentialSource`
 *     (`"system"` | `"org"` | `"user"`) and `executionPlane: "platform"` (a chat turn
 *     always runs in the platform's own process);
 *   - an org-credential turn is dispatched too — the platform no longer
 *     declares it free, the module quotes it (typically at zero) and decides;
 *   - no metering module → null (OSS allows all);
 *   - a metering module's rejection flows straight back (a 402 the route turns
 *     into problem+json);
 *   - a subscription turn (`subscription: true`, the one fact the chat module
 *     owns) reports the owner of the credential its preset resolves to, and is
 *     dispatched like any other — it runs inline in the platform's own process;
 *   - a preset that resolves to nothing reports nothing: no hook, no spend;
 *   - an organization whose deletion is reserved is refused before any of that,
 *     hook or no hook: its usage rows would be cascade-deleted unaccounted for.
 *   - a model no credential of the session user serves is refused, hook or no
 *     hook: the turn could not run anyway.
 *
 * These are the exact facts a metering module (the ee module) quotes against, so a
 * regression that stopped reporting one — or resurrected the old "skip the hook
 * for an org model" short-circuit — surfaces here rather than as a billing
 * incident.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations, orgModels } from "@appstrate/db/schema";
import { checkUsageAllowed } from "../../../src/services/chat-platform-services.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";
import type {
  AppstrateModule,
  ModuleInitContext,
  BeforeUsageParams,
  UsageRejection,
} from "@appstrate/core/module";

const SYSTEM_PRESET = "sys-chat-model";

/** The test organization and its session user, created fresh for each test. */
let ORG_ID = "";
let USER_ID = "";
/** An org-owned model bound to the org's own API key (not a system preset). */
let orgPresetId = "";

/** An unbound openai org model: each member's own key of the family serves it. */
async function seedUnboundOpenAiPreset(): Promise<string> {
  const model = await seedOrgModel({
    orgId: ORG_ID,
    providerId: "openai",
    credentialId: null,
    label: "Shared GPT",
    modelId: "gpt-5.5",
    enabled: true,
  });
  return model.id;
}

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

/** A module whose `beforeUsage` records its args and returns a scripted result. */
function gateModule(result: UsageRejection | null, calls: BeforeUsageParams[]): AppstrateModule {
  return {
    manifest: { id: "test-gate", name: "Gate", version: "0.0.0" },
    async init() {},
    hooks: {
      beforeUsage: async (params) => {
        calls.push(params);
        return result;
      },
    },
  };
}

describe("checkUsageAllowed", () => {
  beforeEach(async () => {
    resetModules();
    await truncateAll();
    const ctx = await createTestContext();
    ORG_ID = ctx.orgId;
    USER_ID = ctx.user.id;
    // Register a real system-provided model so the gate can tell it apart from
    // an org's own preset (the whole credential decision hinges on this).
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "sys-key",
        providerId: "test-apikey",
        apiKey: "sk-system",
        models: [{ id: SYSTEM_PRESET, modelId: "gpt-4o-2024-08-06" }],
      },
    ]);
    // An org-owned preset: a real org credential, bound through `org_models`.
    const orgKey = await seedOrgModelProviderKey({
      orgId: ORG_ID,
      label: "Org key",
      providerId: "test-apikey",
      apiShape: "openai-completions",
      apiKey: "sk-org",
    });
    const model = await seedOrgModel({
      orgId: ORG_ID,
      providerId: "test-apikey",
      credentialId: orgKey.id,
      label: "Org preset",
      modelId: "gpt-4o-2024-08-06",
      enabled: true,
    });
    orgPresetId = model.id;
  });

  afterAll(async () => {
    await restoreDiscoveredModules();
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  async function seedUnboundModel(): Promise<string> {
    const [unbound] = await db
      .insert(orgModels)
      .values({
        orgId: ORG_ID,
        providerId: "test-apikey",
        credentialId: null,
        label: "Unbound",
        modelId: "gpt-4o-2024-08-06",
        enabled: true,
      })
      .returning();
    return unbound!.id;
  }

  it("refuses a turn on a model no credential of the session user serves, with or without a hook", async () => {
    const presetId = await seedUnboundModel();
    const turn = {
      orgId: ORG_ID,
      presetId,
      sessionId: "chs_unbound",
      subscription: false,
      userId: USER_ID,
    };
    // A platform rule, not an admission decision: OSS refuses it too.
    expect(await checkUsageAllowed(turn)).toMatchObject({
      code: "model_credential_required",
      status: 409,
    });

    // With a hook, the turn is refused before the hook is dispatched.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());
    expect(await checkUsageAllowed(turn)).toMatchObject({
      code: "model_credential_required",
      status: 409,
    });
    expect(calls).toHaveLength(0);
  });

  it("admits a preset that does not resolve without dispatching the hook: nothing can be spent", async () => {
    // An unknown preset fails at model resolution downstream; there is no payer
    // to report, so no source is invented for the module to quote.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "blocked", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: "00000000-0000-4000-a000-0000000000d9",
      sessionId: "chs_missing",
      subscription: false,
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses a turn in an organization whose deletion is reserved", async () => {
    // A platform fact, not a module policy, so it answers with no module loaded.
    // Refused here and not only at the proxy: a rejected turn persists nothing.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());
    const reservedOrgId = "00000000-0000-4000-a000-0000000000c2";
    await db.insert(organizations).values({
      id: reservedOrgId,
      name: "Reserved",
      slug: `reserved-${reservedOrgId.slice(-6)}`,
      deletingAt: new Date(),
    });

    try {
      const result = await checkUsageAllowed({
        orgId: reservedOrgId,
        presetId: SYSTEM_PRESET,
        sessionId: "chs_reserved",
        subscription: false,
        userId: USER_ID,
      });

      expect(result).toEqual({
        code: "org_deleting",
        message: "This organization is being deleted; no new work can be admitted.",
        status: 409,
      });
      expect(calls).toHaveLength(0);

      // Control: the same call, an organization with no reservation.
      await db
        .update(organizations)
        .set({ deletingAt: null })
        .where(eq(organizations.id, reservedOrgId));
      expect(
        await checkUsageAllowed({
          orgId: reservedOrgId,
          presetId: SYSTEM_PRESET,
          sessionId: "chs_reserved",
          subscription: false,
          userId: USER_ID,
        }),
      ).toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, reservedOrgId));
    }
  });

  it("dispatches the hook for an org-owned model with credentialSource 'org'", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_1",
      subscription: false,
      userId: USER_ID,
    });

    // The platform no longer short-circuits an org-credential turn: it reports
    // the fact and lets the module quote it. (A metering module that only
    // meters platform-supplied inference quotes zero and returns null here —
    // same outcome as the old early return, decided by the module.)
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: ORG_ID,
      context: "chat",
      sessionId: "chs_1",
      credentialSource: "org",
      executionPlane: "platform",
    });
  });

  it("lets a metering module reject an org-owned model turn (platform compute is still platform-funded)", async () => {
    // The reversal that matters: a rejecting module CAN now block a BYOK chat
    // turn, because a chat turn always occupies platform compute. Whether it
    // does is the module's policy — the platform no longer forces "allowed".
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "blocked", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_1",
      subscription: false,
      userId: USER_ID,
    });

    expect(result).toEqual({ code: "over_cap", message: "blocked", status: 402 });
    expect(calls).toHaveLength(1);
  });

  it("returns null for a system model when no metering module provides the hook", async () => {
    // No module loaded → OSS mode allows everything.
    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: SYSTEM_PRESET,
      sessionId: "chs_1",
      subscription: false,
      userId: USER_ID,
    });
    expect(result).toBeNull();
  });

  it("passes a metering module's rejection through for a system model (chat context)", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "Soft cap reached", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: SYSTEM_PRESET,
      sessionId: "chs_42",
      subscription: false,
      userId: USER_ID,
    });

    expect(result).toEqual({ code: "over_cap", message: "Soft cap reached", status: 402 });
    // Dispatched with the chat discriminant + the session id (not the run
    // shape), plus the two execution facts the module quotes against.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: ORG_ID,
      context: "chat",
      sessionId: "chs_42",
      credentialSource: "system",
      executionPlane: "platform",
    });
  });

  it("returns null for a system model when the metering module allows the turn", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: SYSTEM_PRESET,
      sessionId: null,
      subscription: false,
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    // An ephemeral (unpersisted) turn dispatches a null session id.
    expect(calls[0]!.context).toBe("chat");
    expect((calls[0] as { sessionId: string | null }).sessionId).toBeNull();
  });

  it("reports a subscription turn by the credential its preset resolves to", async () => {
    // The payer is the owner of the credential the turn spends, not the
    // credential mode the caller reported: a system preset is the platform's.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: SYSTEM_PRESET,
      sessionId: "chs_sub",
      subscription: true,
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toEqual([
      {
        orgId: ORG_ID,
        context: "chat",
        sessionId: "chs_sub",
        credentialSource: "system",
        // The in-process Pi engine still runs inside the platform's process.
        executionPlane: "platform",
      },
    ]);
  });

  it("lets a metering module reject a subscription turn (platform compute is platform-funded)", async () => {
    // The reversal that closes the escape: a subscription turn used to skip
    // admission entirely, so a suspended organization could keep driving the
    // platform's own process indefinitely.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "subscription_suspended", message: "Suspended", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_sub",
      subscription: true,
      userId: USER_ID,
    });

    expect(result).toEqual({ code: "subscription_suspended", message: "Suspended", status: 402 });
    expect(calls).toHaveLength(1);
    // An organization-bound preset is the organization's spend, subscription or not.
    expect(calls[0]!.credentialSource).toBe("org");
  });

  it("rejects a caller that omits `subscription` (module built against core < 6.0.0)", async () => {
    // Fail-closed: the flag became required in core 6.0.0. Defaulting it would
    // read a subscription turn as platform-funded — silent mispricing. Only an
    // out-of-tree stale module can reach this (in-tree callers are typechecked,
    // hence the cast).
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    await expect(
      checkUsageAllowed({
        orgId: ORG_ID,
        presetId: SYSTEM_PRESET,
        sessionId: "chs_stale",
      } as never),
    ).rejects.toThrow("`subscription` is required");
    // The turn is denied BEFORE the admission hook sees a fabricated fact.
    expect(calls).toHaveLength(0);
  });

  it("still returns null for a stale caller in OSS mode (no hook prices the turn)", async () => {
    // The guard above exists to keep a fabricated fact out of an admission
    // hook — so with no hook loaded there is nothing to protect, and a stale
    // caller must keep getting the `null` OSS always gave it rather than a 500.
    await loadModulesFromInstances([], fakeInitCtx());

    await expect(
      checkUsageAllowed({
        orgId: ORG_ID,
        presetId: SYSTEM_PRESET,
        sessionId: "chs_oss",
      } as never),
    ).resolves.toBeNull();
  });

  it("admits a turn on an unbound model the session user holds a personal key for, reporting credentialSource 'user'", async () => {
    const presetId = await seedUnboundOpenAiPreset();
    await seedOrgModelProviderKey({
      orgId: ORG_ID,
      createdBy: USER_ID,
      ownerUserId: USER_ID,
      label: "Mine",
      providerId: "openai",
      apiKey: "sk-mine",
    });
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    expect(
      await checkUsageAllowed({
        orgId: ORG_ID,
        presetId,
        sessionId: "chs_personal",
        subscription: false,
        userId: USER_ID,
      }),
    ).toBeNull();
    expect(calls).toEqual([
      {
        orgId: ORG_ID,
        context: "chat",
        sessionId: "chs_personal",
        credentialSource: "user",
        executionPlane: "platform",
      },
    ]);
  });
});
