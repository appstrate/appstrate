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
import {
  resolveCredentialBinding,
  type ModelFormFields,
  type ModelFormModelEntry,
  type ModelFormMultiData,
  type ModelFormProvider,
} from "./model-form-payload";

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

/** One discovered model → the `POST /api/models` body that adds it. */
function discoveredModelToEntry(model: DiscoveredModel): ModelFormModelEntry {
  const fields = discoveredModelToFieldValues(model);
  const input = [fields.inputText && "text", fields.inputImage && "image"].filter(
    Boolean,
  ) as string[];
  const contextWindow = parseInt(fields.contextWindow, 10);
  const maxTokens = parseInt(fields.maxTokens, 10);
  return {
    // The field falls back to the id so the form always shows a name; the wire
    // must not, or the server stops deriving one and dedupe never runs.
    ...(model.label ? { label: model.label } : {}),
    modelId: fields.modelId,
    ...(input.length > 0 ? { input } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    reasoning: fields.reasoning,
  };
}

/**
 * The models a detection had checked → what adding them all puts on the wire:
 * one entry per model, against the single credential they share.
 */
export function buildDiscoveredModelsPayload(input: {
  models: readonly DiscoveredModel[];
  provider: ModelFormProvider | undefined;
  selectedCredentialId: string | null;
  inlineApiKey: string;
  baseUrl: string;
}):
  | { ok: true; data: ModelFormMultiData }
  | { ok: false; field: "credentialId" | "modelId"; messageKey: string } {
  if (input.models.length === 0) {
    return { ok: false, field: "modelId", messageKey: "models.form.selectionRequired" };
  }
  const credential = resolveCredentialBinding(input);
  if (!credential.ok) return credential;
  return {
    ok: true,
    data: { ...credential.binding, models: input.models.map(discoveredModelToEntry) },
  };
}
