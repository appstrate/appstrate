// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CalendarClock, CirclePlay, FileInput } from "lucide-react";
import { Fact, FactGrid } from "@appstrate/ui/components/fact-grid";
import { DetailSectionCard } from "./detail-section-card";
import { SkeletonBadge, SkeletonLine } from "./skeleton-line";

/**
 * A schedule's overview while it loads (`ScheduleDetailSkeleton`): the cards of
 * `schedule-detail.tsx`'s overview, titles and labels included, drawn by the same
 * components — only the schedule's own values wait.
 */
export function ScheduleOverviewSkeleton() {
  const { t } = useTranslation("agents");
  const fact = (labelKey: string, width: string) => (
    <Fact label={t(labelKey)}>
      <SkeletonLine className={width} />
    </Fact>
  );
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <DetailSectionCard title={t("run.infoExecution")} icon={CirclePlay}>
        <FactGrid columns={2}>
          {fact("schedule.agent", "w-32")}
          {/* The actor's label beside its member/end-user badge: the line the two make together. */}
          <Fact label={t("schedule.paramActor")}>
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {/* `ActorLabel` opens on its 14px icon, whose bottom edge is the line's baseline. */}
              <span className="inline-flex items-center gap-1">
                <span className="bg-muted size-3.5 animate-pulse rounded-full" />
                <SkeletonLine className="w-20" />
              </span>
              <SkeletonBadge className="w-12 px-1 py-0 text-[10px]" />
            </span>
          </Fact>
          {fact("run.infoVersion", "w-28")}
        </FactGrid>
      </DetailSectionCard>
      <DetailSectionCard title={t("schedule.settings.recurrence")} icon={CalendarClock}>
        <FactGrid columns={2}>
          {fact("schedule.settings.recurrence", "w-36")}
          {fact("schedule.timezone", "w-24")}
          {fact("schedule.paramNextRun", "w-36")}
          {fact("schedule.paramLastRun", "w-36")}
        </FactGrid>
      </DetailSectionCard>
      <DetailSectionCard
        title={t("detail.configuration.inputsShort")}
        icon={FileInput}
        className="lg:col-span-2"
      >
        <p className="text-muted-foreground mb-4 text-sm">{t("schedule.inputHint")}</p>
        <SkeletonLine className="w-48 text-sm" />
      </DetailSectionCard>
    </div>
  );
}
