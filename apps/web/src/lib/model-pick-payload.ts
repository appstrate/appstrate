// SPDX-License-Identifier: Apache-2.0

/**
 * The models a pick list had checked → what adding them all puts on the wire.
 *
 * How much of a row ships is decided by the listing it came from, and by one
 * question: can the server resolve the value itself on read?
 *   - `catalog`  — only the id ships, and whatever the vendored catalog knows
 *     about that id answers for the rest, so the weekly catalog refresh keeps
 *     reaching the row. It may know nothing: a subscription serves ids no
 *     catalog describes (`idOnlyRow`), and such a row stores nothing and reads
 *     as "auto" — which is the same answer as not asking, one refresh later.
 *   - `discover` — no catalog stands behind an operator's own endpoint, so
 *     whatever the listing reported is written as an explicit override. What it
 *     did NOT report is left out rather than defaulted: a model nobody
 *     described stores nothing and keeps reading as "auto".
 *   - `search`   — no vendored catalog either, and the search is the billing
 *     rate, so everything ships, cost included.
 */

import type { ModelPickRow } from "./model-source";
import {
  resolveCredentialBinding,
  type ModelFormModelEntry,
  type ModelFormMultiData,
  type ModelFormProvider,
} from "./model-form-payload";

function rowToEntry(row: ModelPickRow): ModelFormModelEntry {
  if (row.origin === "catalog") return { modelId: row.id };
  return {
    // A name only where the listing had one, or the server stops deriving one
    // and the dedupe never runs.
    ...(row.label ? { label: row.label } : {}),
    modelId: row.id,
    // An empty list describes no model at all and the server refuses it.
    ...(row.input?.length ? { input: row.input } : {}),
    ...(row.contextWindow !== null ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxTokens !== null ? { maxTokens: row.maxTokens } : {}),
    ...(row.reasoning !== null ? { reasoning: row.reasoning } : {}),
    // Only a search row carries one, and only there is it the billing rate.
    ...(row.origin === "search" && row.cost ? { cost: row.cost } : {}),
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
