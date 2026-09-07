// SPDX-License-Identifier: Apache-2.0

/**
 * One discovered model → the `POST /api/models` body that adds it.
 *
 * A discovery runs against an operator-supplied endpoint, which has no vendored
 * catalog behind it: whatever the listing (or the catalog lookup the server
 * did) reported has to be written as an explicit override or nothing resolves
 * it on read. Whatever it did NOT report is left out — not filled with a
 * default — so a model nobody described stores no override at all, and its
 * row keeps reading as "auto" (catalog if the id is known, runtime defaults
 * otherwise) rather than as an answer the operator never gave.
 */

import type { DiscoveredModel } from "../hooks/use-model-provider-credentials";
import {
  resolveCredentialBinding,
  type ModelFormModelEntry,
  type ModelFormMultiData,
  type ModelFormProvider,
} from "./model-form-payload";

function discoveredModelToEntry(model: DiscoveredModel): ModelFormModelEntry {
  return {
    // The wire carries a name only when the listing had one, or the server
    // stops deriving one and dedupe never runs.
    ...(model.label ? { label: model.label } : {}),
    modelId: model.id,
    // An empty list describes no model at all and the server refuses it.
    ...(model.input?.length ? { input: model.input } : {}),
    ...(model.context_window !== null ? { contextWindow: model.context_window } : {}),
    ...(model.max_tokens !== null ? { maxTokens: model.max_tokens } : {}),
    ...(model.reasoning !== null ? { reasoning: model.reasoning } : {}),
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
