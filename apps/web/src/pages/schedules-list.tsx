// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import { usePermissions } from "../hooks/use-permissions";
import { Button } from "@/components/ui/button";
import { useFlows } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ScheduleCard } from "../components/schedule-card";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();
  const { data: schedules, isLoading, error } = useAllSchedules();
  const { data: flows } = useFlows();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const getFlowName = (packageId: string) =>
    flows?.find((f) => f.id === packageId)?.displayName ?? packageId;

  return (
    <>
      <PageHeader
        title={t("schedules.title")}
        emoji="📅"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("schedules.title") },
        ]}
        actions={
          isMember ? (
            <Button onClick={() => navigate("/schedules/new")}>{t("schedules.create")}</Button>
          ) : undefined
        }
      />

      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("schedules.empty")} hint={t("schedules.emptyHint")} icon={Calendar}>
          {isMember && (
            <Button onClick={() => navigate("/schedules/new")}>{t("schedules.create")}</Button>
          )}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {schedules.map((sched) => (
            <ScheduleCard key={sched.id} schedule={sched} flowName={getFlowName(sched.packageId)} />
          ))}
        </div>
      )}
    </>
  );
}
