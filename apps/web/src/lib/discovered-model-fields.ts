// SPDX-License-Identifier: Apache-2.0

/**
 * One discovered model → the model-form fields it fills in.
 *
 * A discovery runs against an operator-supplied endpoint, which has no vendored
 * catalog behind it: whatever the listing reported has to be written as an
 * explicit override or nothing resolves it on read. Every capability field is
 * therefore always written — the listing's value when it described one, the
 * form's blank default otherwise — so a pick describes the model it names and
 * nothing else.
 */

import type { DiscoveredModel } from "../hooks/use-model-provider-credentials";
import type { ModelFormFields } from "./model-form-payload";

/** The complete set of fields a pick owns. */
type DiscoveredModelFields = Pick<
  ModelFormFields,
  "modelId" | "label" | "contextWindow" | "maxTokens" | "inputText" | "inputImage" | "reasoning"
>;

export function discoveredModelToFieldValues(model: DiscoveredModel): DiscoveredModelFields {
  return {
    modelId: model.id,
    label: model.label ?? model.id,
    contextWindow: model.context_window !== null ? String(model.context_window) : "",
    maxTokens: model.max_tokens !== null ? String(model.max_tokens) : "",
    inputText: model.input?.includes("text") ?? true,
    inputImage: model.input?.includes("image") ?? false,
    reasoning: model.reasoning ?? false,
  };
}
