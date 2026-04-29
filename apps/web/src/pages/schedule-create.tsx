// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useAgents } from "../hooks/use-packages";
import { useCreateSchedule, useScheduleFormDeps } from "../hooks/use-schedules";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState } from "../components/page-states";

export function ScheduleCreatePage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();

  const { data: agents, isLoading: agentsLoading } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const effectiveAgentId = selectedAgentId || agents?.[0]?.id || "";
  const deps = useScheduleFormDeps(effectiveAgentId || undefined);
  const createSchedule = useCreateSchedule(effectiveAgentId);

  if (!isMember) return null;
  if (agentsLoading) return <LoadingState />;

  return (
    <div className="p-6">
      <PageHeader
        title={t("schedule.titleNew")}
        emoji="📅"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("schedule.breadcrumbList"), href: "/schedules" },
          { label: t("schedule.breadcrumbNew") },
        ]}
      />

      <ScheduleForm
        key={effectiveAgentId}
        mode="create"
        agents={agents?.map((f) => ({ id: f.id, displayName: f.displayName })) ?? []}
        selectedAgentId={effectiveAgentId}
        onAgentChange={setSelectedAgentId}
        inputSchema={deps?.inputSchema}
        configSchema={deps?.configSchema}
        persistedConfig={deps?.persistedConfig ?? {}}
        persistedModelId={deps?.persistedModelId ?? null}
        persistedProxyId={deps?.persistedProxyId ?? null}
        persistedVersion={deps?.persistedVersion ?? null}
        packageId={effectiveAgentId || undefined}
        blockedMessage={deps?.hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
        isPending={createSchedule.isPending}
        onSubmit={(data) => {
          createSchedule.mutate(data, {
            onSuccess: () => navigate("/schedules"),
          });
        }}
        onCancel={() => navigate(-1)}
      />
    </div>
  );
}
