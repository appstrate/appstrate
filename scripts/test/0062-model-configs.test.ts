// SPDX-License-Identifier: Apache-2.0

/**
 * Script `0062` against the test database: every connection and organization model joins a
 * model configuration — family connections fold into one, gateway connections split by
 * endpoint, duplicate models merge with the pointers repointed, and the retired
 * `personal_model_credentials` setting becomes the configuration's switch.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  modelConfigs,
  modelProviderCredentials,
  orgModels,
  organizations,
  schedules as packageSchedules,
  spacePackages,
} from "@appstrate/db/schema";
import { runModelConfigs } from "../migration/0062-model-configs.ts";
import {
  assertNoPendingDataScripts,
  PENDING_DATA_SCRIPTS,
} from "../../apps/api/src/lib/boot-guards/pending-data-scripts.ts";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  getModelProvider,
  registerModelProvider,
  resetModelProviders,
} from "../../apps/api/src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../apps/api/test/helpers/model-providers.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedAgent, seedSchedule, seedSpacePackage } from "../../apps/api/test/helpers/seed.ts";

const ENTRY = PENDING_DATA_SCRIPTS.find((e) => e.after === "0119")!;
const lines: string[] = [];
const run = (apply: boolean) => runModelConfigs({ apply, out: (line) => lines.push(line) });
const pending = async () => {
  const err = await assertNoPendingDataScripts(null, [ENTRY]).then(
    () => null,
    (e: Error) => e,
  );
  return err === null ? 0 : Number(/: (\d+) pending/.exec(err.message)![1]);
};

const GW_A = "https://gw-a.example.test/v1";
const GW_B = "https://gw-b.example.test/v1";
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

async function connection(
  ctx: TestContext,
  providerId: string,
  options: { baseUrlOverride?: string; ownerUserId?: string; minute: number },
): Promise<string> {
  const [row] = await db
    .insert(modelProviderCredentials)
    .values({
      orgId: ctx.orgId,
      label: providerId,
      providerId,
      credentialsEncrypted: "v1:k1:opaque",
      baseUrlOverride: options.baseUrlOverride ?? null,
      ownerUserId: options.ownerUserId ?? null,
      createdBy: ctx.user.id,
      createdAt: at(options.minute),
    })
    .returning({ id: modelProviderCredentials.id });
  return row!.id;
}

async function model(
  ctx: TestContext,
  fields: {
    modelId: string;
    providerId: string;
    credentialId?: string;
    enabled?: boolean;
    aliased?: boolean;
    label?: string;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    minute: number;
  },
): Promise<string> {
  const [row] = await db
    .insert(orgModels)
    .values({
      orgId: ctx.orgId,
      label: fields.label ?? fields.modelId,
      modelId: fields.modelId,
      providerId: fields.providerId,
      credentialId: fields.credentialId ?? null,
      enabled: fields.enabled ?? true,
      aliased: fields.aliased ?? false,
      cost: fields.cost ?? null,
      createdAt: at(fields.minute),
    })
    .returning({ id: orgModels.id });
  return row!.id;
}

// The anthropic subscription the fold is asserted on. `claude-code` is an opt-in module the CI
// `MODULES` leaves out, so the test registers its own copy; the script skips a provider already
// registered, whatever `MODULES` holds.
const claudeCodeSubscription: ModelProviderDefinition = {
  providerId: "claude-code",
  displayName: "Claude Code",
  iconUrl: "anthropic",
  description: "Anthropic subscription for the 0062 fold.",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.example.test",
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "test-client-id",
    authorizationUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    refreshUrl: "https://auth.example.test/token",
    scopes: ["openid"],
    pkce: "S256",
  },
  catalogProviderId: "anthropic",
  featuredModels: [],
  modelDiscovery: { mode: "static" },
};

const configsOf = (orgId: string) =>
  db.select().from(modelConfigs).where(eq(modelConfigs.orgId, orgId));
const connectionConfig = async (id: string) =>
  (
    await db
      .select({ configId: modelProviderCredentials.configId })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id))
  )[0]!.configId;
const modelRow = async (id: string) =>
  (await db.select().from(orgModels).where(eq(orgModels.id, id)))[0];
const orgRow = async (orgId: string) =>
  (await db.select().from(organizations).where(eq(organizations.id, orgId)))[0]!;

describe("0062 — model configurations", () => {
  let a: TestContext;
  let b: TestContext;
  const ids = {} as Record<
    | "orgKey"
    | "anthropicKey"
    | "personalSub"
    | "gwA"
    | "gwDefault"
    | "gwB"
    | "kept"
    | "dup"
    | "alphaA"
    | "alphaB",
    string
  > & { agent: string; schedule: string; claudeKey: string; claude: string };

  // The script registers the providers the platform ships, as production does; the test
  // harness's registrations (gateway flips, test providers) would change what it computes.
  afterAll(() => {
    resetModelProviders();
    seedTestModelProviders();
  });

  beforeEach(async () => {
    await truncateAll();
    resetModelProviders();
    registerModelProvider(claudeCodeSubscription);
    lines.length = 0;
    a = await createTestContext({ orgSlug: "mig0062-a" });
    b = await createTestContext({ orgSlug: "mig0062-b" });
    await db
      .update(organizations)
      .set({ orgSettings: { personal_model_credentials: false, dashboard_sso_enabled: true } })
      .where(eq(organizations.id, a.orgId));

    // Org A: an anthropic key and a personal claude-code subscription fold into one family
    // configuration; three gateway connections split by endpoint.
    ids.orgKey = await connection(a, "openai", { minute: 1 });
    ids.anthropicKey = await connection(a, "anthropic", { minute: 1 });
    ids.personalSub = await connection(a, "claude-code", { ownerUserId: a.user.id, minute: 2 });
    ids.gwA = await connection(a, "openai-compatible", { baseUrlOverride: GW_A, minute: 3 });
    ids.gwDefault = await connection(a, "openai-compatible", { minute: 4 });
    ids.gwB = await connection(a, "openai-compatible", { baseUrlOverride: GW_B, minute: 5 });

    // Two gpt-5.5 rows land on the openai configuration: the enabled one is kept, though the
    // disabled one is older.
    ids.dup = await model(a, {
      modelId: "gpt-5.5",
      providerId: "openai",
      enabled: false,
      minute: 1,
    });
    ids.kept = await model(a, {
      modelId: "gpt-5.5",
      providerId: "openai",
      credentialId: ids.orgKey,
      minute: 2,
    });
    ids.alphaA = await model(a, {
      modelId: "alpha",
      providerId: "openai-compatible",
      credentialId: ids.gwA,
      minute: 3,
    });
    ids.alphaB = await model(a, {
      modelId: "alpha",
      providerId: "openai-compatible",
      credentialId: ids.gwB,
      minute: 4,
    });

    // Every pointer at the duplicate.
    await db
      .update(organizations)
      .set({ defaultModelId: ids.dup })
      .where(eq(organizations.id, a.orgId));
    ids.agent = `@${a.org.slug}/mig-agent`;
    await seedAgent({ id: ids.agent, orgId: a.orgId, createdBy: a.user.id });
    await seedSpacePackage(a.defaultSpaceId, ids.agent, { modelId: ids.dup });
    ids.schedule = (
      await seedSchedule({
        packageId: ids.agent,
        orgId: a.orgId,
        spaceId: a.defaultSpaceId,
        userId: a.user.id,
        modelIdOverride: ids.dup,
      })
    ).id;

    // Org B never set the policy: its configuration allows personal connections.
    ids.claudeKey = await connection(b, "anthropic", { minute: 1 });
    ids.claude = await model(b, {
      modelId: "claude-sonnet-4-5",
      providerId: "anthropic",
      minute: 1,
    });
  });

  it("a dry run writes nothing", async () => {
    expect(await pending()).toBe(12);
    await run(false);
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(lines.some((l) => l.includes(`duplicate model ${ids.dup}`))).toBe(true);

    expect(await configsOf(a.orgId)).toEqual([]);
    expect(await configsOf(b.orgId)).toEqual([]);
    expect(await connectionConfig(ids.orgKey)).toBeNull();
    expect(await modelRow(ids.dup)).toBeDefined();
    expect((await orgRow(a.orgId)).defaultModelId).toBe(ids.dup);
    expect((await orgRow(a.orgId)).orgSettings).toHaveProperty("personal_model_credentials", false);
    expect(await pending()).toBe(12);
  });

  it("--apply folds the family, splits the gateways by endpoint and carries the personal setting", async () => {
    await run(true);
    expect(lines.at(-1)).toBe("0062: APPLIED — committed.");
    expect(await pending()).toBe(0);

    const configs = await configsOf(a.orgId);
    const find = (providerId: string, baseUrl: string | null) =>
      configs.find((c) => c.providerId === providerId && c.baseUrl === baseUrl);
    const defaultEndpoint = getModelProvider("openai-compatible")!.defaultBaseUrl;
    const openai = find("openai", null)!;
    expect(openai).toMatchObject({ personalConnectionsAllowed: false });
    expect(configs).toHaveLength(5);
    const anthropic = find("anthropic", null)!;
    expect(anthropic).toMatchObject({ personalConnectionsAllowed: false });
    expect(find("openai-compatible", GW_A)).toBeDefined();
    expect(find("openai-compatible", GW_B)).toBeDefined();
    expect(find("openai-compatible", defaultEndpoint)).toBeDefined();

    // The wrapper's personal subscription joins its family's configuration.
    expect(await connectionConfig(ids.orgKey)).toBe(openai.id);
    expect(await connectionConfig(ids.anthropicKey)).toBe(anthropic.id);
    expect(await connectionConfig(ids.personalSub)).toBe(anthropic.id);
    expect(await connectionConfig(ids.gwA)).toBe(find("openai-compatible", GW_A)!.id);
    expect(await connectionConfig(ids.gwB)).toBe(find("openai-compatible", GW_B)!.id);
    // A gateway connection without an override used the provider's default endpoint.
    expect(await connectionConfig(ids.gwDefault)).toBe(
      find("openai-compatible", defaultEndpoint)!.id,
    );

    // Bound models follow their connection: one `alpha` per endpoint, no merge.
    expect((await modelRow(ids.alphaA))!.configId).toBe(find("openai-compatible", GW_A)!.id);
    expect((await modelRow(ids.alphaB))!.configId).toBe(find("openai-compatible", GW_B)!.id);

    // Labels: the provider's display name, `host · name` for a gateway endpoint.
    const gwName = getModelProvider("openai-compatible")!.displayName;
    expect(openai.label).toBe(getModelProvider("openai")!.displayName);
    expect(find("openai-compatible", GW_A)!.label).toBe(`gw-a.example.test · ${gwName}`);
    expect(find("openai-compatible", GW_B)!.label).toBe(`gw-b.example.test · ${gwName}`);

    // The report: org B's `claude` model was unbound and is now served by its org key; nothing
    // else changes, nothing was created that nobody chose, no merge lost a field.
    expect(lines).toContain(
      `  [${b.orgId}] serving changes: model ${ids.claude} (claude-sonnet-4-5) unbound -> ${ids.claudeKey}`,
    );
    expect(lines.filter((l) => l.includes("serving changes:"))).toHaveLength(1);
    expect(lines).toContain("models whose serving organization connection changes: 1");
    expect(lines).toContain("rows of a provider no loaded module registers (own configuration): 0");
    expect(lines).toContain("configurations created for a provider no loaded module registers: 0");
    expect(lines).toContain(
      "configurations created on a gateway default endpoint for an unbound model: 0",
    );
    expect(lines).toContain("merges that drop differing fields: 0");

    // Org B: its own configuration, personal connections allowed (setting absent).
    const [claudeConfig] = await configsOf(b.orgId);
    expect(claudeConfig).toMatchObject({
      providerId: "anthropic",
      personalConnectionsAllowed: true,
    });
    expect(await connectionConfig(ids.claudeKey)).toBe(claudeConfig!.id);
    expect((await modelRow(ids.claude))!.configId).toBe(claudeConfig!.id);
  });

  it("--apply merges the duplicates and repoints the default, the space package and the schedule", async () => {
    await run(true);

    expect(await modelRow(ids.dup)).toBeUndefined();
    const kept = (await modelRow(ids.kept))!;
    expect(kept.configId).not.toBeNull();
    expect((await orgRow(a.orgId)).defaultModelId).toBe(ids.kept);
    const [placement] = await db
      .select({ modelId: spacePackages.modelId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, ids.agent));
    expect(placement!.modelId).toBe(ids.kept);
    const [schedule] = await db
      .select({ modelIdOverride: packageSchedules.modelIdOverride })
      .from(packageSchedules)
      .where(eq(packageSchedules.id, ids.schedule));
    expect(schedule!.modelIdOverride).toBe(ids.kept);
  });

  it("--apply removes the retired setting and keeps the other keys", async () => {
    await run(true);
    expect((await orgRow(a.orgId)).orgSettings).toEqual({ dashboard_sso_enabled: true });
  });

  it("a second --apply writes nothing", async () => {
    await run(true);
    const before = await db.select().from(modelConfigs);
    lines.length = 0;
    await run(true);
    expect(lines).toContain("organizations to migrate: 0");
    expect(await db.select().from(modelConfigs)).toEqual(before);
    expect(await pending()).toBe(0);
  });

  it("an unbound gateway model creates, and flags, a configuration on the provider's default endpoint", async () => {
    const orphan = await model(b, {
      modelId: "anything",
      providerId: "openai-compatible",
      minute: 9,
    });

    await run(true);
    const [cfg] = await db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.id, (await modelRow(orphan))!.configId!));
    expect(cfg!.providerId).toBe("openai-compatible");
    expect(cfg!.baseUrl).toBe(getModelProvider("openai-compatible")!.defaultBaseUrl);
    expect(lines.some((l) => l.includes(`[${b.orgId}] UNCHOSEN ENDPOINT`))).toBe(true);
    expect(lines).toContain(
      "configurations created on a gateway default endpoint for an unbound model: 1",
    );
    expect(await pending()).toBe(0);
  });

  it("an unbound gateway model reuses an existing default-endpoint configuration without flagging it", async () => {
    const orphan = await model(a, {
      modelId: "anything",
      providerId: "openai-compatible",
      minute: 9,
    });

    await run(true);
    expect((await modelRow(orphan))!.configId).toBe(await connectionConfig(ids.gwDefault));
    expect(await configsOf(a.orgId)).toHaveLength(5);
    expect(lines.some((l) => l.includes("UNCHOSEN ENDPOINT"))).toBe(false);
    expect(lines).toContain(
      "configurations created on a gateway default endpoint for an unbound model: 0",
    );
  });

  it("reports a model bound to a personal connection as served by none when no organization connection serves it", async () => {
    const personal = await connection(b, "openai", { ownerUserId: b.user.id, minute: 8 });
    const bound = await model(b, {
      modelId: "gpt-x",
      providerId: "openai",
      credentialId: personal,
      minute: 8,
    });

    await run(true);
    expect(lines).toContain(
      `  [${b.orgId}] serving changes: model ${bound} (gpt-x) personal connection ${personal} -> none`,
    );
    expect(lines).toContain("models whose serving organization connection changes: 2");
  });

  it("keeps an alias beside its backing row: same connection and model id, nothing merged, pointers untouched", async () => {
    const alias = await model(a, {
      modelId: "gpt-5.5",
      providerId: "openai",
      credentialId: ids.orgKey,
      aliased: true,
      label: "public alias",
      minute: 6,
    });
    const aliasAgent = `@${a.org.slug}/alias-agent`;
    await seedAgent({ id: aliasAgent, orgId: a.orgId, createdBy: a.user.id });
    await seedSpacePackage(a.defaultSpaceId, aliasAgent, { modelId: alias });

    await run(true);
    const openai = (await configsOf(a.orgId)).find((c) => c.providerId === "openai")!;
    expect(await modelRow(alias)).toMatchObject({ aliased: true, configId: openai.id });
    expect((await modelRow(ids.kept))!.configId).toBe(openai.id);
    const [placement] = await db
      .select({ modelId: spacePackages.modelId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, aliasAgent));
    expect(placement!.modelId).toBe(alias);
    // The one merge is still the disabled plain duplicate.
    expect(lines.filter((l) => l.includes("merged into"))).toHaveLength(1);
  });

  it("among duplicates that are all enabled, the oldest is kept", async () => {
    // The newer row is inserted first, so row order cannot decide it.
    const newer = await model(b, { modelId: "claude-x", providerId: "anthropic", minute: 20 });
    const older = await model(b, { modelId: "claude-x", providerId: "anthropic", minute: 10 });

    await run(true);
    expect(await modelRow(newer)).toBeUndefined();
    expect((await modelRow(older))!.configId).not.toBeNull();
  });

  it("reports the fields a merge drops", async () => {
    const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    const kept = await model(b, { modelId: "claude-x", providerId: "anthropic", minute: 10 });
    const dropped = await model(b, {
      modelId: "claude-x",
      providerId: "anthropic",
      label: "Claude X (old label)",
      cost,
      enabled: false,
      minute: 11,
    });

    await run(true);
    expect(await modelRow(dropped)).toBeUndefined();
    const line = lines.find((l) => l.includes(`merge drops from ${dropped}`))!;
    expect(line).toContain('label "Claude X (old label)" (kept "claude-x")');
    expect(line).toContain("cost");
    expect(lines).toContain("merges that drop differing fields: 1");
    expect((await modelRow(kept))!.configId).not.toBeNull();
  });

  it("a partial resume: a connection and model added after a first --apply join the existing configuration", async () => {
    await run(true);
    const before = await configsOf(a.orgId);
    const anthropic = before.find((c) => c.providerId === "anthropic")!;
    const lateConnection = await connection(a, "anthropic", { minute: 30 });
    const lateModel = await model(a, {
      modelId: "claude-late",
      providerId: "anthropic",
      minute: 30,
    });
    expect(await pending()).toBe(2);

    lines.length = 0;
    await run(true);
    expect(await connectionConfig(lateConnection)).toBe(anthropic.id);
    expect((await modelRow(lateModel))!.configId).toBe(anthropic.id);
    expect(await configsOf(a.orgId)).toEqual(before);
    expect(await pending()).toBe(0);
  });

  it("gives a provider no loaded module registers a configuration of its own id, endpoint override included", async () => {
    const OLD = "https://old.example.test/v1";
    const stray = await connection(b, "retired-provider", { minute: 9 });
    const strayModel = await model(b, { modelId: "m", providerId: "retired-provider", minute: 9 });
    const strayEndpoint = await connection(b, "retired-provider", {
      baseUrlOverride: OLD,
      minute: 10,
    });

    await run(true);
    const configOf = async (id: string) =>
      (
        await db
          .select()
          .from(modelConfigs)
          .where(eq(modelConfigs.id, (await connectionConfig(id))!))
      )[0]!;
    const family = await configOf(stray);
    const endpoint = await configOf(strayEndpoint);
    expect(family).toMatchObject({ providerId: "retired-provider", baseUrl: null });
    expect(endpoint).toMatchObject({ providerId: "retired-provider", baseUrl: OLD });
    expect(endpoint.id).not.toBe(family.id);
    expect((await modelRow(strayModel))!.configId).toBe(family.id);
    expect(lines.some((l) => l.includes("UNREGISTERED PROVIDER"))).toBe(true);
    expect(lines).toContain("rows of a provider no loaded module registers (own configuration): 3");
    expect(lines).toContain("configurations created for a provider no loaded module registers: 2");
    expect(await pending()).toBe(0);
  });

  it("a row cannot point at another organization's configuration", async () => {
    await run(true);
    const [foreign] = await configsOf(b.orgId);
    await expect(
      (async () => {
        await db
          .update(modelProviderCredentials)
          .set({ configId: foreign!.id })
          .where(eq(modelProviderCredentials.id, ids.orgKey));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await db.update(orgModels).set({ configId: foreign!.id }).where(eq(orgModels.id, ids.kept));
      })(),
    ).rejects.toThrow();
  });
});
