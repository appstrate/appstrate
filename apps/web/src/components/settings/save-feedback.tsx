// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Spinner } from "@appstrate/ui/components/spinner";

/** Saving / saved / error line of a self-saving setting. Keeps its height so the page never jumps. */
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
