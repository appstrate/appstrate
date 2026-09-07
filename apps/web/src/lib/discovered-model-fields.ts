// SPDX-License-Identifier: Apache-2.0

/**
 * One discovered model → the model-form fields it fills in.
 *
 * A discovery runs against an operator-supplied endpoint, which has no
 * vendored catalog behind it: whatever the listing reported has to be written
 * as an explicit override or nothing resolves it on read. Metadata the listing
 * left `null` is therefore ABSENT here rather than zeroed — the form keeps
 * whatever the operator already typed for that capability.
 */

import type { DiscoveredModel } from "../hooks/use-model-provider-credentials";
import type { ModelFormFields } from "./model-form-payload";

/** The id and the display name always land; the capabilities only when known. */
type DiscoveredModelFields = Pick<ModelFormFields, "modelId" | "label"> &
  Partial<
    Pick<ModelFormFields, "contextWindow" | "maxTokens" | "inputText" | "inputImage" | "reasoning">
  >;

export function discoveredModelToFieldValues(model: DiscoveredModel): DiscoveredModelFields {
  return {
    modelId: model.id,
    label: model.label ?? model.id,
    ...(model.context_window !== null ? { contextWindow: String(model.context_window) } : {}),
    ...(model.max_tokens !== null ? { maxTokens: String(model.max_tokens) } : {}),
    ...(model.input !== null
      ? { inputText: model.input.includes("text"), inputImage: model.input.includes("image") }
      : {}),
    ...(model.reasoning !== null ? { reasoning: model.reasoning } : {}),
  };
}
