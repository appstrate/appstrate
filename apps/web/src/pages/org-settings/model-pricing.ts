// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind "does this model row have no pricing the platform knows".
 *
 * The models list is the only PRE-spend surface that says anything about
 * pricing: a run's `cost_pricing_status` reports the same fact after the money
 * is gone. This module is the single decision; the `models.unpriced` badge in
 * `models.tsx` is its only renderer.
 *
 * Split from the page because the web test runner has no DOM: the two
 * exclusions are the part worth testing, and they are testable only if they do
 * not import the component tree. Dropping `!aliased` would flag every
 * correctly-priced managed model, and no JSX assertion exists to catch it.
 */

import type { OrgModelInfo } from "../../hooks/use-models";

/**
 * The fields the rule reads. Derived from the wire row rather than restated —
 * the shape is owned by the OpenAPI `OrgModel` schema and reaches here through
 * {@link OrgModelInfo}, so a wire change (notably `cost` becoming required)
 * still lands in this file. Narrowed to three fields so a test fixture is
 * three fields rather than the whole projection.
 */
export type ModelPricingFields = Pick<OrgModelInfo, "source" | "aliased" | "cost">;

/**
 * Whether no rates are known for a model, so every run on it records $0.
 *
 * `cost` is the catalog-RESOLVED value, so null (or absent) means no rates
 * exist anywhere. A `cost` of `{ input: 0, output: 0 }` is a different claim —
 * an operator asserting the model really is free — and is deliberately NOT
 * flagged. That is the distinction the ledger draws: "no rates known" is not
 * "free".
 *
 * Two exclusions carry the correctness:
 *   - `aliased` rows are excluded because `projectAliasedModel` nulls `cost`
 *     unconditionally (it would fingerprint the backing) — a priced alias
 *     would otherwise always flag.
 *   - `built-in` rows are excluded because their rates come from
 *     `SYSTEM_PROVIDER_KEYS`, and `PUT /api/models/{id}` answers
 *     `systemEntityForbidden` on a system id: the viewer has no remedy to
 *     point at.
 */
export function isModelUnpriced(model: ModelPricingFields): boolean {
  return model.source !== "built-in" && !model.aliased && model.cost == null;
}
