// SPDX-License-Identifier: Apache-2.0

/**
 * What the model form submits: the model, plus the inline credential to create
 * first when the user typed a key instead of picking one. Pure and DOM-free —
 * the modal owns the fields and renders the error, this owns the wire payload,
 * and the credential it names is always a registry `providerId`.
 */

import type { ModelCost } from "@appstrate/core/module";

/** The model form's controlled field values. */
export interface ModelFormFields {
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  credentialId: string;
  inlineApiKey: string;
  inputText: boolean;
  inputImage: boolean;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

export interface ModelFormData {
  /**
   * Optional — server derives from the catalog label (`<catalog>.label`)
   * and dedupes against existing org rows when absent. Sent only when the
   * user explicitly customized it.
   */
  label?: string;
  modelId: string;
  credentialId: string;
  newCredential?: { apiKey: string; providerId: string; baseUrlOverride?: string };
  /**
   * Catalog-derivable overrides. Sent only when the user edited them after
   * picking a preset (RHF `dirtyFields`) — keeps existing rows in sync with
   * the weekly `refresh-pricing-catalog.ts` bump.
   */
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: ModelCost;
}

/** The registry facts the payload turns on — a `ProviderRegistryEntry` fits. */
export interface ModelFormProvider {
  providerId: string;
  authMode: "api_key" | "oauth2";
  baseUrlOverridable: boolean;
}

export interface ModelFormPayloadInput {
  fields: ModelFormFields;
  /** RHF `dirtyFields` — catalog-derivable values ship only when edited. */
  dirtyFields: { [K in keyof ModelFormFields]?: boolean };
  /** The picked registry entry; undefined until the user picks a provider. */
  provider: ModelFormProvider | undefined;
  /**
   * The credential the form could actually match against the picked provider,
   * or `null`. `fields.credentialId` alone is not a binding: it survives a
   * provider switch and would bind the model to the endpoint the operator left.
   */
  selectedCredentialId: string | null;
  /** OpenRouter live-search rates — the only cost the form submits. */
  importedCost: ModelCost | null;
}

type ModelFormPayloadResult =
  { ok: true; data: ModelFormData } | { ok: false; field: "credentialId"; messageKey: string };

export function buildModelFormPayload(input: ModelFormPayloadInput): ModelFormPayloadResult {
  const { fields, dirtyFields, provider, importedCost } = input;
  const isOauthProvider = provider?.authMode === "oauth2";
  const inlineApiKey = fields.inlineApiKey.trim();
  const credentialId = input.selectedCredentialId ?? "";

  // Inline api-key creation only applies to api_key providers — OAuth
  // credentials must exist before the model is saved (they're created via the
  // pairing dialog and auto-selected into `credentialId`).
  const newCredentialProvider =
    !isOauthProvider && !credentialId && inlineApiKey ? provider : undefined;

  // OAuth has no inline-key affordance, so an empty selection is a hard error.
  if (isOauthProvider && !credentialId) {
    return { ok: false, field: "credentialId", messageKey: "models.form.connectionRequired" };
  }
  if (!isOauthProvider && !credentialId && !newCredentialProvider) {
    return { ok: false, field: "credentialId", messageKey: "models.form.apiKeyRequired" };
  }

  const inputArr = [fields.inputText && "text", fields.inputImage && "image"].filter(
    Boolean,
  ) as string[];
  const cw = fields.contextWindow.trim() ? parseInt(fields.contextWindow.trim(), 10) : undefined;
  const mt = fields.maxTokens.trim() ? parseInt(fields.maxTokens.trim(), 10) : undefined;
  const inputDirty = dirtyFields.inputText === true || dirtyFields.inputImage === true;

  return {
    ok: true,
    data: {
      // Preset-derived values are written without `shouldDirty`, so only what
      // the user edited (or OpenRouter live-search imported) is flagged here.
      ...(dirtyFields.label === true && fields.label.trim() ? { label: fields.label.trim() } : {}),
      modelId: fields.modelId.trim(),
      credentialId: newCredentialProvider ? "" : credentialId,
      // Posted to /api/model-provider-credentials before the model itself.
      ...(newCredentialProvider
        ? {
            newCredential: {
              apiKey: inlineApiKey,
              providerId: newCredentialProvider.providerId,
              ...(newCredentialProvider.baseUrlOverridable && fields.baseUrl.trim()
                ? { baseUrlOverride: fields.baseUrl.trim() }
                : {}),
            },
          }
        : {}),
      ...(inputDirty && inputArr.length > 0 ? { input: inputArr } : {}),
      ...(dirtyFields.contextWindow === true && cw ? { contextWindow: cw } : {}),
      ...(dirtyFields.maxTokens === true && mt ? { maxTokens: mt } : {}),
      ...(dirtyFields.reasoning === true ? { reasoning: fields.reasoning } : {}),
      ...(importedCost ? { cost: importedCost } : {}),
    },
  };
}
