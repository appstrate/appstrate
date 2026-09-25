// SPDX-License-Identifier: Apache-2.0

/**
 * Guards that proxying, fed the platform's own inputs, reproduces the request
 * Pi sends the vendor natively, for every model a provider offers — core
 * providers and the codex / claude-code subscriptions alike. "Natively" is
 * Pi's record, looked up by the provider's Pi key; the platform build takes
 * everything from that record except the wire fields (id, baseUrl) and the
 * org's explicit values, which here are the resolved catalog values — Pi's
 * record again. Two documented differences are modelled, not hidden:
 * `PLATFORM_MODEL_COMPAT` wins over the record's compat, and both sides use
 * the wire id (a preset id through llm-proxy), so quirks Pi keys on
 * `model.id` are out of scope.
 *
 * The run container takes the same resolved values through its env round-trip
 * and must land on the same token limits as the in-process build (chat, CLI).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import claudeCodeModule from "@appstrate/module-claude-code";
import codexModule from "@appstrate/module-codex";
import { buildRuntimePiEnv, llmProxyBaseUrl, type Api, type Model } from "@appstrate/runner-pi";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { buildPiModel, DEFAULT_MAX_TOKENS, type PiModelSpec } from "@appstrate/runner-pi/pi-model";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";
import { listCatalogModels, piProviderOf } from "../../src/services/model-catalog.ts";
import { resolveCatalogDefaults } from "../../src/services/org-models.ts";
import {
  registerModelProviders,
  resetModelProviders,
} from "../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";
import { capturePayload, nativeModel } from "../../../../packages/runner-pi/test/pi-payload.ts";
import { buildPiModelFromEnv, parseRuntimeEnv } from "../../../../runtime-pi/env.ts";

const ORIGIN = "https://appstrate.test";
const PRESET_ID = "0c6d1f0e-2b1a-4c8e-9d3f-5a7b8c9d0e1f";
const REASONING = [undefined, "medium"] as const;

const providers = [coreProvidersModule, codexModule, claudeCodeModule].flatMap(
  (module) => module.modelProviders!() as ModelProviderDefinition[],
);

/** What the platform hands `buildPiModel`: its Pi key and resolved catalog values. */
function platformSpec(def: ModelProviderDefinition, modelId: string): PiModelSpec {
  const defaults = resolveCatalogDefaults(def.providerId, modelId);
  const proxyUrl = llmProxyBaseUrl(ORIGIN, def.apiShape);
  return {
    id: proxyUrl ? PRESET_ID : modelId,
    registryModelId: modelId,
    apiShape: def.apiShape,
    piProvider: piProviderOf(def),
    baseUrl: proxyUrl ?? "http://sidecar:8080/llm",
    reasoning: defaults.reasoning,
    input: defaults.input,
    cost: defaults.cost,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

/** The run container's model: the resolved values through `buildRuntimePiEnv` and back. */
function containerModel(def: ModelProviderDefinition, modelId: string): Model<Api> {
  const defaults = resolveCatalogDefaults(def.providerId, modelId);
  const env = buildRuntimePiEnv({
    model: {
      api: def.apiShape,
      modelId,
      piProvider: piProviderOf(def),
      apiKey: "sk-test",
      apiKeyPlaceholder: "sk-placeholder",
      input: defaults.input,
      contextWindow: defaults.contextWindow,
      maxTokens: defaults.maxTokens,
      reasoning: defaults.reasoning,
      cost: defaults.cost,
    },
    agentPrompt: "sys",
    runId: "run_parity",
    sidecarUrl: "http://sidecar:8080",
    sidecarAuthToken: "sidecar-auth-token",
    forwardProxyUrl: "http://sidecar:8081",
    noProxy: "sidecar,localhost,127.0.0.1",
    sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    sink: {
      url: `${ORIGIN}/api/runs/run_parity/events`,
      finalizeUrl: `${ORIGIN}/api/runs/run_parity/events/finalize`,
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  return buildPiModelFromEnv(parseRuntimeEnv(env));
}

const limitsOf = ({ contextWindow, maxTokens }: Model<Api>) => ({ contextWindow, maxTokens });

/** Pi's own record under the wire id, with the platform's refusals on top. */
function nativeReference(def: ModelProviderDefinition, spec: PiModelSpec): Model<Api> {
  const record = nativeModel(piProviderOf(def)!, spec.registryModelId!)!;
  expect(record.api).toBe(def.apiShape);
  return { ...record, id: spec.id, compat: { ...record.compat, ...PLATFORM_MODEL_COMPAT } };
}

async function expectParity(def: ModelProviderDefinition, modelId: string) {
  const spec = platformSpec(def, modelId);
  const proxied = buildPiModel(spec);
  expect({ modelId, ...limitsOf(containerModel(def, modelId)) }).toEqual({
    modelId,
    ...limitsOf(proxied),
  });
  const native = nativeReference(def, spec);
  for (const reasoning of REASONING) {
    expect({ modelId, reasoning, payload: await capturePayload(proxied, reasoning) }).toEqual({
      modelId,
      reasoning,
      payload: await capturePayload(native, reasoning),
    });
  }
}

describe("proxied Pi model payload parity", () => {
  beforeAll(() => {
    resetModelProviders();
    registerModelProviders(providers);
  });
  afterAll(() => seedTestModelProviders());

  it("covers every provider, the subscriptions included", () => {
    const ids = providers.map((p) => p.providerId);
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "codex", "claude-code"]));
    for (const id of ["codex", "claude-code"]) {
      expect(listCatalogModels(providers.find((p) => p.providerId === id)!).length).toBeGreaterThan(
        0,
      );
    }
  });

  for (const def of providers) {
    const modelIds = listCatalogModels(def).map((m) => m.id);
    describe(def.providerId, () => {
      for (const modelId of modelIds) it(modelId, () => expectParity(def, modelId));
    });
  }

  // pi-ai 0.86.1 records a cap equal to the window: no room left for the prompt.
  it("mistral-medium-2604: a record cap filling the window resolves to the default on every path", () => {
    const def = providers.find((p) => p.providerId === "mistral")!;
    const record = nativeModel("mistral", "mistral-medium-2604")!;
    expect(record.maxTokens).toBe(record.contextWindow);
    const expected = { contextWindow: record.contextWindow, maxTokens: DEFAULT_MAX_TOKENS };
    expect(limitsOf(buildPiModel(platformSpec(def, record.id)))).toEqual(expected);
    expect(limitsOf(containerModel(def, record.id))).toEqual(expected);
  });

  // A custom gateway serving a Claude id borrows the `anthropic` key but is not
  // Anthropic: the record's adaptive thinking would be the wrong dialect.
  it("anthropic-compatible: a claude-* id gets no record of Pi's", async () => {
    const def = providers.find((p) => p.providerId === "anthropic-compatible")!;
    const recorded = nativeModel("anthropic", "claude-sonnet-4-6")!;
    expect(recorded.compat).toMatchObject({ forceAdaptiveThinking: true });

    const model = buildPiModel({ ...platformSpec(def, recorded.id), reasoning: true });
    expect(model.provider).toBe("anthropic");
    expect(model.compat).toEqual({ ...PLATFORM_MODEL_COMPAT });
    const payload = await capturePayload(model, "medium");
    expect(payload).toMatchObject({ thinking: { type: "enabled" } });
    expect(payload).not.toEqual(await capturePayload({ ...recorded, id: model.id }, "medium"));
  });
});
