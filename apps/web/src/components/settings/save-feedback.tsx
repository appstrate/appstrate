// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

/**
 * What a self-saving setting says about its write: Enregistrement… / Enregistré /
 * Erreur d'enregistrement. The one return of a write in the product: the control
 * is the setting, this line sits with it (a `SettingRow`'s `status`, or the foot
 * of a section whose controls share one write). A failure is toasted too, the
 * field keeps what was typed. The line keeps its height so the page never jumps.
 */
export function SaveFeedback({
  pending,
  success,
  error,
}: {
  pending: boolean;
  success: boolean;
  error: boolean;
}) {
  const { t } = useTranslation("common");
  return (
    <p className="text-muted-foreground min-h-5 text-xs" aria-live="polite">
      {pending
        ? t("saveFeedback.saving")
        : error
          ? t("saveFeedback.error")
          : success
            ? t("saveFeedback.saved")
            : ""}
    </p>
  );
}
