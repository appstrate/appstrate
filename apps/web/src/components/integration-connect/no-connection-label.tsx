// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

/** "No connection" — the explicit choice of none (`[]`) — and what it means for a run. */
export function NoConnectionLabel({ hint }: { hint?: string }) {
  const { t } = useTranslation(["agents"]);
  return (
    <span className="flex min-w-0 flex-col">
      <span>{t("detail.integrationMemberPicker.none")}</span>
      <span className="text-muted-foreground text-[0.65rem]">
        {hint ?? t("detail.integrationMemberPicker.noneHint")}
      </span>
    </span>
  );
}
