// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "@appstrate/ui/components/spinner";

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
    <p
      className={cn(
        "flex min-h-5 items-center gap-1 text-xs",
        error ? "text-destructive" : !pending && success ? "text-success" : "text-muted-foreground",
      )}
      aria-live="polite"
    >
      {pending ? (
        <>
          <Spinner className="size-3.5" />
          {t("saveFeedback.saving")}
        </>
      ) : error ? (
        t("saveFeedback.error")
      ) : success ? (
        <>
          <Check className="size-3.5" aria-hidden />
          {t("saveFeedback.saved")}
        </>
      ) : null}
    </p>
  );
}
