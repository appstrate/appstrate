// SPDX-License-Identifier: Apache-2.0

/**
 * The State column of the providers tables: one cell that gathers what is worth saying about a
 * row, and nothing when all is well. `rowStates` (`lib/model-providers.ts`) decides what
 * applies; this draws it.
 */

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";
import type { RowState } from "../lib/model-providers";

export function RowStateCell({
  states,
  unavailableHint,
}: {
  states: readonly RowState[];
  /** Why a key is unavailable, when the person can do something about it. */
  unavailableHint?: string;
}) {
  const { t } = useTranslation("settings");
  if (states.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {states.map((state) =>
        state === "unavailable" ? (
          <Badge key={state} variant="failed" title={unavailableHint}>
            {t("models.credentialUnavailable")}
          </Badge>
        ) : state === "default" ? (
          <Badge key={state} variant="success">
            {t("models.default")}
          </Badge>
        ) : state === "disabled" ? (
          <Badge key={state} variant="pending">
            {t("providers.state.disabled")}
          </Badge>
        ) : (
          <Badge key={state} variant="pending">
            {t("providers.state.noKey")}
          </Badge>
        ),
      )}
    </div>
  );
}
