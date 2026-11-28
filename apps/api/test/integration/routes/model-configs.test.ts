// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/model-configs` (#2451): a model configuration names a provider family (or a
 * gateway's endpoint) and holds its connections and its models. One per family and one
 * per gateway endpoint (409 `model_config_exists`, naming the existing one); `models:read`
 * lists, `models:write` creates and edits, `models:delete` deletes it with its connections
 * and models, clearing the default that named one.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, orgModels, organizations } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedOrgModelProviderKey } from "../../helpers/seed.ts";
import { expectRejectedField } from "../../helpers/body-validation.ts";

const app = getTestApp();
const CONFIGS = "/api/model-configs";

interface ConfigInfo {
  id: string;
  provider_id: string;
  label: string;
  base_url: string | null;
  personal_connections_allowed: boolean;
  accepts: { provider_id: string; auth_mode: string }[];
  org_connection: "active" | "needs_reconnection" | "none";
  personal_connection_count: number | null;
  model_count: number;
}

/** A refusal the service words on one parameter (`invalid_request` + `param`). */
async function expectInvalidParam(res: Response, param: string): Promise<void> {
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "invalid_request", param });
}

let owner: TestContext;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext({ orgSlug: "configs" });
});

function send(method: string, path: string, body?: unknown, as: TestContext = owner) {
  return app.request(path, {
    method,
    headers: authHeaders(as, body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(body: Record<string, unknown>, as: TestContext = owner): Promise<ConfigInfo> {
  const res = await send("POST", CONFIGS, body, as);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as ConfigInfo;
}

async function list(as: TestContext = owner): Promise<ConfigInfo[]> {
  const res = await send("GET", CONFIGS, undefined, as);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ConfigInfo[] }).data;
}

describe("POST /api/model-configs", () => {
  it("creates a family configuration, filed under the family's provider", async () => {
    const config = await create({ provider_id: "openai" });
    expect(config).toMatchObject({
      provider_id: "openai",
      base_url: null,
      personal_connections_allowed: true,
      org_connection: "none",
      personal_connection_count: 0,
      model_count: 0,
    });
    // Its accepted connection providers include the family's subscription wrapper.
    expect(config.accepts.map((a) => a.provider_id)).toEqual(
      expect.arrayContaining(["openai", "test-oauth"]),
    );
  });

  it("creates a gateway configuration with its endpoint and a personal switch", async () => {
    const config = await create({
      provider_id: "openai-compatible",
      base_url: "https://gateway.example.test/v1",
      label: "Our gateway",
      personal_connections_allowed: false,
    });
    expect(config).toMatchObject({
      provider_id: "openai-compatible",
      base_url: "https://gateway.example.test/v1",
      label: "Our gateway",
      personal_connections_allowed: false,
    });
  });

  it("refuses a second configuration of a family with 409 model_config_exists, naming it", async () => {
    const first = await create({ provider_id: "anthropic" });

    const res = await send("POST", CONFIGS, { provider_id: "anthropic" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "model_config_exists",
      existing_config_id: first.id,
    });
    expect(await list()).toHaveLength(1);
  });

  it("refuses a second gateway configuration on the same endpoint, not on another", async () => {
    const first = await create({
      provider_id: "openai-compatible",
      base_url: "https://a.example.test/v1",
    });

    const dup = await send("POST", CONFIGS, {
      provider_id: "openai-compatible",
      base_url: "https://a.example.test/v1",
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({
      code: "model_config_exists",
      existing_config_id: first.id,
    });

    await create({ provider_id: "openai-compatible", base_url: "https://b.example.test/v1" });
  });

  it("refuses a gateway without base_url, a family with one, an unknown provider and a non-http endpoint", async () => {
    await expectInvalidParam(
      await send("POST", CONFIGS, { provider_id: "openai-compatible" }),
      "base_url",
    );
    await expectInvalidParam(
      await send("POST", CONFIGS, {
        provider_id: "openai",
        base_url: "https://elsewhere.example.test/v1",
      }),
      "base_url",
    );
    await expectInvalidParam(
      await send("POST", CONFIGS, { provider_id: "@nope/provider" }),
      "provider_id",
    );
    await expectRejectedField(
      await send("POST", CONFIGS, {
        provider_id: "openai-compatible",
        base_url: "ftp://gateway.example.test",
      }),
      "base_url",
    );
    expect(await list()).toEqual([]);
  });

  it("refuses an unknown field", async () => {
    await expectRejectedField(
      await send("POST", CONFIGS, { provider_id: "openai", providerId: "openai" }),
      "providerId",
    );
  });
});

describe("GET /api/model-configs", () => {
  it("states the organization connection, the personal count and the model count", async () => {
    const config = await create({ provider_id: "openai" });
    await seedOrgModelProviderKey({
      orgId: owner.orgId,
      providerId: "openai",
      apiKey: "sk-org",
      configId: config.id,
    });
    const member = await memberContext(owner, "member");
    await seedOrgModelProviderKey({
      orgId: owner.orgId,
      providerId: "openai",
      apiKey: "sk-member",
      ownerUserId: member.user.id,
      createdBy: member.user.id,
      configId: config.id,
    });
    await db.insert(orgModels).values({
      orgId: owner.orgId,
      configId: config.id,
      label: "GPT",
      modelId: "gpt-5.5",
    });

    const [listed] = await list();
    expect(listed).toMatchObject({
      id: config.id,
      org_connection: "active",
      personal_connection_count: 1,
      model_count: 1,
    });

    // A reader of models who reads no organization connections is told no count.
    const [forMember] = await list(member);
    expect(forMember).toMatchObject({ id: config.id, personal_connection_count: null });
  });

  it("lists only the caller's organization", async () => {
    await create({ provider_id: "openai" });
    const other = await createTestContext({ orgSlug: "configs-other" });
    expect(await list(other)).toEqual([]);
  });
});

describe("PATCH /api/model-configs/:id", () => {
  it("renames, moves a gateway's endpoint and switches personal connections", async () => {
    const config = await create({
      provider_id: "openai-compatible",
      base_url: "https://a.example.test/v1",
    });

    const res = await send("PATCH", `${CONFIGS}/${config.id}`, {
      label: "Renamed",
      base_url: "https://moved.example.test/v1",
      personal_connections_allowed: false,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      label: "Renamed",
      base_url: "https://moved.example.test/v1",
      personal_connections_allowed: false,
    });
  });

  it("refuses moving a gateway onto another configuration's endpoint with 409", async () => {
    const a = await create({
      provider_id: "openai-compatible",
      base_url: "https://a.example.test",
    });
    const b = await create({
      provider_id: "openai-compatible",
      base_url: "https://b.example.test",
    });

    const res = await send("PATCH", `${CONFIGS}/${b.id}`, { base_url: "https://a.example.test" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "model_config_exists",
      existing_config_id: a.id,
    });
  });

  it("refuses an endpoint on a family configuration, and an unknown configuration as absent", async () => {
    const config = await create({ provider_id: "openai" });
    await expectInvalidParam(
      await send("PATCH", `${CONFIGS}/${config.id}`, { base_url: "https://x.example.test" }),
      "base_url",
    );

    const foreign = await createTestContext({ orgSlug: "configs-foreign" });
    const theirs = await create({ provider_id: "openai" }, foreign);
    expect((await send("PATCH", `${CONFIGS}/${theirs.id}`, { label: "Mine" })).status).toBe(404);
    expect((await send("PATCH", `${CONFIGS}/not-a-uuid`, { label: "Mine" })).status).toBe(404);
  });
});

describe("DELETE /api/model-configs/:id", () => {
  it("deletes the configuration with its connections and models, and clears the default", async () => {
    const config = await create({ provider_id: "openai" });
    const key = await seedOrgModelProviderKey({
      orgId: owner.orgId,
      providerId: "openai",
      apiKey: "sk-org",
      configId: config.id,
    });
    const [model] = await db
      .insert(orgModels)
      .values({ orgId: owner.orgId, configId: config.id, label: "GPT", modelId: "gpt-5.5" })
      .returning({ id: orgModels.id });
    const setDefault = await send("PUT", "/api/models/default", { modelId: model!.id });
    expect(setDefault.status, await setDefault.clone().text()).toBe(200);

    const res = await send("DELETE", `${CONFIGS}/${config.id}`);
    expect(res.status).toBe(204);

    expect(await db.select().from(orgModels).where(eq(orgModels.id, model!.id))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, key.id)),
    ).toHaveLength(0);
    const [org] = await db
      .select({ defaultModelId: organizations.defaultModelId })
      .from(organizations)
      .where(eq(organizations.id, owner.orgId));
    expect(org!.defaultModelId).toBeNull();
    expect((await send("DELETE", `${CONFIGS}/${config.id}`)).status).toBe(404);
  });
});

describe("permissions", () => {
  it("lets a member read, and refuses them create, edit and delete", async () => {
    const config = await create({ provider_id: "openai" });
    const member = await memberContext(owner, "member");

    expect((await send("GET", CONFIGS, undefined, member)).status).toBe(200);
    expect((await send("POST", CONFIGS, { provider_id: "anthropic" }, member)).status).toBe(403);
    expect((await send("PATCH", `${CONFIGS}/${config.id}`, { label: "x" }, member)).status).toBe(
      403,
    );
    expect((await send("DELETE", `${CONFIGS}/${config.id}`, undefined, member)).status).toBe(403);
    expect(await list()).toHaveLength(1);
  });

  it("lets an admin create, edit and delete", async () => {
    const admin = await memberContext(owner, "admin");
    const config = await create({ provider_id: "anthropic" }, admin);
    expect(
      (await send("PATCH", `${CONFIGS}/${config.id}`, { label: "Claude" }, admin)).status,
    ).toBe(200);
    expect((await send("DELETE", `${CONFIGS}/${config.id}`, undefined, admin)).status).toBe(204);
  });
});
