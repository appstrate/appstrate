// SPDX-License-Identifier: Apache-2.0

/**
 * What offering an agent to the organization leaves behind: the integrations it declares that
 * the organization does not offer, so a personal space cannot switch them on. The offer's
 * answer names them (`warnings[]`); offering them too is a decision of its own, one offer each,
 * in the mode of the agent's.
 */

import type { components } from "../api/schema";
import { integrationIdOfField } from "./connection-choice";

/** The part of an `ActivationWarning` the dialog reads. */
export type OfferWarning = Pick<components["schemas"]["ActivationWarning"], "field" | "required">;

export interface OfferClosureEntry {
  id: string;
  name: string;
  required: boolean;
}

/** The integrations a warning list names, with the library's display name when the caller can see the package, else the id. */
export function offerClosureEntries(
  warnings: readonly OfferWarning[],
  integrations: readonly { id: string; name: string }[],
): OfferClosureEntry[] {
  return warnings.map((warning) => {
    const id = integrationIdOfField(warning.field);
    const row = integrations.find((candidate) => candidate.id === id);
    return { id, name: row?.name || id, required: warning.required };
  });
}
