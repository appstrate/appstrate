// SPDX-License-Identifier: Apache-2.0

/**
 * The writes a model choice is made of, in the order the dialog relies on: the key, the
 * models added, those switched back on, the default, then those switched off.
 */

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import i18n, { i18nReady } from "../../i18n.ts";
import type { ModelPickRow } from "../../lib/model-source.ts";
import { refusalMessage } from "../../lib/mutation-error.ts";
import { orgModelFixture } from "../../test/org-model-fixture.ts";
import { knownModels } from "../../lib/model-choice.ts";
import { applyModelChoice, attemptTarget } from "../use-apply-model-choice.ts";

await i18nReady;
await i18n.changeLanguage("fr");

type Writes = Parameters<typeof applyModelChoice>[0];

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

/** Fake writes recording each call; `refuse` maps a model id (or `key`) to what it throws. */
function recorder(refuse: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const writes = {
    createCredential: async () => {
      calls.push("key");
      if (refuse.key) throw refuse.key;
      return { id: "cred_new" };
    },
    createModel: async ({ body }: { body: { modelId: string } }) => {
      calls.push(`add ${body.modelId}`);
      bodies.push(body);
      if (refuse[body.modelId]) throw refuse[body.modelId];
      return orgModelFixture({ id: `mdl_${body.modelId}`, modelId: body.modelId });
    },
    updateModel: async ({
      params,
      body,
    }: {
      params: { path: { id: string } };
      body: { enabled: boolean };
    }) => {
      calls.push(`${body.enabled ? "enable" : "disable"} ${params.path.id}`);
      if (refuse[params.path.id]) throw refuse[params.path.id];
      return orgModelFixture();
    },
    setDefault: async ({ body }: { body: { modelId: string } }) => {
      calls.push(`default ${body.modelId}`);
      return { modelId: body.modelId };
    },
  } as unknown as Writes;
  return { writes, calls, bodies };
}

const switchedOff = orgModelFixture({ id: "mdl_off", modelId: "haiku", enabled: false });
const current = orgModelFixture({ id: "mdl_cur", modelId: "sonnet", is_default: true });

describe("applyModelChoice", () => {
  it("mints the key, adds, switches on, moves the default, then switches off", async () => {
    const { writes, calls, bodies } = recorder();
    const outcome = await applyModelChoice(writes, {
      plan: {
        add: [row("opus")],
        grant: [switchedOff],
        withdraw: [current],
        defaultModelId: "opus",
      },
      existing: [switchedOff, current],
      target: { credentialId: null, providerId: "anthropic" },
      newCredential: { label: "Anthropic", providerId: "anthropic", apiKey: "sk-test" },
    });
    expect(calls).toEqual([
      "key",
      "add opus",
      "enable mdl_off",
      "default mdl_opus",
      "disable mdl_cur",
    ]);
    // The models land on the key just minted, not on « each person's own ».
    expect(bodies).toEqual([{ modelId: "opus", credentialId: "cred_new" }]);
    expect(outcome.credentialId).toBe("cred_new");
    expect(outcome.failedModelIds).toEqual([]);
    expect(outcome.createdModels.map((m) => [m.id, m.is_default])).toEqual([["mdl_opus", true]]);
  });

  it("names the service on a model left to each person's own key", async () => {
    const { writes, bodies } = recorder();
    const outcome = await applyModelChoice(writes, {
      plan: { add: [row("opus")], grant: [], withdraw: [], defaultModelId: null },
      existing: [],
      target: { credentialId: null, providerId: "anthropic" },
    });
    expect(bodies).toEqual([{ modelId: "opus", credentialId: null, providerId: "anthropic" }]);
    expect(outcome.credentialId).toBeNull();
  });

  it("reports a refused model with the first sentence it has, and goes on with the rest", async () => {
    const refused = new ApiError("forbidden", "Insufficient permissions", 403);
    const { writes, calls } = recorder({ opus: refused, mdl_off: new Error("network") });
    const outcome = await applyModelChoice(writes, {
      plan: {
        add: [row("opus"), row("mini")],
        grant: [switchedOff],
        withdraw: [],
        defaultModelId: "sonnet",
      },
      existing: [switchedOff, current],
      target: { credentialId: "cred_org", providerId: "anthropic" },
    });
    expect(calls).toEqual(["add opus", "add mini", "enable mdl_off", "default mdl_cur"]);
    expect(outcome.failedModelIds).toEqual(["opus", "haiku"]);
    expect(outcome.refusal).not.toBeNull();
    expect(outcome.refusal).toBe(refusalMessage(refused));
    expect(outcome.createdModels.map((m) => m.id)).toEqual(["mdl_mini"]);
  });

  it("writes nothing when the key is refused", async () => {
    const { writes, calls } = recorder({ key: new ApiError("forbidden", "no", 403) });
    const choice = applyModelChoice(writes, {
      plan: { add: [row("opus")], grant: [], withdraw: [current], defaultModelId: "opus" },
      existing: [current],
      target: { credentialId: null, providerId: "anthropic" },
      newCredential: { label: "Anthropic", providerId: "anthropic", apiKey: "sk-test" },
    });
    await expect(choice).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual(["key"]);
  });

  it("retries a refused model on the key the first attempt minted, without minting a second", async () => {
    const draft = { label: "Anthropic", providerId: "anthropic", apiKey: "sk-test" };
    const base = { credentialId: null, providerId: "anthropic", newCredential: draft };
    const first = recorder({ mini: new Error("network") });
    const outcome = await applyModelChoice(first.writes, {
      plan: { add: [row("opus"), row("mini")], grant: [], withdraw: [], defaultModelId: null },
      existing: [],
      ...attemptTarget(null, base),
    });
    expect(first.calls).toEqual(["key", "add opus", "add mini"]);

    // The dialog keeps the key and the models created, and asks only for the rest.
    const existing = knownModels([], outcome.createdModels);
    const retry = recorder();
    await applyModelChoice(retry.writes, {
      plan: { add: [row("mini")], grant: [], withdraw: [], defaultModelId: "opus" },
      existing,
      ...attemptTarget(outcome.credentialId, base),
    });
    expect(retry.calls).toEqual(["add mini", "default mdl_opus"]);
    expect(retry.bodies).toEqual([{ modelId: "mini", credentialId: "cred_new" }]);
  });
});
