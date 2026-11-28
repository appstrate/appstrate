// SPDX-License-Identifier: Apache-2.0

/**
 * A model choice is one write (`POST /api/models/apply`): its body names the configuration, the
 * models added and those switched on and off; a refusal comes back entry by entry and
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
};

describe("modelChoiceBody", () => {
  it("names the configuration, with every switch", () => {
    expect(modelChoiceBody({ plan, configId: "cfg_anthropic" })).toEqual({
      config_id: "cfg_anthropic",
      add: [{ modelId: "opus" }],
      enable: ["mdl_off"],
      disable: ["mdl_cur"],
    });
  });

  it("never sets the default: it is chosen at the top of the page", () => {
    expect(modelChoiceBody({ plan, configId: "cfg_anthropic" })).not.toHaveProperty(
      "default_model_id",
    );
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

  it("names the entry of a body-validation path (add[<i>].<key>)", () => {
    const err = refused([{ field: "add[0].maxTokens", code: "invalid_value", message: "too big" }]);
    expect(choiceRefusal(err, plan)?.failedModelIds).toEqual(["opus"]);
  });

  it("is not an entry refusal when the configuration or the permission is refused", () => {
    expect(choiceRefusal(new ApiError("forbidden", "no", 403), plan)).toBeNull();
    expect(
      choiceRefusal(refused([{ field: "config_id", code: "invalid_request" }]), plan),
    ).toBeNull();
  });
});
