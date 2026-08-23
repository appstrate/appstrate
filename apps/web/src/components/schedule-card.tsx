// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { Badge } from "./status-badge";
import { ScheduleStatusBadge } from "./schedule-status-badge";
import { NextRunPreview } from "./next-run-preview";
import { ActorLabel } from "./actor-label";
import type { EnrichedSchedule } from "@appstrate/shared-types";
import { useTranslation } from "react-i18next";
import { formatDateField } from "../lib/markdown";

interface ScheduleCardProps {
  schedule: EnrichedSchedule;
  agentName?: string;
  /** The level-one collection needs a real vertical card; embedded lists keep the compact row. */
  variant?: "compact" | "collection";
}

export function ScheduleCard({ schedule, agentName, variant = "compact" }: ScheduleCardProps) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  // The three counters this card shows are served WITH the schedule list
  // (`enrichSchedules` in services/scheduler.ts). They used to come from a
  // per-card `GET .../schedules/:id/runs`, which made a list of N schedules
  // fan out to N HTTP requests and ~2N SQL queries just to count three things.
  // They are also whole-history counts now, not counts within the last page of
  // runs the card happened to fetch.
  const runningRuns = schedule.running_runs;
  const unreadCount = schedule.unread_count;
  const lastRunNumber = schedule.last_run_number;

  const isActive = schedule.enabled ?? true;

  const statusBadge = <ScheduleStatusBadge enabled={schedule.enabled ?? true} />;
  const activityBadges = (
    <>
      {unreadCount > 0 && (
        <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
      {runningRuns > 0 && <Badge status="running" />}
    </>
  );

  if (variant === "collection") {
    return (
      <Link
        to={`/schedules/${schedule.id}`}
        className="border-border bg-card hover:bg-accent/50 flex min-h-44 flex-col rounded-lg border p-4 transition-colors"
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{schedule.name || schedule.id}</h2>
            <p className="text-muted-foreground mt-1 truncate text-xs">
              {agentName ?? schedule.packageId}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {statusBadge}
            {activityBadges}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <div className="min-w-0">
            <dt className="text-muted-foreground">{t("schedules.column.cron")}</dt>
            <dd className="mt-1 truncate font-mono" title={schedule.timezone ?? undefined}>
              {schedule.cron_expression}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">{t("schedules.column.next")}</dt>
            <dd className="mt-1 truncate">
              {isActive && schedule.next_run_at ? formatDateField(schedule.next_run_at) : "—"}
            </dd>
          </div>
        </dl>

        <ActorLabel
          actor_type={schedule.actor_type}
          actor_name={schedule.actor_name}
          className="text-muted-foreground mt-auto pt-4 text-xs"
        />
      </Link>
    );
  }

  return (
    <Link
      to={`/schedules/${schedule.id}`}
      className="border-border bg-card hover:bg-accent/50 block rounded-lg border transition-colors"
    >
      <div className="flex items-center gap-2 p-3">
        <span className="truncate font-medium">{schedule.name || schedule.id}</span>
        {statusBadge}
        {activityBadges}
        <ActorLabel
          actor_type={schedule.actor_type}
          actor_name={schedule.actor_name}
          className="text-muted-foreground ml-auto text-xs"
        />
      </div>

      {/* Next run preview -- flush to card edges */}
      {isActive && schedule.next_run_at && (
        <NextRunPreview
          runNumber={lastRunNumber + 1}
          agentName={agentName}
          schedule_name={schedule.name || schedule.id}
          next_run_at={schedule.next_run_at}
          className="border-border border-t border-dashed"
        />
      )}
    </Link>
  );
}
