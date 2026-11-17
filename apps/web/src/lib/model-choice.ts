// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a provider, as a plan (the diff; the hook applies it).
 * The list speaks of ACCESS: a row switched off and ticked again is switched back
 * on with its settings intact (`grant`), an unticked one is switched off, never
 * deleted (`withdraw`).
 */

import type { OrgModelInfo } from "../hooks/use-models";
import type { ModelPickRow } from "./model-source";

export interface ModelChoicePlan {
  /** Ticked rows the organization has no model for yet. */
  add: ModelPickRow[];
  /** Switched off, now ticked: access comes back, settings intact. */
  grant: OrgModelInfo[];
  /** Usable, now unticked: access withdrawn, settings kept. */
  withdraw: OrgModelInfo[];
  /** The upstream id to make the default; `null` leaves it as is. */
  defaultModelId: string | null;
}

export function planModelChoice(input: {
  /** The rows ticked (kept whole: a pick filtered out by the search still ships). */
  picked: ReadonlyMap<string, ModelPickRow>;
  /** The models this provider already has a row for, accessible or not. */
  existing: readonly OrgModelInfo[];
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
