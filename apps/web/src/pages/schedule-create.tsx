// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { useAgents } from "../hooks/use-packages";
import { useCreateSchedule, useScheduleFormDeps } from "../hooks/use-schedules";
import { ScheduleForm } from "../components/schedule-form";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState } from "../components/page-states";

export function ScheduleCreatePage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();

  const { data: agents, isLoading: agentsLoading } = useAgents();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const effectiveAgentId = selectedAgentId || agents?.[0]?.id || "";
  const { deps, error: depsError } = useScheduleFormDeps(effectiveAgentId || undefined);
  const createSchedule = useCreateSchedule(effectiveAgentId);

  if (!isAdmin) return null;
  if (agentsLoading) return <LoadingState />;
  // Same reason as the edit page: `ScheduleForm` seeds its input state once, in
  // a `useState` initialiser, and `key={effectiveAgentId}` gives no remount when
  // the agent detail lands later — a form mounted on empty settings classifies
  // nothing as pre-filled and renders the "Avancé" fold blank. With no agent at
  // all there is nothing to wait for, so the (empty) selector stays reachable.
  // A detail query that FAILED never lands either, so it gets the error
  // affordance rather than an endless spinner.
  if (depsError) return <ErrorState message={depsError.message} />;
  if (effectiveAgentId && !deps) return <LoadingState />;

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
        agents={agents?.map((f) => ({ id: f.id, displayName: f.display_name ?? f.id })) ?? []}
        selectedAgentId={effectiveAgentId}
        onAgentChange={setSelectedAgentId}
        inputWrapper={deps?.inputWrapper}
        persistedModelId={deps?.persistedModelId ?? null}
        persistedGenerationConfig={deps?.persistedGenerationConfig ?? null}
        persistedProxyId={deps?.persistedProxyId ?? null}
        persistedVersion={deps?.persistedVersion ?? null}
        packageId={effectiveAgentId || undefined}
        agentIntegrations={deps?.agentIntegrations ?? []}
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
