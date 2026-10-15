// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a provider, as a plan: what ticking and unticking amounts to.
 *
 * The list speaks of ACCESS, not of deleting models: a model exists at its provider, and the
 * organization gives or withdraws its access. Ticked is access, unticked is none. A model with
 * no `org_models` row yet gets one (`add`); a row switched off and ticked again is switched back
 * on with its settings intact (`grant`); a row left unticked is switched off, never deleted
 * (`withdraw`). The starred model becomes the organization's default. The plan is the diff; the
 * hook that applies it makes the writes.
 */

import type { OrgModelInfo } from "../hooks/use-models";
import type { ModelPickRow } from "./model-source";

export interface ModelChoicePlan {
  /** Ticked rows the organization has no model for yet. */
  add: ModelPickRow[];
  /** Models the organization has switched off, now ticked: access comes back, settings intact. */
  grant: OrgModelInfo[];
  /** Models the organization can use, now unticked: access is withdrawn, settings are kept. */
  withdraw: OrgModelInfo[];
  /** The upstream id to make the organization's default; `null` leaves the default as it is. */
  defaultModelId: string | null;
}

export function planModelChoice(input: {
  /** The rows ticked (kept whole: a pick filtered out by the search still ships). */
  picked: ReadonlyMap<string, ModelPickRow>;
  /** The models this provider already has a row for, accessible or not. */
  existing: readonly OrgModelInfo[];
  /** The upstream id starred as default, if any. */
  starred: string | null;
}): ModelChoicePlan {
  const { picked, existing, starred } = input;
  const have = new Set(existing.map((m) => m.modelId));
  const currentDefault = existing.find((m) => m.is_default)?.modelId ?? null;
  return {
    add: [...picked.values()].filter((row) => !have.has(row.id)),
    grant: existing.filter((m) => m.modelId !== null && !m.enabled && picked.has(m.modelId)),
    withdraw: existing.filter((m) => m.modelId !== null && m.enabled && !picked.has(m.modelId)),
    defaultModelId:
      starred !== null && picked.has(starred) && starred !== currentDefault ? starred : null,
  };
}
