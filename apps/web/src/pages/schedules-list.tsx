// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Calendar, Plus } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { LoadingState, ErrorState } from "../components/page-states";
import { RichEmptyState } from "../components/rich-empty-state";
import { ScheduleCard } from "../components/schedule-card";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();
  const { data: schedules, isLoading, error } = useAllSchedules();
  const { data: agents } = useAgents();

  const getAgentName = (packageId: string) =>
    agents?.find((f) => f.id === packageId)?.display_name ?? packageId;

  return (
    <div className="mx-auto w-full max-w-[1300px] p-8 pb-16">
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-2.5">
              <h1 className="text-[1.6rem] font-bold tracking-tight">{t("schedules.title")}</h1>
              <span className="text-muted-foreground text-sm">
                {schedules?.length ?? 0} {t("schedules.title").toLowerCase()}
              </span>
            </div>
            <span className="flex-1" />
            {isMember && (
              <Button onClick={() => navigate("/schedules/new")}>
                <Plus className="size-4" /> {t("schedules.create")}
              </Button>
            )}
          </div>

          {!schedules || schedules.length === 0 ? (
            <RichEmptyState
              icon={Calendar}
              title={t("schedules.empty")}
              description={t("schedules.emptyHint")}
              action={
                isMember ? (
                  <Button onClick={() => navigate("/schedules/new")}>
                    <Plus className="size-4" /> {t("schedules.create")}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              {schedules.map((sched) => (
                <ScheduleCard
                  key={sched.id}
                  schedule={sched}
                  agentName={getAgentName(sched.packageId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
