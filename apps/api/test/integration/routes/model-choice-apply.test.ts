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
import { seedApiKey } from "../../helpers/seed.ts";
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

  it("replays the first response on a retry with the same Idempotency-Key", async () => {
    const body = { credential: GATEWAY_KEY, add: [{ modelId: "alpha" }, { modelId: "beta" }] };
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

    // One key and one set of models: the retry wrote nothing.
    expect(await credentialsOf()).toHaveLength(1);
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

  it("refuses to mint a key without the organization-key grant, writing nothing", async () => {
    // A key holding `models:write` alone: the rule is the one of `POST /api/model-provider-credentials`.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["models:write"],
    });
    const res = await app.request("/api/models/apply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ credential: GATEWAY_KEY, add: [{ modelId: "alpha" }] }),
    });
    expect(res.status).toBe(403);
    expect(await credentialsOf()).toEqual([]);
    expect(await modelsOf()).toEqual([]);

    // CONTROL: the owner's session mints the same choice.
    const ok = await apply({ credential: GATEWAY_KEY, add: [{ modelId: "alpha" }] });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it("sets as default the model of the choice's own key when another key serves the same modelId", async () => {
    const a = (await (
      await apply({ credential: { ...GATEWAY_KEY, label: "A" }, add: [{ modelId: "shared" }] })
    ).json()) as ChoiceBody;
    const b = (await (
      await apply({ credential: { ...GATEWAY_KEY, label: "B" }, add: [{ modelId: "shared" }] })
    ).json()) as ChoiceBody;
    expect(a.credential_id).not.toBe(b.credential_id);

    for (const choice of [b, a]) {
      const res = await apply({
        credential: { id: choice.credential_id },
        default_model_id: "shared",
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await defaultOf()).toBe(choice.models[0]!.id);
    }

    // CONTROL: a modelId no model of the key carries is still refused.
    const refused = await apply({
      credential: { id: a.credential_id },
      default_model_id: "absent",
    });
    expect(refused.status).toBe(400);
  });
});
