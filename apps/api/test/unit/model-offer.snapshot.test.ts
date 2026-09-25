// SPDX-License-Identifier: Apache-2.0

/**
 * Every offered model, one line each, so a Pi bump reviews as one diff line per
 * changed model: `provider id api ctx max $=in/out/cacheRead/cacheWrite [>tier:rates]
 * caps levels temp [temp+reasoning] [adaptive] [featured]`. Regenerate with
 * `bun test --update-snapshots`; under `CI=true` a missing snapshot fails.
 */

import { describe, expect, it } from "bun:test";
import type { ModelCost, ModelProviderDefinition } from "@appstrate/core/module";
import type { CatalogModelEntry } from "@appstrate/shared-types";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import codexModule from "@appstrate/module-codex";
import claudeCodeModule from "@appstrate/module-claude-code";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";
import { listCatalogModels } from "../../src/services/model-catalog.ts";

const providers = [coreProvidersModule, codexModule, claudeCodeModule].flatMap(
  (module) => module.modelProviders!() as ModelProviderDefinition[],
);

function rates(c: Omit<ModelCost, "tiers">): string {
  return `${c.input}/${c.output}/${c.cacheRead ?? 0}/${c.cacheWrite ?? 0}`;
}

function line(def: ModelProviderDefinition, m: CatalogModelEntry & { id: string }): string {
  const reasoning = m.generation?.reasoning;
  const levels = Object.entries(reasoning?.levels ?? {})
    .filter(([, support]) => support === "supported")
    .map(([level]) => level);
  const tiers = (m.cost?.tiers ?? []).map((t) => `>${t.inputTokensAbove}:${rates(t)}`);
  return [
    def.providerId,
    m.id,
    def.apiShape,
    `ctx=${m.contextWindow}`,
    `max=${m.maxTokens ?? "-"}`,
    m.cost ? `$=${rates(m.cost)}` : "$=unpriced",
    ...tiers,
    `caps=${m.capabilities.join(",")}`,
    `levels=${levels.join(",") || "-"}`,
    `temp=${m.generation?.temperature ?? "-"}`,
    reasoning?.temperature_compatible ? `temp+reasoning=${reasoning.temperature_compatible}` : "",
    reasoning?.adaptive ? "adaptive" : "",
    def.featuredModels.includes(m.id) ? "featured" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

describe("model offer", () => {
  it("matches the reviewed snapshot for the pinned Pi SDK", () => {
    const lines = providers.flatMap((def) => listCatalogModels(def).map((m) => line(def, m)));
    expect([`pi-ai ${PI_SDK_VERSION}`, ...lines].join("\n")).toMatchSnapshot();
  });

  it("features only offered ids", () => {
    for (const def of providers) {
      const offered = new Set(listCatalogModels(def).map((m) => m.id));
      expect(def.featuredModels.filter((id) => !offered.has(id))).toEqual([]);
    }
  });
});
