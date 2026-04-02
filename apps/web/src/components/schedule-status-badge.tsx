// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge as UIBadge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Pause } from "lucide-react";

interface ScheduleStatusBadgeProps {
  enabled: boolean;
  hasProviders: boolean;
  allReady: boolean;
}

export function ScheduleStatusBadge({ enabled, hasProviders, allReady }: ScheduleStatusBadgeProps) {
  const { t } = useTranslation(["agents"]);

  if (!enabled) {
    return (
      <UIBadge variant="secondary" className="gap-1">
        <Pause className="size-3" />
        {t("schedule.statusDisabled")}
      </UIBadge>
    );
  }

  if (hasProviders && !allReady) {
    return (
      <UIBadge variant="warning" className="gap-1">
        <AlertTriangle className="size-3" />
        {t("schedule.statusIncomplete")}
      </UIBadge>
    );
  }

  return (
    <UIBadge variant="success" className="gap-1">
      <CheckCircle2 className="size-3" />
      {t("schedule.statusActive")}
    </UIBadge>
  );
}
