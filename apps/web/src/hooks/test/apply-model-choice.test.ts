// SPDX-License-Identifier: Apache-2.0

/**
 * A model choice is one write (`POST /api/models/apply`): its body names the key, the models
 * added, those switched on and off, and the default; a refusal comes back entry by entry and
 * writes nothing, so the dialog only has to say which entries the server refused.
 */

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import type { ModelPickRow } from "../../lib/model-source.ts";
import { refusalMessage } from "../../lib/mutation-error.ts";
import { orgModelFixture } from "../../test/org-model-fixture.ts";
import { choiceRefusal, modelChoiceBody } from "../use-apply-model-choice.ts";

await i18nReady;
await i18n.changeLanguage("fr");

function row(id: string): ModelPickRow {
  return {
    id,
    label: id,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: "catalog",
    endpointCapabilities: {},
    cost: null,
    origin: "catalog",
    featured: false,
  };
}

const switchedOff = orgModelFixture({ id: "mdl_off", modelId: "haiku", enabled: false });
const current = orgModelFixture({ id: "mdl_cur", modelId: "sonnet", is_default: true });
const plan = {
  add: [row("opus")],
  grant: [switchedOff],
  withdraw: [current],
  defaultModelId: "opus",
};

describe("modelChoiceBody", () => {
  it("mints the key in the same write, with every switch and the default", () => {
    expect(
      modelChoiceBody({
        plan,
        target: { credentialId: null, providerId: "anthropic" },
        newCredential: { label: "Anthropic", providerId: "anthropic", apiKey: "sk-test" },
      }),
    ).toEqual({
      credential: { label: "Anthropic", providerId: "anthropic", api_key: "sk-test" },
      add: [{ modelId: "opus" }],
      enable: ["mdl_off"],
      disable: ["mdl_cur"],
      default_model_id: "opus",
    });
  });

  it("binds to an existing key by id", () => {
    const body = modelChoiceBody({
      plan: { ...plan, defaultModelId: null },
      target: { credentialId: "cred_org", providerId: "anthropic" },
    });
    expect(body.credential).toEqual({ id: "cred_org" });
    expect(body).not.toHaveProperty("providerId");
    expect(body).not.toHaveProperty("default_model_id");
  });

  it("names the service of models left to each person's own key", () => {
    const body = modelChoiceBody({ plan, target: { credentialId: null, providerId: "anthropic" } });
    expect(body.credential).toBeNull();
    expect(body.providerId).toBe("anthropic");
  });
});

describe("choiceRefusal", () => {
  const refused = (errors: unknown[]) =>
    new ApiError("validation_failed", "add.0: no", 400, errors);

  it("names each refused entry by its upstream id, with the first sentence it has", () => {
    const err = refused([
      { field: "add.0", code: "model_already_added", message: "already" },
      { field: "enable.0", code: "model_not_in_choice", message: "not here" },
      { field: "disable.0", code: "model_disabled", message: "default" },
    ]);
    const outcome = choiceRefusal(err, plan);
    expect(outcome?.failedModelIds).toEqual(["opus", "haiku", "sonnet"]);
    expect(outcome?.refusal).toBe(
      refusalMessage({ code: "model_already_added", field: "add.0", message: "already" }),
    );
  });

  it("is not an entry refusal when the key or the permission is refused", () => {
    expect(choiceRefusal(new ApiError("forbidden", "no", 403), plan)).toBeNull();
    expect(
      choiceRefusal(refused([{ field: "credential.providerId", code: "invalid_request" }]), plan),
    ).toBeNull();
  });
});
