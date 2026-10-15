// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/models/apply` (#1993): a model-provider choice in ONE transaction — the key, the
 * models, the switches and the default, all written or none. Every refusal case is paired with
 * the control that differs only by the refused entry, and checks that nothing was written.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
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

const app = getTestApp();

/** A user-described gateway: it takes any model id. */
const GATEWAY_KEY = {
  label: "Gateway",
  providerId: "openai-compatible",
  api_key: "sk-gateway",
  base_url_override: "https://gateway.example.test/v1",
};

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "choice" });
});

function apply(body: unknown, as: TestContext = ctx) {
  return app.request("/api/models/apply", {
    method: "POST",
    headers: authHeaders(as, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

const credentialsOf = () =>
  db
    .select({ id: modelProviderCredentials.id })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.orgId, ctx.orgId));
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
  credential_id: string | null;
  models: { id: string; modelId: string; enabled: boolean }[];
  default_model_id: string | null;
}

describe("POST /api/models/apply", () => {
  it("mints the key, adds the models and sets the default in one write", async () => {
    const res = await apply({
      credential: GATEWAY_KEY,
      add: [{ modelId: "alpha" }, { modelId: "beta", label: "Beta" }],
      default_model_id: "beta",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as ChoiceBody;
    expect(body.credential_id).not.toBeNull();
    expect(body.models.map((m) => m.modelId).sort()).toEqual(["alpha", "beta"]);

    expect((await credentialsOf()).map((c) => c.id)).toEqual([body.credential_id!]);
    const stored = await modelsOf();
    expect(stored.map((m) => m.modelId).sort()).toEqual(["alpha", "beta"]);
    expect(await defaultOf()).toBe(stored.find((m) => m.modelId === "beta")!.id);
    expect(body.default_model_id).toBe(await defaultOf());
  });

  it("writes nothing — not even the key — when one model is refused before the write", async () => {
    // A named provider takes only the ids of its catalog offer (`POST /api/models`'s own check).
    const key = { label: "OpenAI", providerId: "openai", api_key: "sk-openai" };
    const res = await apply({
      credential: key,
      add: [{ modelId: "gpt-4o" }, { modelId: "no-such-model" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { field: string; code: string }[] };
    expect(body.errors).toEqual([
      expect.objectContaining({ field: "add.1", code: "model_not_offered" }),
    ]);
    expect(await credentialsOf()).toEqual([]);
    expect(await modelsOf()).toEqual([]);

    // CONTROL: the offered model alone goes through, key and all.
    const ok = await apply({ credential: key, add: [{ modelId: "gpt-4o" }] });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await credentialsOf()).toHaveLength(1);
  });

  it("refuses a duplicate in the same choice, naming the entry, and rolls the batch back", async () => {
    const res = await apply({
      credential: GATEWAY_KEY,
      add: [{ modelId: "alpha" }, { modelId: "alpha", label: "Alpha again" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toEqual([
      expect.objectContaining({ field: "add.1", code: "model_already_added" }),
    ]);
    expect(await credentialsOf()).toEqual([]);
    expect(await modelsOf()).toEqual([]);

    // CONTROL: the same choice without the duplicate goes through.
    expect((await apply({ credential: GATEWAY_KEY, add: [{ modelId: "alpha" }] })).status).toBe(
      200,
    );
  });

  it("switches models of the chosen key on and off, and refuses one of another key", async () => {
    const first = (await (
      await apply({
        credential: GATEWAY_KEY,
        add: [{ modelId: "alpha" }, { modelId: "beta" }],
        default_model_id: "alpha",
      })
    ).json()) as ChoiceBody;
    const other = (await (
      await apply({ credential: { ...GATEWAY_KEY, label: "Other" }, add: [{ modelId: "gamma" }] })
    ).json()) as ChoiceBody;
    const id = (body: ChoiceBody, modelId: string) =>
      body.models.find((m) => m.modelId === modelId)!.id;

    // `gamma` runs on the other key: refused, and `beta` stays on.
    const refused = await apply({
      credential: { id: first.credential_id },
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
    const ok = await apply({
      credential: { id: first.credential_id },
      disable: [id(first, "beta")],
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as ChoiceBody).models).toEqual([
      expect.objectContaining({ modelId: "beta", enabled: false }),
    ]);
  });

  it("refuses switching off the default, and moves the default first when asked", async () => {
    const first = (await (
      await apply({
        credential: GATEWAY_KEY,
        add: [{ modelId: "alpha" }, { modelId: "beta" }],
        default_model_id: "alpha",
      })
    ).json()) as ChoiceBody;
    const alpha = first.models.find((m) => m.modelId === "alpha")!.id;

    const refused = await apply({ credential: { id: first.credential_id }, disable: [alpha] });
    expect(refused.status).toBe(400);
    expect(await defaultOf()).toBe(alpha);

    // CONTROL: the default moves before the switch off, in the same write.
    const moved = await apply({
      credential: { id: first.credential_id },
      disable: [alpha],
      default_model_id: "beta",
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await defaultOf()).toBe(first.models.find((m) => m.modelId === "beta")!.id);
  });

  it("requires the credential grant to mint a key", async () => {
    // A member holds neither `models:write` nor the credential grants.
    const member = await memberContext(ctx, "member");
    expect((await apply({ credential: GATEWAY_KEY, add: [] }, member)).status).toBe(403);
    expect(await credentialsOf()).toEqual([]);
  });
});
