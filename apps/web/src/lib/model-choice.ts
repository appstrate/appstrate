// SPDX-License-Identifier: Apache-2.0

/**
 * « Choose the models » of a provider, as a plan: what ticking and unticking amounts to.
 *
 * A model the provider makes available is an `org_models` row. Ticked and not yet a row is
 * created, a row left unticked is deleted, and the starred model becomes the organization's
 * default. The plan is the diff; the hook that applies it makes the writes.
 */

import type { OrgModelInfo } from "../hooks/use-models";
import type { ModelPickRow } from "./model-source";

export interface ModelChoicePlan {
  /** Ticked rows the organization has no model for yet. */
  add: ModelPickRow[];
  /** Models the organization has, now unticked. */
  remove: OrgModelInfo[];
  /** The upstream id to make the organization's default; `null` leaves the default as it is. */
  defaultModelId: string | null;
}

export function planModelChoice(input: {
  /** The rows ticked (kept whole: a pick filtered out by the search still ships). */
  picked: ReadonlyMap<string, ModelPickRow>;
  /** The models this provider already makes available. */
  existing: readonly OrgModelInfo[];
  /** The upstream id starred as default, if any. */
  starred: string | null;
}): ModelChoicePlan {
  const { picked, existing, starred } = input;
  const have = new Set(existing.map((m) => m.modelId));
  const currentDefault = existing.find((m) => m.is_default)?.modelId ?? null;
  return {
    add: [...picked.values()].filter((row) => !have.has(row.id)),
    remove: existing.filter((m) => m.modelId !== null && !picked.has(m.modelId)),
    defaultModelId:
      starred !== null && picked.has(starred) && starred !== currentDefault ? starred : null,
  };
}
