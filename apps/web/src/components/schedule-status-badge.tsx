// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { CheckCircle2, Pause } from "lucide-react";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { useScheduleDisabledReason } from "../hooks/use-schedule-disabled-reason";

interface ScheduleStatusBadgeProps {
  schedule: Pick<ScheduleWireDto, "enabled" | "disabled_reason">;
}

export function ScheduleStatusBadge({ schedule }: ScheduleStatusBadgeProps) {
  const { t } = useTranslation(["agents"]);
  const disabledReason = useScheduleDisabledReason(schedule.disabled_reason);

  if (!schedule.enabled) {
    return (
      <DisabledReasonTooltip reason={disabledReason}>
        <UIBadge variant="secondary" className="gap-1">
          <Pause className="size-3" />
          {t("schedule.statusDisabled")}
        </UIBadge>
      </DisabledReasonTooltip>
    );
  }

  return (
    <UIBadge variant="success" className="gap-1">
      <CheckCircle2 className="size-3" />
      {t("schedule.statusActive")}
    </UIBadge>
  );
}
