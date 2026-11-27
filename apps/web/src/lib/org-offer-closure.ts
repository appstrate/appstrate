// SPDX-License-Identifier: Apache-2.0

/**
 * What offering an agent to the organization leaves behind: the integrations it declares that
 * the organization does not offer, so a personal space cannot switch them on. The offer's
 * answer names them (`warnings[]`); offering them too is a decision of its own, one offer each,
 * in the mode of the agent's.
 */

import type { OrgOfferMode } from "../hooks/use-library";

/** The part of an `ActivationWarning` the dialog reads. */
export interface OfferWarning {
  field: string;
  required: boolean;
}

export interface OfferClosureEntry {
  id: string;
  name: string;
  required: boolean;
}

const FIELD_PREFIX = "integrations.";

/** The integrations a warning list names, with the library's display name when the caller can see the package, else the id. */
export function offerClosureEntries(
  warnings: readonly OfferWarning[],
  integrations: readonly { id: string; name: string }[],
): OfferClosureEntry[] {
  return warnings.map((warning) => {
    const id = warning.field.startsWith(FIELD_PREFIX)
      ? warning.field.slice(FIELD_PREFIX.length)
      : warning.field;
    const row = integrations.find((candidate) => candidate.id === id);
    return { id, name: row?.name || id, required: warning.required };
  });
}

/** One `PUT …/org-offer` per integration, in the agent's mode. */
export function offerClosureRequests(
  entries: readonly OfferClosureEntry[],
  mode: OrgOfferMode,
): { packageId: string; mode: OrgOfferMode }[] {
  return entries.map((entry) => ({ packageId: entry.id, mode }));
}
