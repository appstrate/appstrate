// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@appstrate/ui/components/button";
import { useAgents } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/page-states";
import { SchedulesTable } from "../components/schedules-table";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const { data: schedules, isLoading, isError } = useAllSchedules();
  const { data: agents } = useAgents();

  const create = (
    <Button onClick={() => navigate("/schedules/new")}>{t("schedules.create")}</Button>
  );

  // The same cached agents query every other surface holds, keyed by package id.
  const agentName = (packageId: string) =>
    agents?.find((a) => a.id === packageId)?.display_name ?? packageId;

  return (
    <div>
      <PageHeader
        title={t("schedules.title")}
        emoji="📅"
        breadcrumbs={[{ label: t("schedules.title") }]}
        actions={isAdmin ? create : undefined}
      />

      <SchedulesTable
        schedules={schedules ?? []}
        agentName={(schedule) => agentName(schedule.packageId)}
        isLoading={isLoading}
        isError={isError}
        empty={
          <EmptyState
            message={t("schedules.empty")}
            hint={t("schedules.emptyHint")}
            icon={Calendar}
          >
            {isAdmin && create}
          </EmptyState>
        }
      />
    </div>
  );
}
