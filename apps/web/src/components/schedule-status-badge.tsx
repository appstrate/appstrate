// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { CheckCircle2, Pause } from "lucide-react";
import type { EnrichedSchedule, ScheduleWireDto } from "@appstrate/shared-types";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";
import { CountBadge } from "./count-badge";
import { RunStatusBadge } from "./status-badge";

interface ScheduleStatusBadgeProps {
  schedule: Pick<ScheduleWireDto, "enabled" | "disabled_reason">;
}

export function ScheduleStatusBadge({ schedule }: ScheduleStatusBadgeProps) {
  const { t } = useTranslation(["agents"]);

  if (!schedule.enabled) {
    return (
      <DisabledReasonTooltip
        reason={
          schedule.disabled_reason ? t(`schedule.disabledReason.${schedule.disabled_reason}`) : null
        }
      >
        <Badge variant="secondary" className="gap-1">
          <Pause className="size-3" />
          {t("schedule.statusDisabled")}
        </Badge>
      </DisabledReasonTooltip>
    );
  }

  return (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="size-3" />
      {t("schedule.statusActive")}
    </Badge>
  );
}

/**
 * A schedule's state where it is listed: on or off, its unread runs, and a
 * run in progress. The card and the dashboard row draw the same three facts.
 */
export function ScheduleStateBadges({
  schedule,
}: {
  schedule: Pick<EnrichedSchedule, "enabled" | "disabled_reason" | "unread_count" | "running_runs">;
}) {
  const { t } = useTranslation(["agents"]);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <ScheduleStatusBadge schedule={schedule} />
      <CountBadge
        count={schedule.unread_count}
        label={t("dashboard.unreadRuns", { count: schedule.unread_count })}
      />
      {schedule.running_runs > 0 && <RunStatusBadge status="running" />}
    </div>
  );
}
