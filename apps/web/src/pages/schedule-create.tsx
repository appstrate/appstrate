// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useFlows, usePackageDetail } from "../hooks/use-packages";
import { useCreateSchedule } from "../hooks/use-schedules";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState } from "../components/page-states";
import { isFileField } from "@appstrate/core/form";

export function ScheduleCreatePage() {
  const { t } = useTranslation(["flows", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();

  const { data: flows, isLoading: flowsLoading } = useFlows();
  const [selectedFlowId, setSelectedFlowId] = useState<string>("");

  // Auto-select first flow when flows load
  const effectiveFlowId = selectedFlowId || flows?.[0]?.id || "";
  const { data: flowDetail } = usePackageDetail("flow", effectiveFlowId || undefined);
  const createSchedule = useCreateSchedule(effectiveFlowId);

  if (!isMember) return null;
  if (flowsLoading) return <LoadingState />;

  const inputSchema = flowDetail?.input?.schema;
  const hasFileInputs =
    inputSchema?.properties && Object.values(inputSchema.properties).some(isFileField);

  return (
    <>
      <PageHeader
        title={t("schedule.titleNew")}
        emoji="📅"
        breadcrumbs={[
          { label: t("schedule.breadcrumbList"), href: "/schedules" },
          { label: t("schedule.breadcrumbNew") },
        ]}
      />

      <ScheduleForm
        key={effectiveFlowId}
        mode="create"
        flows={flows?.map((f) => ({ id: f.id, displayName: f.displayName })) ?? []}
        selectedFlowId={effectiveFlowId}
        onFlowChange={setSelectedFlowId}
        inputSchema={inputSchema}
        blockedMessage={hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
        isPending={createSchedule.isPending}
        onSubmit={(data) => {
          createSchedule.mutate(data, {
            onSuccess: () => navigate("/schedules"),
          });
        }}
        onCancel={() => navigate(-1)}
      />
    </>
  );
}
