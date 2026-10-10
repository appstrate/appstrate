// SPDX-License-Identifier: Apache-2.0

/**
 * `checkUsageAllowed` — the chat-surface entry into the unified `beforeUsage`
 * admission hook (`services/chat-platform-services.ts`). The chat module calls it
 * before starting ANY turn — built-in, API-key, or oauth-subscription. The gate
 * resolves system-provided vs. org-owned SERVER-SIDE so the chat module stays
 * dumb, but that resolution is REPORTED, not used to pre-filter:
 *
 *   - every turn dispatches the hook, carrying `credentialSource`
 *     (`"system"` | `"org"`) and `executionPlane: "platform"` (a chat turn
 *     always runs in the platform's own process);
 *   - an org-credential turn is dispatched too — the platform no longer
 *     declares it free, the module quotes it (typically at zero) and decides;
 *   - no metering module → null (OSS allows all);
 *   - a metering module's rejection flows straight back (a 402 the route turns
 *     into problem+json);
 *   - a subscription turn (`subscription: true`, the one fact the chat module
 *     owns) is `"org"` whatever its preset resolves to, and is dispatched like
 *     any other — it runs inline in the platform's own process;
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
import {
  admittedChatTurnPin,
  recordChatTurnAdmission,
  recordSubscriptionTurn,
} from "../../../src/services/system-proxy-admission.ts";
import { deleteModelProviderCredential } from "../../../src/services/model-providers/credentials.ts";
import { ApiError } from "../../../src/lib/errors.ts";
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
const OPENAI_PRESET = "sys-chat-openai";

/** The error `fn` throws, or `undefined` when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The test organization and its session user, created fresh for each test. */
let ORG_ID = "";
let USER_ID = "";
/** An org-owned model bound to the org's own API key (not a system preset). */
let orgPresetId = "";
let orgKeyId = "";

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
    orgKeyId = orgKey.id;
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

  it("refuses a turn on a model no credential serves, before the hook is dispatched", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: await seedUnboundModel(),
      sessionId: "chs_unbound",
      subscription: false,
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toMatchObject({ code: "model_credential_required", status: 409 });
    expect(calls).toHaveLength(0);
  });

  it("refuses a turn on a model no credential serves when no module provides the hook", async () => {
    // A platform rule, not an admission decision: OSS refuses it too.
    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: await seedUnboundModel(),
      sessionId: "chs_unbound",
      subscription: false,
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toMatchObject({ code: "model_credential_required", status: 409 });
  });

  it("dispatches the hook for a preset that does not resolve, reporting credentialSource 'org'", async () => {
    // An unknown preset fails at model resolution, but the admission hook is not
    // skipped: the module decides on every turn, and the turn reports "org".
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
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toEqual({ code: "over_cap", message: "blocked", status: 402 });
    expect(calls).toEqual([
      {
        orgId: ORG_ID,
        context: "chat",
        sessionId: "chs_missing",
        credentialSource: "org",
        executionPlane: "platform",
      },
    ]);
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
        turnId: "turn_test",
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
          turnId: "turn_test",
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
      turnId: "turn_test",
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
      turnId: "turn_test",
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
      turnId: "turn_test",
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
      turnId: "turn_test",
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
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    // An ephemeral (unpersisted) turn dispatches a null session id.
    expect(calls[0]!.context).toBe("chat");
    expect((calls[0] as { sessionId: string | null }).sessionId).toBeNull();
  });

  it("reports a subscription turn as credentialSource 'org' even on a system-registered preset", async () => {
    // A subscription turn spends the org's OWN OAuth provider subscription, so
    // the credential source is `org` whatever the preset resolves to — the
    // registry lookup must not win over the fact the caller reported. Pinned on
    // the SYSTEM preset precisely because that is where the two disagree.
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());
    recordSubscriptionTurn({ orgId: ORG_ID, userId: USER_ID, turnId: "turn_test" }, SYSTEM_PRESET, {
      credentialId: null,
      source: "system",
    });

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: SYSTEM_PRESET,
      sessionId: "chs_sub",
      subscription: true,
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toEqual([
      {
        orgId: ORG_ID,
        context: "chat",
        sessionId: "chs_sub",
        credentialSource: "org",
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
    recordSubscriptionTurn({ orgId: ORG_ID, userId: USER_ID, turnId: "turn_test" }, orgPresetId, {
      credentialId: orgKeyId,
      source: "org",
    });

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_sub",
      subscription: true,
      turnId: "turn_test",
      userId: USER_ID,
    });

    expect(result).toEqual({ code: "subscription_suspended", message: "Suspended", status: 402 });
    expect(calls).toHaveLength(1);
  });

  it("admits a subscription turn no credential was handed for (a reconnect answer), pinning nothing", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_sub",
      subscription: true,
      turnId: "turn_unresolved",
      userId: USER_ID,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
    expect(
      thrownBy(() =>
        admittedChatTurnPin(
          { orgId: ORG_ID, userId: USER_ID, turnId: "turn_unresolved" },
          orgPresetId,
        ),
      ),
    ).toBeInstanceOf(ApiError);
  });

  it("refuses a subscription turn whose resolved credential stopped serving before admission", async () => {
    // Resolved for the engine, then deleted: admission never re-resolves onto another credential.
    recordSubscriptionTurn({ orgId: ORG_ID, userId: USER_ID, turnId: "turn_gone" }, orgPresetId, {
      credentialId: orgKeyId,
      source: "org",
    });
    await db.update(orgModels).set({ credentialId: null }).where(eq(orgModels.id, orgPresetId));
    await deleteModelProviderCredential(
      { orgId: ORG_ID, userId: null, readsOrg: true, writesOrg: true, deletesOrg: true },
      orgKeyId,
    );

    const result = await checkUsageAllowed({
      orgId: ORG_ID,
      presetId: orgPresetId,
      sessionId: "chs_sub",
      subscription: true,
      turnId: "turn_gone",
      userId: USER_ID,
    });

    expect(result).toMatchObject({ code: "model_credential_changed", status: 409 });
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

  it("pins an admitted chat turn to the credential that admitted it, for its turn id, preset and user", async () => {
    // A system preset of a provider whose catalog serves its model, so a personal key of
    // that family can serve it: the member's own key is the credential the turn is admitted on.
    initSystemModelProviderKeys([
      {
        id: "sys-key-openai",
        providerId: "openai",
        apiKey: "sk-system-openai",
        models: [{ id: OPENAI_PRESET, modelId: "gpt-5.5" }],
      },
    ]);
    const personal = await seedOrgModelProviderKey({
      orgId: ORG_ID,
      createdBy: USER_ID,
      ownerUserId: USER_ID,
      label: "Mine",
      providerId: "openai",
      apiKey: "sk-mine",
    });
    const admitted = { credentialId: personal.id, source: "org" as const };
    const turnId = "turn_pin";
    expect(
      await checkUsageAllowed({
        orgId: ORG_ID,
        presetId: OPENAI_PRESET,
        sessionId: "chs_pin",
        subscription: false,
        turnId,
        userId: USER_ID,
      }),
    ).toBeNull();

    // The turn's calls are held to the personal key it was admitted on.
    expect(admittedChatTurnPin({ orgId: ORG_ID, userId: USER_ID, turnId }, OPENAI_PRESET)).toEqual(
      admitted,
    );

    // A turn with no session is admitted and pinned the same way.
    const ephemeralTurnId = "turn_pin_ephemeral";
    expect(
      await checkUsageAllowed({
        orgId: ORG_ID,
        presetId: OPENAI_PRESET,
        sessionId: null,
        subscription: false,
        turnId: ephemeralTurnId,
        userId: USER_ID,
      }),
    ).toBeNull();
    expect(
      admittedChatTurnPin(
        { orgId: ORG_ID, userId: USER_ID, turnId: ephemeralTurnId },
        OPENAI_PRESET,
      ),
    ).toEqual(admitted);

    // No admission covers another turn, another preset or another user, nor a
    // call that carries no turn id: each is refused, never re-routed.
    const otherUserId = "00000000-0000-4000-a000-0000000000e1";
    const refused: Array<[Parameters<typeof admittedChatTurnPin>[0], string]> = [
      [{ orgId: ORG_ID, userId: USER_ID, turnId: "turn_unknown" }, OPENAI_PRESET],
      [{ orgId: ORG_ID, userId: USER_ID, turnId }, SYSTEM_PRESET],
      [{ orgId: ORG_ID, userId: otherUserId, turnId }, OPENAI_PRESET],
      [{ orgId: ORG_ID, userId: USER_ID, turnId: null }, OPENAI_PRESET],
    ];
    for (const [turn, presetId] of refused) {
      const refusal = thrownBy(() => admittedChatTurnPin(turn, presetId));
      expect(refusal).toBeInstanceOf(ApiError);
      expect((refusal as ApiError).status).toBe(409);
      expect((refusal as ApiError).code).toBe("model_credential_changed");
    }
  });

  it("keeps the pins of two concurrent turns of one user apart, each keyed by its turn id", async () => {
    initSystemModelProviderKeys([
      {
        id: "sys-key-openai",
        providerId: "openai",
        apiKey: "sk-system-openai",
        models: [{ id: OPENAI_PRESET, modelId: "gpt-5.5" }],
      },
    ]);
    const orgKey = await seedOrgModelProviderKey({
      orgId: ORG_ID,
      label: "Org shared key",
      providerId: "openai",
      apiKey: "sk-org-shared",
    });
    const personal = await seedOrgModelProviderKey({
      orgId: ORG_ID,
      createdBy: USER_ID,
      ownerUserId: USER_ID,
      label: "Mine, later",
      providerId: "openai",
      apiKey: "sk-mine-later",
    });
    const turnA = { orgId: ORG_ID, userId: USER_ID, turnId: "turn_A" };
    const turnB = { orgId: ORG_ID, userId: USER_ID, turnId: "turn_B" };

    // Turn A is admitted on the org key; turn B, same user, session and preset,
    // is admitted afterwards on the member's personal key.
    recordChatTurnAdmission(turnA, OPENAI_PRESET, { credentialId: orgKey.id, source: "org" });
    recordChatTurnAdmission(turnB, OPENAI_PRESET, {
      credentialId: personal.id,
      source: "org",
    });

    // Each turn still spends the credential it was admitted on.
    expect(admittedChatTurnPin(turnA, OPENAI_PRESET)).toEqual({
      credentialId: orgKey.id,
      source: "org",
    });
    expect(admittedChatTurnPin(turnB, OPENAI_PRESET)).toEqual({
      credentialId: personal.id,
      source: "org",
    });
  });
});
