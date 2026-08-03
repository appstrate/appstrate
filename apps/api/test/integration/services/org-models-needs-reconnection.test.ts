// SPDX-License-Identifier: Apache-2.0

/**
 * `listOrgModels` used to DROP any model whose OAuth credential was flagged
 * `needsReconnection` — while `org_models.credential_id` (ON DELETE RESTRICT)
 * made that credential undeletable. The model was invisible in the UI, so it
 * could not be detached, so the credential could not be deleted: a deadlock
 * observed in production.
 *
 * The row is now listed with `needs_reconnection: true` instead. These tests
 * pin both halves of that contract:
 *   - the read path SHOWS the dead model (regression), while a missing
 *     credential row / unregistered provider is still dropped (nothing to
 *     render), and
 *   - the write + runtime paths stay FAIL-CLOSED — it cannot become the org
 *     default, and `loadModel` still resolves it to null.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { modelProviderCredentials } from "@appstrate/db/schema";
import {
  listOrgModels,
  loadModel,
  setDefaultModel,
  modelNeedsReconnection,
} from "../../../src/services/org-models.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  corruptCredentialBlob,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";

describe("org-models — dead OAuth credential is listed, not hidden", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deadcredorg" });
  });

  /** `test-oauth` is the synthetic core `authMode: "oauth2"` provider. */
  async function seedOAuthModel(needsReconnection: boolean) {
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      label: "Subscription",
      needsReconnection,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "Subscription model",
      modelId: "gpt-5-codex",
      enabled: true,
    });
    return { cred, model };
  }

  async function seedApiKeyModel() {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "GPT-4o",
      modelId: "gpt-4o",
      enabled: true,
    });
    return { cred, model };
  }

  it("lists a model whose OAuth credential needs reconnection, flagged", async () => {
    const { model } = await seedOAuthModel(true);

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    // The regression: this used to be `undefined`.
    expect(listed).toBeDefined();
    expect(listed!.needs_reconnection).toBe(true);
    // Display fields still resolve (from the registry metadata) so the row can
    // actually be rendered and acted on.
    expect(listed!.providerId).toBe("test-oauth");
    expect(listed!.apiShape).toBe("openai-responses");
    expect(listed!.baseUrl).toBe("https://example.test/v1");
    expect(listed!.credentialId).toBe(model.credentialId);
  });

  it("flags a model on a healthy OAuth credential as false", async () => {
    const { model } = await seedOAuthModel(false);

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.needs_reconnection).toBe(false);
    expect(listed!.providerId).toBe("test-oauth");
    expect(listed!.baseUrl).toBe("https://example.test/v1");
  });

  it("flags a model on an api-key credential as false, with the decrypt path untouched", async () => {
    const { cred, model } = await seedApiKeyModel();

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed).toBeDefined();
    expect(listed!.needs_reconnection).toBe(false);
    // Same resolver as before the flag existed — the projection must stay
    // byte-identical to what the run path's credential lookup produces.
    expect(listed!.providerId).toBe("openai");
    expect(listed!.apiShape).toBe("openai-responses");
    expect(listed!.baseUrl).toBe("https://api.openai.com/v1");
    expect(listed!.credentialId).toBe(cred.id);

    const resolved = await loadModel(ctx.orgId, model.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.apiKey).toBe("sk-test");
    expect(resolved!.providerId).toBe("openai");
    expect(resolved!.apiShape).toBe("openai-responses");
    expect(resolved!.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("flags an api-key model whose stored blob no longer decrypts", async () => {
    const { cred, model } = await seedApiKeyModel();
    await corruptCredentialBlob(cred.id);

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    // Listed (so it can be detached/deleted) but never presented as usable.
    expect(listed).toBeDefined();
    expect(listed!.needs_reconnection).toBe(true);
    expect(listed!.providerId).toBe("openai");
    // Fail-closed at the runtime boundary, exactly like a dead OAuth row.
    expect(await loadModel(ctx.orgId, model.id)).toBeNull();
  });

  it("still drops a model whose credential has an unregistered providerId", async () => {
    const { cred, model } = await seedApiKeyModel();
    // The credential ROW cannot be deleted while the model references it
    // (ON DELETE RESTRICT) — the reachable way to lose the provider is a
    // `providerId` with no registry entry (module removed from MODULES).
    // Without one there is no apiShape/baseUrl to render, so the row stays
    // dropped; recovering it is out of scope here.
    await db
      .update(modelProviderCredentials)
      .set({ providerId: "@gone/provider" })
      .where(eq(modelProviderCredentials.id, cred.id));

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed).toBeUndefined();

    // …and the predicate agrees with the list on this row. The credential is
    // healthy — only its provider module is gone — so answering `true` here
    // would 409 `PUT /api/models/default` with "reconnect this credential",
    // advice that fixes nothing, about a row the client cannot even see. The
    // fix is to restore the module; until then this behaves as it did before
    // the flag existed.
    expect(await modelNeedsReconnection(ctx.orgId, model.id)).toBe(false);
  });

  it("refuses to make a dead model the org default (409 model_needs_reconnection)", async () => {
    const { model } = await seedOAuthModel(true);
    expect(await modelNeedsReconnection(ctx.orgId, model.id)).toBe(true);

    let thrown: unknown;
    try {
      await setDefaultModel(ctx.orgId, model.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_needs_reconnection");

    // The pointer was never written — the org default is untouched.
    const listed = await listOrgModels(ctx.orgId);
    expect(listed.find((m) => m.id === model.id)!.is_default).toBe(false);
  });

  it("refuses an api-key model whose blob no longer decrypts as the org default", async () => {
    // Before `modelNeedsReconnection` used the list's predicate, this returned
    // 200: the list badged the model dead while the setter happily pointed the
    // org default at it. Pin that the two surfaces agree.
    const { cred, model } = await seedApiKeyModel();
    await corruptCredentialBlob(cred.id);

    let thrown: unknown;
    try {
      await setDefaultModel(ctx.orgId, model.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe("model_needs_reconnection");
  });

  it("keeps modelNeedsReconnection false for a healthy model and for a disabled one", async () => {
    // The broadened predicate must not swallow the early returns that own the
    // callers' 404 / fall-through semantics.
    const { model: healthy } = await seedApiKeyModel();
    expect(await modelNeedsReconnection(ctx.orgId, healthy.id)).toBe(false);

    // Disabled: `loadModel` is null for the row regardless of its credential,
    // so "needs reconnection" must stay false — the caller's answer is
    // "not enabled", not "go reconnect".
    //
    // This is the one place the predicate deliberately diverges from the list,
    // which flags a dead-credential row regardless of `enabled`. Both are
    // right for their surface: the badge explains why a row the user is
    // looking at is unusable, while a disabled model is inert either way
    // (`resolveModel` cascades past it) and the step that unblocks it is
    // "enable it", not "reconnect the credential". Not an oversight — do not
    // "fix" this to true.
    const { cred } = await seedOAuthModel(true);
    const disabled = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "Disabled on a dead credential",
      modelId: "gpt-5-codex",
      enabled: false,
    });
    expect(await modelNeedsReconnection(ctx.orgId, disabled.id)).toBe(false);
  });

  it("still sets the org default for a healthy model", async () => {
    const { model } = await seedOAuthModel(false);

    await setDefaultModel(ctx.orgId, model.id);

    const listed = (await listOrgModels(ctx.orgId)).find((m) => m.id === model.id);
    expect(listed!.is_default).toBe(true);
  });

  it("keeps loadModel fail-closed for a dead model", async () => {
    const { model } = await seedOAuthModel(true);
    // The security-relevant half: listing the row must NOT make it resolvable
    // for inference. The runtime path is unchanged.
    expect(await loadModel(ctx.orgId, model.id)).toBeNull();
  });
});
