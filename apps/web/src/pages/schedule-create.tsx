// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useAgents, usePackageDetail } from "../hooks/use-packages";
import { useCreateSchedule } from "../hooks/use-schedules";
import { useAgentModel } from "../hooks/use-models";
import { useAgentProxy } from "../hooks/use-proxies";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState } from "../components/page-states";
import { isFileField } from "@appstrate/core/form";

export function ScheduleCreatePage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const navigate = useNavigate();

  const { data: agents, isLoading: agentsLoading } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  // Auto-select first agent when agents load
  const effectiveAgentId = selectedAgentId || agents?.[0]?.id || "";
  const { data: agentDetail } = usePackageDetail("agent", effectiveAgentId || undefined);
  const createSchedule = useCreateSchedule(effectiveAgentId);
  const { data: agentModel } = useAgentModel(effectiveAgentId || undefined);
  const { data: agentProxy } = useAgentProxy(effectiveAgentId || undefined);

  if (!isMember) return null;
  if (agentsLoading) return <LoadingState />;

  const inputSchema = agentDetail?.input?.schema;
  const hasFileInputs =
    inputSchema?.properties && Object.values(inputSchema.properties).some(isFileField);

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
        inputSchema={inputSchema}
        configSchema={agentDetail?.config?.schema ?? undefined}
        persistedConfig={(agentDetail?.config?.current ?? {}) as Record<string, unknown>}
        persistedModelId={agentModel?.modelId ?? null}
        persistedProxyId={agentProxy?.proxyId ?? null}
        persistedVersion={agentDetail?.version ?? null}
        packageId={effectiveAgentId || undefined}
        blockedMessage={hasFileInputs ? t("schedule.fileInputBlocked") : undefined}
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
