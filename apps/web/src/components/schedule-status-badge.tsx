// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { CheckCircle2, Pause } from "lucide-react";

interface ScheduleStatusBadgeProps {
  enabled: boolean;
}

export function ScheduleStatusBadge({ enabled }: ScheduleStatusBadgeProps) {
  const { t } = useTranslation(["agents"]);

  if (!enabled) {
    return (
      <UIBadge variant="secondary" className="gap-1">
        <Pause className="size-3" />
        {t("schedule.statusDisabled")}
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
