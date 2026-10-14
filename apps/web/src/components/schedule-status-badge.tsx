// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Badge as UIBadge } from "@appstrate/ui/components/badge";
import { CheckCircle2, Pause } from "lucide-react";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { DisabledReasonTooltip } from "./disabled-reason-tooltip";

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

/** The schedule's unread runs, counted on its card and its row; nothing when there is none. */
export function ScheduleUnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
