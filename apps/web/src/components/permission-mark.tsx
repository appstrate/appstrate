// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check, Minus } from "lucide-react";

/** A matrix cell: granted or not, with the answer spelled out for screen readers. */
export function PermissionMark({ granted }: { granted: boolean }) {
  const { t } = useTranslation("settings");
  return (
    <span className="inline-flex justify-center">
      {granted ? (
        <Check className="text-foreground size-4" aria-hidden />
      ) : (
        <Minus className="text-muted-foreground/40 size-4" aria-hidden />
      )}
      <span className="sr-only">
        {t(granted ? "roles.matrixGranted" : "roles.matrixNotGranted")}
      </span>
    </span>
  );
}
