// SPDX-License-Identifier: Apache-2.0

/**
 * The State column of the providers tables: one cell that gathers what is worth saying about a
 * row, and nothing when all is well. `rowStates` (`lib/model-providers.ts`) decides what
 * applies; this draws it.
 */

import { ToneBadge } from "@/components/app-ui/status-variants";
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
          <ToneBadge key={state} variant="failed" title={unavailableHint}>
            {t("models.credentialUnavailable")}
          </ToneBadge>
        ) : state === "default" ? (
          <ToneBadge key={state} variant="success">
            {t("models.default")}
          </ToneBadge>
        ) : state === "disabled" ? (
          <ToneBadge key={state} variant="pending">
            {t("providers.state.disabled")}
          </ToneBadge>
        ) : (
          <ToneBadge key={state} variant="pending">
            {t("providers.state.noKey")}
          </ToneBadge>
        ),
      )}
    </div>
  );
}
