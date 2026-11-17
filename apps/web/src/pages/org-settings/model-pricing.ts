// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind the `models.unpriced` badge in `models.tsx`. Split from the
 * page so it is testable without importing the component tree (no DOM in tests).
 */

import type { OrgModelInfo } from "../../hooks/use-models";

export type ModelPricingFields = Pick<OrgModelInfo, "source" | "aliased" | "cost">;

/**
 * Whether no rates are known for a model, so every run on it records $0.
 * A `cost` of `{ input: 0, output: 0 }` is an operator asserting the model is
 * free and is deliberately NOT flagged.
 *
 * `aliased` rows are excluded (`projectAliasedModel` always nulls `cost`);
 * `built-in` rows too (system models cannot be edited, so no remedy to offer).
 */
export function isModelUnpriced(model: ModelPricingFields): boolean {
  return model.source !== "built-in" && !model.aliased && model.cost == null;
}
