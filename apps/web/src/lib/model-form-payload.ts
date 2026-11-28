// SPDX-License-Identifier: Apache-2.0

/** What the model form (an edit) and the model list (an id typed by hand) submit. Pure. */

import type { ModelCost, ModelInputModality } from "@appstrate/core/module";
import type { ModelPickRow } from "./model-source";
import { catalogValues, type CatalogModelValues } from "./row-overrides-catalog";
import { sameSet } from "./strings";

interface CapabilityFields {
  /** Off, the four fields below are neither on screen nor on the wire. */
  capabilitiesExplicit: boolean;
  inputText: boolean;
  inputImage: boolean;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

/** What the list asks of a model id typed by hand, and the model form's controlled values: its name and, if wanted, its own capabilities. */
export interface ManualRowFields extends CapabilityFields {
  label: string;
  modelId: string;
}

/**
 * Catalog-derivable overrides. Sent only when the operator answered for them,
 * so the server keeps resolving the rest from the model catalog (Pi's registry).
 */
interface ModelCapabilityOverrides {
  input?: ModelInputModality[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/** One `add` entry of a model choice. */
export interface ModelFormModelEntry extends ModelCapabilityOverrides {
  /** Sent only when typed; the server derives and dedupes one otherwise. */
  label?: string;
  modelId: string;
  cost?: ModelCost;
}

/**
 * One `PATCH /api/models/{id}` body: the model stays in its configuration, whose connections serve
 * it. Overrides widen to `null`: "drop the stored override".
 */
export interface ModelFormData {
  /** Sent only when typed; `PATCH` reads an absent name as "keep it". */
  label?: string;
  modelId: string;
  input?: ModelInputModality[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
}

export interface ModelFormPayloadInput {
  fields: ManualRowFields;
  /** RHF `dirtyFields` — the row's name ships only when the operator typed one. */
  dirtyFields: { [K in keyof ManualRowFields]?: boolean };
  /** `explicit`: the operator's own values ship (an unticked box included; blank or still-catalog fields do not). `auto`: every field `null`. */
  capabilities: "explicit" | "auto";
  /** The catalog's values for the id; a field still equal to them is not an answer (shipping it would freeze it as an override, cutting off catalog updates). */
  catalogEntry?: CatalogModelValues;
}

/** What refuses the model id before anything is sent: a namespaced i18n key, `null` when none. */
export function modelFormRefusals(input: {
  modelId: string;
  /** The ids a catalog provider binds (the server refuses any other); `null` = free-form. */
  offeredIds: readonly string[] | null;
}): { modelId: string | null } {
  const id = input.modelId.trim();
  if (!id) return { modelId: "common:validation.required" };
  const outsideOffer = input.offeredIds !== null && !input.offeredIds.includes(id);
  return { modelId: outsideOffer ? "settings:models.form.modelNotOffered" : null };
}

function capabilityOverrides(input: {
  fields: CapabilityFields;
  capabilities: "explicit" | "auto";
  /** An edit clears what the operator no longer answers (`null`); a create just omits it. */
  isEdit: boolean;
  catalogEntry?: CatalogModelValues;
}): Pick<ModelFormData, "input" | "contextWindow" | "maxTokens" | "reasoning"> {
  const { fields } = input;
  if (input.capabilities === "auto") {
    if (!input.isEdit) return {};
    return { input: null, contextWindow: null, maxTokens: null, reasoning: null };
  }
  const catalog = input.catalogEntry ? catalogValues(input.catalogEntry) : null;
  const modalities: ModelInputModality[] = [
    ...(fields.inputText ? (["text"] as const) : []),
    ...(fields.inputImage ? (["image"] as const) : []),
  ];
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

export function buildModelFormPayload(input: ModelFormPayloadInput): ModelFormData {
  const { fields, dirtyFields } = input;
  return {
    ...(dirtyFields.label === true && fields.label.trim() ? { label: fields.label.trim() } : {}),
    modelId: fields.modelId.trim(),
    ...capabilityOverrides({ ...input, isEdit: true }),
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

/** An id typed by hand, as a row of the pick list; the capabilities are the operator's own answers. */
export function manualRow(fields: ManualRowFields): ModelPickRow {
  const answered = capabilityOverrides({
    fields,
    capabilities: fields.capabilitiesExplicit ? "explicit" : "auto",
    isEdit: false,
  });
  return {
    id: fields.modelId.trim(),
    label: fields.label.trim() || null,
    contextWindow: answered.contextWindow ?? null,
    maxTokens: answered.maxTokens ?? null,
    input: answered.input ?? null,
    reasoning: answered.reasoning ?? null,
    source: null,
    endpointCapabilities: {},
    cost: null,
    origin: "manual",
    featured: false,
  };
}

/**
 * Search includes the billing rate, a typed id its own answers; catalog rows resolve at read time.
 * Discovery pins only endpoint capabilities, never catalog display hints.
 */
export function rowToEntry(row: ModelPickRow): ModelFormModelEntry {
  if (row.origin === "search" || row.origin === "manual") {
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
