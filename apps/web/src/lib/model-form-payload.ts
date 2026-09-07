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
  /**
   * "I answer for the limits and modalities myself." Off, the four fields
   * below are not on screen and not on the wire — the server resolves them
   * from the catalog and the runtime falls back to fixed defaults.
   */
  capabilitiesExplicit: boolean;
  inputText: boolean;
  inputImage: boolean;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

/**
 * Catalog-derivable overrides, in the shape a create takes. Sent only when the
 * operator answered for them (the capabilities toggle, or an OpenRouter
 * import) — otherwise the server keeps resolving them from the vendored
 * catalog and the weekly `refresh-pricing-catalog.ts` bump still reaches
 * existing rows.
 */
interface ModelCapabilityOverrides {
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** One `POST /api/models` body, minus the credential every entry shares. */
export interface ModelFormModelEntry extends ModelCapabilityOverrides {
  /**
   * Optional — server derives from the catalog label (`<catalog>.label`)
   * and dedupes against existing org rows when absent. Sent only when the
   * user explicitly customized it.
   */
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
 * One model, ready to submit. The four capability overrides widen to `null`
 * here: `PATCH /api/models/{id}` reads `null` as "drop the stored override and
 * resolve from the catalog again", which is how the form clears one. `POST`
 * has nothing to clear and refuses `null`, so a create body goes through
 * {@link toCreateModelBody}.
 */
export type ModelFormData = ModelFormCredentialBinding &
  Omit<ModelFormModelEntry, keyof ModelCapabilityOverrides> & {
    input?: string[] | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    reasoning?: boolean | null;
  };

/**
 * A submission → the `POST /api/models` body that creates it. The builder only
 * emits `null` capabilities when editing, so dropping them here is a type
 * narrowing rather than a behaviour change. The credential id is passed in
 * because an inline key is created first and only then has one.
 */
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

/** What the model form hands its host: one model, or a batch of them. */
export type ModelFormSubmission = ModelFormData | ModelFormMultiData;

/**
 * What a batch reports back once every create has been attempted: the ids that
 * failed — so the form can re-offer exactly those — and the credential it
 * created, which a retry binds to instead of creating a second one.
 */
export interface ModelFormSubmitOutcome {
  failedModelIds: string[];
  credentialId?: string;
}

export type ModelFormSubmit = (
  data: ModelFormSubmission,
) => void | Promise<ModelFormSubmitOutcome | void>;

/** The registry facts the payload turns on — a `ProviderRegistryEntry` fits. */
export interface ModelFormProvider {
  providerId: string;
  authMode: "api_key" | "oauth2";
  baseUrlOverridable: boolean;
}

export interface ModelFormPayloadInput {
  fields: ModelFormFields;
  /** RHF `dirtyFields` — the row's name ships only when the operator typed one. */
  dirtyFields: { [K in keyof ModelFormFields]?: boolean };
  /**
   * What the capabilities section answered, or that it never rendered:
   * - `explicit` — the operator ticked the toggle (or an OpenRouter import
   *   filled the fields): all four values ship, an unticked box included.
   * - `auto` — the section was offered and left off. Nothing to send on a
   *   create; on an edit every field ships as `null`, so a previously stored
   *   override is dropped and the catalog resolves it again.
   * - `hidden` — the section never rendered (catalogued preset), so there is
   *   nothing the operator declined and nothing of theirs to clear.
   */
  capabilities: "explicit" | "auto" | "hidden";
  /** Editing an existing row. Only `auto` reads it — clear vs. omit. */
  isEdit: boolean;
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

type CredentialFailure = { ok: false; field: "credentialId"; messageKey: string };

type ModelFormPayloadResult = { ok: true; data: ModelFormData } | CredentialFailure;

/**
 * The credential half of any model create, shared by the single-model form and
 * the multi-add path: an existing selection, or the inline key to create first.
 */
export function resolveCredentialBinding(input: {
  provider: ModelFormProvider | undefined;
  selectedCredentialId: string | null;
  inlineApiKey: string;
  baseUrl: string;
}): { ok: true; binding: ModelFormCredentialBinding } | CredentialFailure {
  const { provider, baseUrl } = input;
  const isOauthProvider = provider?.authMode === "oauth2";
  const inlineApiKey = input.inlineApiKey.trim();
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
  if (!newCredentialProvider) {
    if (!credentialId) {
      return { ok: false, field: "credentialId", messageKey: "models.form.apiKeyRequired" };
    }
    return { ok: true, binding: { credentialId } };
  }
  // Posted to /api/model-provider-credentials before the model itself.
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

/** The capability half of the body — see `ModelFormPayloadInput.capabilities`. */
function capabilityOverrides(
  input: Pick<ModelFormPayloadInput, "fields" | "capabilities" | "isEdit">,
): Pick<ModelFormData, "input" | "contextWindow" | "maxTokens" | "reasoning"> {
  const { fields } = input;
  if (input.capabilities === "hidden") return {};
  if (input.capabilities === "auto") {
    if (!input.isEdit) return {};
    return { input: null, contextWindow: null, maxTokens: null, reasoning: null };
  }
  const modalities = [fields.inputText && "text", fields.inputImage && "image"].filter(
    Boolean,
  ) as string[];
  const contextWindow = parseInt(fields.contextWindow.trim(), 10);
  const maxTokens = parseInt(fields.maxTokens.trim(), 10);
  // A blank limit, or neither box ticked (the server refuses an empty array),
  // is a question left to the catalog and the runtime default: omitted on a
  // create, and on an edit sent as `null` so a stored override is dropped
  // rather than silently kept behind the blank the operator just made.
  const answered: Pick<ModelFormData, "input" | "contextWindow" | "maxTokens"> = {};
  if (modalities.length > 0) answered.input = modalities;
  else if (input.isEdit) answered.input = null;
  if (contextWindow > 0) answered.contextWindow = contextWindow;
  else if (input.isEdit) answered.contextWindow = null;
  if (maxTokens > 0) answered.maxTokens = maxTokens;
  else if (input.isEdit) answered.maxTokens = null;
  return {
    ...answered,
    // Booleans have no blank state, so an unticked box IS the answer `false`.
    reasoning: fields.reasoning,
  };
}

export function buildModelFormPayload(input: ModelFormPayloadInput): ModelFormPayloadResult {
  const { fields, dirtyFields, importedCost } = input;
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
      // Preset-derived values are written without `shouldDirty`, so only what
      // the user edited (or OpenRouter live-search imported) is flagged here.
      ...(dirtyFields.label === true && fields.label.trim() ? { label: fields.label.trim() } : {}),
      modelId: fields.modelId.trim(),
      ...credential.binding,
      ...capabilityOverrides(input),
      ...(importedCost ? { cost: importedCost } : {}),
    },
  };
}
