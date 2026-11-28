// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/models/apply` (#1993, #2451): a configuration's model choice in ONE transaction —
 * the models, the switches and the default, all written or none. Connections are added on
 * their own route. Every refusal case is paired with the control that differs only by the
 * refused entry, and checks that nothing was written.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels, organizations } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";

const app = getTestApp();

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "choice" });
});

function post(path: string, body: unknown, as: TestContext = ctx) {
  return app.request(path, {
    method: "POST",
    headers: authHeaders(as, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const apply = (body: unknown, as: TestContext = ctx) => post("/api/models/apply", body, as);

/** A user-described gateway configuration (it takes any model id), optionally with an org key. */
async function gatewayConfig(options: { label?: string; orgKey?: boolean } = {}): Promise<string> {
  const res = await post("/api/model-configs", {
    provider_id: "openai-compatible",
    base_url: `https://${options.label ?? "gateway"}.example.test/v1`,
    ...(options.label ? { label: options.label } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const configId = ((await res.json()) as { id: string }).id;
  if (options.orgKey !== false) {
    const key = await post("/api/model-provider-credentials", {
      providerId: "openai-compatible",
      api_key: "sk-gateway",
      config_id: configId,
    });
    expect(key.status, await key.clone().text()).toBe(201);
  }
  return configId;
}

const modelsOf = () =>
  db
    .select({ id: orgModels.id, modelId: orgModels.modelId, enabled: orgModels.enabled })
    .from(orgModels)
    .where(eq(orgModels.orgId, ctx.orgId));
const defaultOf = async () =>
  (
    await db
      .select({ id: organizations.defaultModelId })
      .from(organizations)
      .where(eq(organizations.id, ctx.orgId))
  )[0]?.id ?? null;

interface ChoiceBody {
  config_id: string;
  models: { id: string; modelId: string; enabled: boolean }[];
  default_model_id: string | null;
}

describe("POST /api/models/apply", () => {
  it("adds the models and sets the default in one write", async () => {
    const configId = await gatewayConfig();
    const res = await apply({
      config_id: configId,
      add: [{ modelId: "alpha" }, { modelId: "beta", label: "Beta" }],
      default_model_id: "beta",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as ChoiceBody;
    expect(body.config_id).toBe(configId);
    expect(body.models.map((m) => m.modelId).sort()).toEqual(["alpha", "beta"]);

    const stored = await modelsOf();
    expect(stored.map((m) => m.modelId).sort()).toEqual(["alpha", "beta"]);
    expect(await defaultOf()).toBe(stored.find((m) => m.modelId === "beta")!.id);
    expect(body.default_model_id).toBe(await defaultOf());
  });

  it("refuses a default no organization connection serves, writing nothing", async () => {
    const configId = await gatewayConfig({ orgKey: false });
    const res = await apply({
      config_id: configId,
      add: [{ modelId: "alpha" }],
      default_model_id: "alpha",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string; code: string }[] };
    expect(body.errors).toEqual([
      expect.objectContaining({
        field: "default_model_id",
        code: "model_org_connection_required",
      }),
    ]);
    expect(await modelsOf()).toEqual([]);
    expect(await defaultOf()).toBeNull();

    // CONTROL: the same choice without the default goes through.
    const ok = await apply({ config_id: configId, add: [{ modelId: "alpha" }] });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it("writes nothing when one model is refused before the write", async () => {
    // A named provider takes only the ids of its catalog offer (`POST /api/models`'s own check).
    const config = await post("/api/model-configs", { provider_id: "openai" });
    expect(config.status).toBe(201);
    const configId = ((await config.json()) as { id: string }).id;
    const res = await apply({
      config_id: configId,
      add: [{ modelId: "gpt-4o" }, { modelId: "no-such-model" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string; code: string }[] };
    expect(body.errors).toEqual([
      expect.objectContaining({ field: "add.1", code: "model_not_offered" }),
    ]);
    expect(await modelsOf()).toEqual([]);

    // CONTROL: the offered model alone goes through.
    const ok = await apply({ config_id: configId, add: [{ modelId: "gpt-4o" }] });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await modelsOf()).toHaveLength(1);
  });

  it("refuses a duplicate in the same choice, naming the entry, and rolls the batch back", async () => {
    const configId = await gatewayConfig();
    const res = await apply({
      config_id: configId,
      add: [{ modelId: "alpha" }, { modelId: "alpha", label: "Alpha again" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toEqual([
      expect.objectContaining({ field: "add.1", code: "model_already_added" }),
    ]);
    expect(await modelsOf()).toEqual([]);

    // CONTROL: the same choice without the duplicate goes through.
    expect((await apply({ config_id: configId, add: [{ modelId: "alpha" }] })).status).toBe(200);
  });

  it("switches models of the chosen configuration on and off, and refuses one of another", async () => {
    const firstConfig = await gatewayConfig();
    const otherConfig = await gatewayConfig({ label: "other" });
    const first = (await (
      await apply({
        config_id: firstConfig,
        add: [{ modelId: "alpha" }, { modelId: "beta" }],
        default_model_id: "alpha",
      })
    ).json()) as ChoiceBody;
    const other = (await (
      await apply({ config_id: otherConfig, add: [{ modelId: "gamma" }] })
    ).json()) as ChoiceBody;
    const id = (body: ChoiceBody, modelId: string) =>
      body.models.find((m) => m.modelId === modelId)!.id;

    // `gamma` belongs to the other configuration: refused, and `beta` stays on.
    const refused = await apply({
      config_id: firstConfig,
      disable: [id(first, "beta"), id(other, "gamma")],
    });
    expect(refused.status).toBe(400);
    const errors = ((await refused.json()) as { errors: { field: string; code: string }[] }).errors;
    expect(errors).toEqual([
      expect.objectContaining({ field: "disable.1", code: "model_not_in_choice" }),
    ]);
    const beta = await db
      .select({ enabled: orgModels.enabled })
      .from(orgModels)
      .where(and(eq(orgModels.orgId, ctx.orgId), eq(orgModels.id, id(first, "beta"))));
    expect(beta[0]?.enabled).toBe(true);

    // CONTROL: the switch alone goes through.
    const ok = await apply({ config_id: firstConfig, disable: [id(first, "beta")] });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as ChoiceBody).models).toEqual([
      expect.objectContaining({ modelId: "beta", enabled: false }),
    ]);
  });

  it("refuses switching off the default, and moves the default first when asked", async () => {
    const configId = await gatewayConfig();
    const first = (await (
      await apply({
        config_id: configId,
        add: [{ modelId: "alpha" }, { modelId: "beta" }],
        default_model_id: "alpha",
      })
    ).json()) as ChoiceBody;
    const alpha = first.models.find((m) => m.modelId === "alpha")!.id;

    const refused = await apply({ config_id: configId, disable: [alpha] });
    expect(refused.status).toBe(400);
    expect(await defaultOf()).toBe(alpha);

    // CONTROL: the default moves before the switch off, in the same write.
    const moved = await apply({ config_id: configId, disable: [alpha], default_model_id: "beta" });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await defaultOf()).toBe(first.models.find((m) => m.modelId === "beta")!.id);
  });

  it("requires models:write", async () => {
    const configId = await gatewayConfig();
    // A member holds no `models:write`.
    const member = await memberContext(ctx, "member");
    expect((await apply({ config_id: configId, add: [{ modelId: "alpha" }] }, member)).status).toBe(
      403,
    );
    expect(await modelsOf()).toEqual([]);
  });

  it("refuses a configuration of another organization as absent", async () => {
    const other = await createTestContext({ orgSlug: "choice-other" });
    const res = await post("/api/model-configs", { provider_id: "openai" }, other);
    const foreign = ((await res.json()) as { id: string }).id;

    expect((await apply({ config_id: foreign, add: [{ modelId: "gpt-4o" }] })).status).toBe(404);
    expect(await modelsOf()).toEqual([]);
  });

  it("replays the first response on a retry with the same Idempotency-Key", async () => {
    const configId = await gatewayConfig();
    const body = { config_id: configId, add: [{ modelId: "alpha" }, { modelId: "beta" }] };
    const headers = authHeaders(ctx, {
      "Content-Type": "application/json",
      "Idempotency-Key": "choice-retry-1",
    });
    const send = () =>
      app.request("/api/models/apply", { method: "POST", headers, body: JSON.stringify(body) });

    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await retry.json()).toEqual(await first.json());
    // One set of models: the retry wrote nothing.
    expect(await modelsOf()).toHaveLength(2);

    // The same key with another body is a conflict, not a second write.
    const other = await app.request("/api/models/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, add: [{ modelId: "gamma" }] }),
    });
    expect(other.status).toBe(422);
    expect(await modelsOf()).toHaveLength(2);
  });

  it("applies through an API key holding models:write", async () => {
    const configId = await gatewayConfig();
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["models:write"],
    });
    const res = await app.request("/api/models/apply", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config_id: configId, add: [{ modelId: "alpha" }] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await modelsOf()).toHaveLength(1);
  });

  it("sets as default the model of the choice's own configuration when another serves the same modelId", async () => {
    const configA = await gatewayConfig({ label: "a" });
    const configB = await gatewayConfig({ label: "b" });
    const a = (await (
      await apply({ config_id: configA, add: [{ modelId: "shared" }] })
    ).json()) as ChoiceBody;
    const b = (await (
      await apply({ config_id: configB, add: [{ modelId: "shared" }] })
    ).json()) as ChoiceBody;

    for (const choice of [b, a]) {
      const res = await apply({ config_id: choice.config_id, default_model_id: "shared" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await defaultOf()).toBe(choice.models[0]!.id);
    }

    // CONTROL: a modelId no model of the configuration carries is still refused.
    const refused = await apply({ config_id: configA, default_model_id: "absent" });
    expect(refused.status).toBe(400);
  });
});
