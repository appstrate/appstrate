// SPDX-License-Identifier: Apache-2.0

/**
 * `submitModelForm` — what a refused submission reports back.
 *
 * The modal re-submits the SAME form on a retry, inline key included. So every
 * refusal that happens after the key was minted has to name the credential it
 * minted; the modal binds the retry to it. Without that the retry mints a
 * second credential holding the same secret and leaves the first referenced by
 * no model.
 */

import { describe, expect, it } from "bun:test";
import type { ModelFormData, ModelFormMultiData } from "../model-form-payload.ts";
import {
  submitModelForm,
  type ModelFormCreateBody,
  type ModelFormWrites,
} from "../model-form-submit.ts";

const NEW_CREDENTIAL = { apiKey: "sk-abc", providerId: "openai" };

/** Records every write; `refuse` names the step that throws. */
function harness(refuse?: "credential" | "model") {
  const created: ModelFormCreateBody[] = [];
  const updated: { id: string; credentialId: string }[] = [];
  const credentials: { providerId: string; apiKey: string }[] = [];
  let successes = 0;

  const writes: ModelFormWrites = {
    createCredential: async (body) => {
      if (refuse === "credential") throw new Error("key refused");
      credentials.push({ providerId: body.providerId, apiKey: body.apiKey });
      return { id: `cred_${credentials.length}` };
    },
    createModel: async (body) => {
      if (refuse === "model") throw new Error("model refused");
      created.push(body);
    },
    updateModel: async (id, body) => {
      if (refuse === "model") throw new Error("model refused");
      updated.push({ id, credentialId: body.credentialId });
    },
  };

  return {
    writes,
    created,
    updated,
    credentials,
    onSuccess: () => {
      successes += 1;
    },
    get successes() {
      return successes;
    },
  };
}

const oneWithTypedKey: ModelFormData = {
  modelId: "gpt-6",
  credentialId: "",
  newCredential: NEW_CREDENTIAL,
};

const batchWithTypedKey: ModelFormMultiData = {
  credentialId: "",
  newCredential: NEW_CREDENTIAL,
  models: [{ modelId: "gpt-6" }, { modelId: "gpt-6-mini" }],
};

describe("submitModelForm — single model", () => {
  it("reports the minted credential when the model is refused, so a retry rebinds to it", async () => {
    const h = harness("model");
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(oneWithTypedKey);

    expect(outcome.failedModelIds).toEqual(["gpt-6"]);
    expect(outcome.credentialId).toBe("cred_1");
    expect(h.credentials).toHaveLength(1);
    expect(h.successes).toBe(0);

    // The retry the modal builds from that outcome: the picked credential, no
    // inline key — so nothing new is minted.
    const retry = harness();
    const second = await submitModelForm({
      writes: retry.writes,
      editModelId: null,
      onSuccess: retry.onSuccess,
    })({ modelId: "gpt-6", credentialId: outcome.credentialId! });

    expect(second.failedModelIds).toEqual([]);
    expect(retry.credentials).toEqual([]);
    expect(retry.created[0]?.credentialId).toBe("cred_1");
    expect(retry.successes).toBe(1);
  });

  it("names no credential when the key itself was refused, and never tries the model", async () => {
    const h = harness("credential");
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6"] });
    expect(h.created).toEqual([]);
  });

  it("binds a successful create to the credential it minted", async () => {
    const h = harness();
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: [] });
    expect(h.created).toEqual([{ modelId: "gpt-6", credentialId: "cred_1" }]);
    expect(h.successes).toBe(1);
  });

  it("routes an edit to the update write, bound to the minted credential", async () => {
    const h = harness();
    await submitModelForm({ writes: h.writes, editModelId: "mdl_1", onSuccess: h.onSuccess })(
      oneWithTypedKey,
    );

    expect(h.updated).toEqual([{ id: "mdl_1", credentialId: "cred_1" }]);
    expect(h.created).toEqual([]);
  });

  it("reports the minted credential when an edit is refused", async () => {
    const h = harness("model");
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: "mdl_1",
      onSuccess: h.onSuccess,
    })(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6"], credentialId: "cred_1" });
  });
});

describe("submitModelForm — batch", () => {
  it("reports the shared credential alongside the ids it could not create", async () => {
    const h = harness("model");
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(batchWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6", "gpt-6-mini"], credentialId: "cred_1" });
    expect(h.credentials).toHaveLength(1);
    expect(h.successes).toBe(0);
  });

  it("names no credential when the key itself was refused", async () => {
    const h = harness("credential");
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(batchWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6", "gpt-6-mini"] });
    expect(h.created).toEqual([]);
  });

  it("creates every entry against one credential and reports it", async () => {
    const h = harness();
    const outcome = await submitModelForm({
      writes: h.writes,
      editModelId: null,
      onSuccess: h.onSuccess,
    })(batchWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: [], credentialId: "cred_1" });
    expect(h.created.map((m) => m.credentialId)).toEqual(["cred_1", "cred_1"]);
    expect(h.successes).toBe(1);
  });
});
