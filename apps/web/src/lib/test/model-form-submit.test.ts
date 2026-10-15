// SPDX-License-Identifier: Apache-2.0

/**
 * `submitModelForm` — a creation is ONE `apply` (key, models and binding written together or not
 * at all), so a refusal reports what the server said per entry and leaves nothing to resume; only
 * an edit is still a `PATCH`, with the typed key minted first and named back when it is refused.
 */

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import type { ModelChoiceBody } from "../../hooks/use-apply-model-choice.ts";
import type {
  ModelFormData,
  ModelFormMultiData,
  NewCredentialBody,
} from "../model-form-payload.ts";
import { submitModelForm, type ModelFormWrites } from "../model-form-submit.ts";

const NEW_CREDENTIAL = { api_key: "sk-abc", providerId: "openai" };

/** Records every write; `refuse` is the error the named write throws. */
function harness(refuse?: { apply?: unknown; credential?: unknown; update?: unknown }) {
  const applied: ModelChoiceBody[] = [];
  const updated: { id: string; credentialId: string | null }[] = [];
  const credentials: NewCredentialBody[] = [];
  let successes = 0;

  const writes: ModelFormWrites = {
    applyChoice: async (body) => {
      if (refuse?.apply) throw refuse.apply;
      applied.push(body);
    },
    createCredential: async (body) => {
      if (refuse?.credential) throw refuse.credential;
      credentials.push(body);
      return { id: `cred_${credentials.length}` };
    },
    updateModel: async (id, body) => {
      if (refuse?.update) throw refuse.update;
      updated.push({ id, credentialId: body.credentialId });
    },
  };

  return {
    writes,
    applied,
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

const run = (h: ReturnType<typeof harness>, editModelId: string | null = null) =>
  submitModelForm({ writes: h.writes, editModelId, onSuccess: h.onSuccess });

/** What `POST /api/models/apply` answers when entries are refused. */
const refusedEntries = (...items: { field: string; code: string }[]) =>
  new ApiError(
    "validation_failed",
    "Validation failed",
    400,
    items.map((item) => ({ ...item, message: item.code })),
  );

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

describe("submitModelForm — creation is one apply", () => {
  it("sends the typed key and the model in a single write, minting nothing on its own", async () => {
    const h = harness();
    const outcome = await run(h)(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: [], duplicateModelIds: [] });
    expect(h.credentials).toEqual([]);
    expect(h.applied).toEqual([{ credential: NEW_CREDENTIAL, add: [{ modelId: "gpt-6" }] }]);
    expect(h.successes).toBe(1);
  });

  it("binds a batch to the one key and sends every entry in the same write", async () => {
    const h = harness();
    await run(h)(batchWithTypedKey);

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]).toEqual({
      credential: NEW_CREDENTIAL,
      add: [{ modelId: "gpt-6" }, { modelId: "gpt-6-mini" }],
    });
  });

  it("binds to a picked credential by id", async () => {
    const h = harness();
    await run(h)({ modelId: "gpt-6", credentialId: "cred_9" });

    expect(h.applied).toEqual([{ credential: { id: "cred_9" }, add: [{ modelId: "gpt-6" }] }]);
  });

  it("names the provider when each member serves the model with their own credential", async () => {
    const h = harness();
    await run(h)({
      credentialId: null,
      providerId: "openai",
      models: [{ modelId: "gpt-6" }, { modelId: "gpt-6-mini" }],
    });

    expect(h.applied).toEqual([
      {
        credential: null,
        providerId: "openai",
        add: [{ modelId: "gpt-6" }, { modelId: "gpt-6-mini" }],
      },
    ]);
  });

  it("drops the credential and provider from an entry: they ride on the choice", async () => {
    const h = harness();
    await run(h)({ modelId: "gpt-6", credentialId: null, providerId: "openai", reasoning: true });

    expect(h.applied[0]?.add).toEqual([{ modelId: "gpt-6", reasoning: true }]);
  });
});

describe("submitModelForm — a refused creation", () => {
  it("keeps every entry to submit again — nothing was written — and says the server's code", async () => {
    const h = harness({ apply: refusedEntries({ field: "add.1", code: "model_not_offered" }) });
    const outcome = await run(h)(batchWithTypedKey);

    expect(outcome).toEqual({
      failedModelIds: ["gpt-6", "gpt-6-mini"],
      duplicateModelIds: [],
      refusalCode: "model_not_offered",
    });
    expect(h.successes).toBe(0);
  });

  it("reports an entry the organization already holds apart from the ones to retry", async () => {
    const h = harness({
      apply: refusedEntries({ field: "add.0", code: "model_already_added" }),
    });
    const outcome = await run(h)(batchWithTypedKey);

    expect(outcome).toEqual({
      failedModelIds: ["gpt-6", "gpt-6-mini"],
      duplicateModelIds: ["gpt-6"],
    });
    expect(h.successes).toBe(0);
  });

  it("takes the code of a refusal that is the choice's as a whole (a permission, the key)", async () => {
    const h = harness({ apply: new ApiError("forbidden", "Not allowed", 403) });
    const outcome = await run(h)(oneWithTypedKey);

    expect(outcome).toEqual({
      failedModelIds: ["gpt-6"],
      duplicateModelIds: [],
      refusalCode: "forbidden",
    });
  });

  it("reports a transport failure without a code", async () => {
    const h = harness({ apply: new Error("network down") });
    const outcome = await run(h)(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6"], duplicateModelIds: [] });
    expect(h.successes).toBe(0);
  });
});

describe("submitModelForm — edit", () => {
  const unbound: ModelFormData = { modelId: "gpt-6", credentialId: null, providerId: "openai" };

  it("routes an edit to the update write, bound to the minted credential", async () => {
    const h = harness();
    const outcome = await run(h, "mdl_1")(oneWithTypedKey);

    expect(h.updated).toEqual([{ id: "mdl_1", credentialId: "cred_1" }]);
    expect(h.applied).toEqual([]);
    expect(outcome.credentialId).toBe("cred_1");
    expect(h.successes).toBe(1);
  });

  it("reports the minted credential when the update is refused, so a retry rebinds to it", async () => {
    const h = harness({ update: new Error("model refused") });
    const outcome = await run(h, "mdl_1")(oneWithTypedKey);

    expect(outcome.failedModelIds).toEqual(["gpt-6"]);
    expect(outcome.credentialId).toBe("cred_1");
    expect(h.successes).toBe(0);
  });

  it("names no credential when the key itself was refused, and never tries the update", async () => {
    const h = harness({ credential: new Error("key refused") });
    const outcome = await run(h, "mdl_1")(oneWithTypedKey);

    expect(outcome).toEqual({ failedModelIds: ["gpt-6"], duplicateModelIds: [] });
    expect(h.updated).toEqual([]);
  });

  it("sends an unbound edit as an update that clears the credential", async () => {
    const h = harness();
    await run(h, "mdl_1")(unbound);

    expect(h.updated).toEqual([{ id: "mdl_1", credentialId: null }]);
    expect(h.successes).toBe(1);
  });

  it("reports the code of a refused edit, so the form can say it (model_scheduled)", async () => {
    const h = harness({
      update: new ApiError("model_scheduled", "Enabled schedules run this model", 409),
    });
    const outcome = await run(h, "mdl_1")(unbound);

    expect(outcome.failedModelIds).toEqual(["gpt-6"]);
    expect(outcome.refusalCode).toBe("model_scheduled");
    expect(h.successes).toBe(0);
  });
});
