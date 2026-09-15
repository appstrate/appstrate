// SPDX-License-Identifier: Apache-2.0

/**
 * What the model form submits: one typed-in model, or the rows a pick list had
 * checked, plus the inline credential to create first when the user typed a
 * key instead of picking one. Pure and DOM-free; the credential it names is
 * always a registry `providerId`.
 */

import type { ModelCost } from "@appstrate/core/module";
import type { ProviderRegistryEntry } from "../hooks/use-model-provider-credentials";
import type { ModelPickRow } from "./model-source";
import { catalogValues, sameSet, type CatalogModelValues } from "./row-overrides-catalog";

/** The model form's controlled field values. */
export interface ModelFormFields {
  label: string;
  apiShape: string;
  baseUrl: string;
  modelId: string;
  credentialId: string;
  inlineApiKey: string;
  /** Off, the four fields below are neither on screen nor on the wire. */
  capabilitiesExplicit: boolean;
  inputText: boolean;
  inputImage: boolean;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

/**
 * Catalog-derivable overrides. Sent only when the operator answered for them,
 * so the server keeps resolving the rest from the vendored catalog.
 */
interface ModelCapabilityOverrides {
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** One `POST /api/models` body, minus the credential every entry shares. */
export interface ModelFormModelEntry extends ModelCapabilityOverrides {
  /** Sent only when typed; the server derives and dedupes one otherwise. */
  label?: string;
  modelId: string;
  cost?: ModelCost;
}

/** The credential the model(s) run on: an existing one, or one to create first. */
interface ModelFormCredentialBinding {
  credentialId: string;
  newCredential?: { apiKey: string; providerId: string; baseUrlOverride?: string };
}

/**
 * One model, ready to submit. The four overrides widen to `null`: `PUT` reads
 * `null` as "drop the stored override", `POST` refuses it and goes through
 * {@link toCreateModelBody}.
 */
export type ModelFormData = ModelFormCredentialBinding &
  Omit<ModelFormModelEntry, keyof ModelCapabilityOverrides> & {
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
  };

/** The `POST /api/models` body, bound to the credential an inline key just created. */
export function toCreateModelBody(
  data: ModelFormData,
  credentialId: string,
): ModelFormModelEntry & { credentialId: string } {
  const { newCredential: _, input, contextWindow, maxTokens, reasoning, ...rest } = data;
  return {
    ...rest,
    credentialId,
    ...(input ? { input } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(reasoning != null ? { reasoning } : {}),
  };
}

/** Several models against ONE credential — one `POST /api/models` per entry. */
export interface ModelFormMultiData extends ModelFormCredentialBinding {
  models: ModelFormModelEntry[];
}

export type ModelFormSubmission = ModelFormData | ModelFormMultiData;

/** The ids a batch could not create, and the credential it created for a retry to bind to. */
export interface ModelFormSubmitOutcome {
  failedModelIds: string[];
  /**
   * The subset of `failedModelIds` the server refused as `model_already_added`
   * — this organization already has a row for that (credential, model) pair.
   * Named apart because it is not a failure to retry: the model is there.
   */
  duplicateModelIds: string[];
  credentialId?: string;
}

export type ModelFormSubmit = (data: ModelFormSubmission) => Promise<ModelFormSubmitOutcome>;

export type ModelFormProvider = Pick<
  ProviderRegistryEntry,
  "providerId" | "authMode" | "baseUrlOverridable"
>;

export interface ModelFormPayloadInput {
  fields: ModelFormFields;
  /** RHF `dirtyFields` — the row's name ships only when the operator typed one. */
  dirtyFields: { [K in keyof ModelFormFields]?: boolean };
  /**
   * `explicit`: every value that is the operator's own ships, an unticked box
   * included; a blank field, or one still equal to `catalogEntry`, is not.
   * `auto`: nothing on a create; every field as `null` on an edit.
   */
  capabilities: "explicit" | "auto";
  isEdit: boolean;
  /**
   * The catalog's own values for the submitted id. An edit form opens on them,
   * so a field still equal to them is not an answer: shipping it would freeze it
   * as an override and cut the row off from the catalog refresh.
   */
  catalogEntry?: CatalogModelValues;
  provider: ModelFormProvider | undefined;
  /**
   * The credential the form could match against the picked provider, or
   * `null`. `fields.credentialId` alone survives a provider switch.
   */
  selectedCredentialId: string | null;
}

type CredentialFailure = { ok: false; field: "credentialId"; messageKey: string };

type ModelFormPayloadResult = { ok: true; data: ModelFormData } | CredentialFailure;

/** The credential half of any create: an existing selection, or the inline key to create first. */
function resolveCredentialBinding(input: {
  provider: ModelFormProvider | undefined;
  selectedCredentialId: string | null;
  inlineApiKey: string;
  baseUrl: string;
}): { ok: true; binding: ModelFormCredentialBinding } | CredentialFailure {
  const { provider, baseUrl } = input;
  const isOauthProvider = provider?.authMode === "oauth2";
  const inlineApiKey = input.inlineApiKey.trim();
  const credentialId = input.selectedCredentialId ?? "";

  // OAuth credentials exist before the model is saved (pairing dialog).
  const newCredentialProvider =
    !isOauthProvider && !credentialId && inlineApiKey ? provider : undefined;

  if (isOauthProvider && !credentialId) {
    return { ok: false, field: "credentialId", messageKey: "models.form.connectionRequired" };
  }
  if (!newCredentialProvider) {
    if (!credentialId) {
      return { ok: false, field: "credentialId", messageKey: "models.form.apiKeyRequired" };
    }
    return { ok: true, binding: { credentialId } };
  }
  return {
    ok: true,
    binding: {
      credentialId: "",
      newCredential: {
        apiKey: inlineApiKey,
        providerId: newCredentialProvider.providerId,
        ...(newCredentialProvider.baseUrlOverridable && baseUrl.trim()
          ? { baseUrlOverride: baseUrl.trim() }
          : {}),
      },
    },
  };
}

function capabilityOverrides(
  input: Pick<ModelFormPayloadInput, "fields" | "capabilities" | "isEdit" | "catalogEntry">,
): Pick<ModelFormData, "input" | "contextWindow" | "maxTokens" | "reasoning"> {
  const { fields } = input;
  if (input.capabilities === "auto") {
    if (!input.isEdit) return {};
    return { input: null, contextWindow: null, maxTokens: null, reasoning: null };
  }
  const catalog = input.catalogEntry ? catalogValues(input.catalogEntry) : null;
  const modalities = [fields.inputText && "text", fields.inputImage && "image"].filter(
    Boolean,
  ) as string[];
  const contextWindow = parseInt(fields.contextWindow.trim(), 10);
  const maxTokens = parseInt(fields.maxTokens.trim(), 10);
  // A blank limit, no box ticked (the server refuses an empty array), or a
  // value still equal to the catalog's: omitted on a create, `null` on an edit.
  const answered: Pick<ModelFormData, "input" | "contextWindow" | "maxTokens" | "reasoning"> = {};
  if (modalities.length > 0 && !(catalog && sameSet(modalities, catalog.input))) {
    answered.input = modalities;
  } else if (input.isEdit) answered.input = null;
  if (contextWindow > 0 && contextWindow !== catalog?.contextWindow) {
    answered.contextWindow = contextWindow;
  } else if (input.isEdit) answered.contextWindow = null;
  if (maxTokens > 0 && maxTokens !== catalog?.maxTokens) answered.maxTokens = maxTokens;
  else if (input.isEdit) answered.maxTokens = null;
  // A boolean has no blank state: an unticked box IS the answer `false`.
  if (!catalog || fields.reasoning !== catalog.reasoning) answered.reasoning = fields.reasoning;
  else if (input.isEdit) answered.reasoning = null;
  return answered;
}

export function buildModelFormPayload(input: ModelFormPayloadInput): ModelFormPayloadResult {
  const { fields, dirtyFields } = input;
  const credential = resolveCredentialBinding({
    provider: input.provider,
    selectedCredentialId: input.selectedCredentialId,
    inlineApiKey: fields.inlineApiKey,
    baseUrl: fields.baseUrl,
  });
  if (!credential.ok) return credential;

  return {
    ok: true,
    data: {
      ...(dirtyFields.label === true && fields.label.trim() ? { label: fields.label.trim() } : {}),
      modelId: fields.modelId.trim(),
      ...credential.binding,
      ...capabilityOverrides(input),
    },
  };
}

/** The values a row carries, as explicit overrides. An empty modality list is dropped: the server refuses it. */
function describedCapabilities(
  row: ModelPickRow["endpointCapabilities"],
): ModelCapabilityOverrides {
  return {
    ...(row.input?.length ? { input: row.input } : {}),
    ...(row.contextWindow != null ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxTokens != null ? { maxTokens: row.maxTokens } : {}),
    ...(row.reasoning != null ? { reasoning: row.reasoning } : {}),
  };
}

/**
 * Search includes the billing rate; catalog rows resolve at read time.
 * Discovery pins only endpoint capabilities, never catalog display hints.
 */
function rowToEntry(row: ModelPickRow): ModelFormModelEntry {
  if (row.origin === "search") {
    return {
      ...(row.label ? { label: row.label } : {}),
      modelId: row.id,
      ...describedCapabilities(row),
      ...(row.cost ? { cost: row.cost } : {}),
    };
  }
  return {
    modelId: row.id,
    ...(row.origin === "discover" ? describedCapabilities(row.endpointCapabilities) : {}),
  };
}

export function buildModelsBatchPayload(input: {
  rows: readonly ModelPickRow[];
  provider: ModelFormProvider | undefined;
  selectedCredentialId: string | null;
  inlineApiKey: string;
  baseUrl: string;
}):
  | { ok: true; data: ModelFormMultiData }
  | { ok: false; field: "credentialId" | "modelId"; messageKey: string } {
  if (input.rows.length === 0) {
    return { ok: false, field: "modelId", messageKey: "models.form.selectionRequired" };
  }
  const credential = resolveCredentialBinding(input);
  if (!credential.ok) return credential;
  return { ok: true, data: { ...credential.binding, models: input.rows.map(rowToEntry) } };
}
