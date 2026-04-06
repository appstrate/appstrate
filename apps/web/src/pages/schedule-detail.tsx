// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermissions } from "../hooks/use-permissions";
import { ConfirmModal } from "../components/confirm-modal";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge as UIBadge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { JsonView } from "../components/json-view";
import { RunList } from "../components/run-list";
import { NextRunPreview } from "../components/next-run-preview";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { ProviderConnectionCard } from "../components/provider-connection-card";
import { AppProfileProvidersBlock } from "../components/app-profile-providers-block";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { ProfileLabel } from "../components/profile-label";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { usePackageDetail, useAgents } from "../hooks/use-packages";
import { useScheduleProviderReadiness } from "../hooks/use-schedule-readiness";
import { useConnectionProfiles } from "../hooks/use-connection-profiles";
import { formatDateField } from "../lib/markdown";
import { MoreHorizontal, Pencil, Trash2, Play, Pause, Calendar, Clock } from "lucide-react";

export function ScheduleDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const { data: agentDetail } = usePackageDetail("agent", schedule?.packageId);
  const hasProviders = (agentDetail?.dependencies?.providers?.length ?? 0) > 0;

  const tabs = hasProviders
    ? (["runs", "providers", "details"] as const)
    : (["runs", "details"] as const);

  const needsSetup = hasProviders && schedule?.readiness?.status !== "ready";
  const defaultTab = needsSetup ? "providers" : "runs";
  const [activeTab, setActiveTab] = useTabWithHash(tabs, defaultTab);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const handleToggle = () => {
    updateSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled });
  };

  return (
    <>
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <PageHeader
          title={schedule.name || schedule.id}
          emoji="📅"
          breadcrumbs={[
            { label: t("nav.orgSection", { ns: "common" }), href: "/" },
            { label: t("schedule.breadcrumbList"), href: "/schedules" },
            { label: schedule.name || schedule.id },
          ]}
          actions={
            <>
              <LiveScheduleStatusBadge schedule={schedule} />
              {isMember && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon">
                      <MoreHorizontal size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/schedules/${id}/edit`)}>
                      <Pencil size={14} />
                      {t("schedule.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleToggle} disabled={updateSchedule.isPending}>
                      {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
                      {schedule.enabled ? t("schedule.disable") : t("schedule.enable")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setConfirmOpen(true)}
                      disabled={deleteSchedule.isPending}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 size={14} />
                      {t("schedule.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          }
        >
          <TabsList className="mt-3">
            <TabsTrigger value="runs">{t("schedule.tabRuns")}</TabsTrigger>
            {hasProviders && (
              <TabsTrigger value="providers">{t("schedule.tabProviders")}</TabsTrigger>
            )}
            <TabsTrigger value="details">{t("schedule.tabDetails")}</TabsTrigger>
          </TabsList>
        </PageHeader>

        <TabsContent value="runs">
          <ScheduleHistory schedule={schedule} />
        </TabsContent>

        {hasProviders && (
          <TabsContent value="providers">
            <ScheduleProviders schedule={schedule} />
          </TabsContent>
        )}

        <TabsContent value="details">
          <ScheduleParams schedule={schedule} />
        </TabsContent>
      </Tabs>

      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("btn.confirm", { ns: "common" })}
        description={t("schedule.deleteConfirm")}
        isPending={deleteSchedule.isPending}
        onConfirm={() => {
          deleteSchedule.mutate(schedule.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              navigate("/schedules");
            },
          });
        }}
      />
    </>
  );
}

// ─── Live Status Badge (reactive) ────────────────────────

function LiveScheduleStatusBadge({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { allReady, isLoading, totalProviders } = useScheduleProviderReadiness(schedule);

  const effectiveReady = isLoading ? schedule.readiness.status === "ready" : allReady;
  const effectiveHasProviders = isLoading
    ? schedule.readiness.totalProviders > 0
    : totalProviders > 0;

  return (
    <ScheduleStatusBadge
      enabled={schedule.enabled ?? true}
      hasProviders={effectiveHasProviders}
      allReady={effectiveReady}
    />
  );
}

// ─── Params Tab ──────────────────────────────────────────

function ScheduleParams({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();
  const agentDisplayName =
    agents?.find((f) => f.id === schedule.packageId)?.displayName ?? schedule.packageId;
  const input = schedule.input as Record<string, unknown> | null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramProfile")}</p>
          <p className="inline-flex items-center gap-1.5 text-sm font-medium">
            <ProfileLabel
              profileType={schedule.profileType}
              profileName={schedule.profileName}
              profileOwnerName={schedule.profileOwnerName}
              iconSize="size-3.5"
            />
            {schedule.profileType && (
              <UIBadge variant="outline" className="px-1 py-0 text-[10px]">
                {schedule.profileType}
              </UIBadge>
            )}
          </p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramAgent")}</p>
          <Link
            to={`/agents/${schedule.packageId}`}
            className="text-sm font-medium hover:underline"
          >
            {agentDisplayName}
          </Link>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramCron")}</p>
          <p className="font-mono text-sm">{schedule.cronExpression}</p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramTimezone")}</p>
          <p className="text-sm font-medium">{schedule.timezone ?? "UTC"}</p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramNextRun")}</p>
          <p className="text-sm font-medium">
            {schedule.nextRunAt ? formatDateField(schedule.nextRunAt) : "-"}
          </p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramLastRun")}</p>
          <p className="text-sm font-medium">
            {schedule.lastRunAt ? formatDateField(schedule.lastRunAt) : "-"}
          </p>
        </div>
      </div>

      {/* Input data */}
      {input && Object.keys(input).length > 0 && (
        <div className="mt-6">
          <h3 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("schedule.tabInput")}
          </h3>
          <JsonView data={input} />
        </div>
      )}
    </>
  );
}

// ─── Providers Tab ───────────────────────────────────────

function ScheduleProviders({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents"]);
  const { agentProviders } = useScheduleProviderReadiness(schedule);
  const { data: userProfiles } = useConnectionProfiles();

  const isAppProfile = schedule.profileType === "app";
  const appProfileId = isAppProfile ? schedule.connectionProfileId : undefined;

  // For user profile schedules, only the profile owner can connect/disconnect
  const isProfileOwner = userProfiles?.some((p) => p.id === schedule.connectionProfileId) ?? false;

  if (agentProviders.length === 0) {
    return <EmptyState message={t("schedule.noProviders")} icon={Calendar} compact />;
  }

  if (isAppProfile && appProfileId) {
    return (
      <AppProfileProvidersBlock
        appProfileId={appProfileId}
        appProfileName={schedule.profileName ?? "-"}
        providerIds={agentProviders}
      />
    );
  }

  // User profile schedule — show provider cards directly
  return (
    <div className="border-border bg-card rounded-lg border">
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <ProfileLabel
          profileType={schedule.profileType}
          profileName={schedule.profileName}
          profileOwnerName={schedule.profileOwnerName}
          iconSize="size-4"
          className="text-muted-foreground text-sm font-medium"
        />
        <UIBadge variant="outline" className="px-1 py-0 text-[10px]">
          {schedule.profileType}
        </UIBadge>
      </div>
      <div className="space-y-2 p-2">
        {agentProviders.map((providerId) => (
          <ProviderConnectionCard
            key={providerId}
            providerId={providerId}
            readOnly={!isProfileOwner}
            viewProfileId={schedule.connectionProfileId}
          />
        ))}
      </div>
    </div>
  );
}

// ─── History Tab ─────────────────────────────────────────

function ScheduleHistory({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();
  const agentName =
    agents?.find((f) => f.id === schedule.packageId)?.displayName ?? schedule.packageId;

  const isActive = schedule.enabled && schedule.readiness.status === "ready";

  // Use the same hook as RunList so React Query deduplicates the fetch.
  // We only need the first run for the "next run" preview row.
  const { data } = usePaginatedRuns({
    scheduleId: schedule.id,
    limit: 20,
    offset: 0,
  });
  const firstExec = data?.runs?.[0];

  // Show the fake "next run" row only if the last run started > 30s ago.
  const lastStartedAt = firstExec?.startedAt;
  const [showNext, setShowNext] = useState(true);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing with wall clock timer */
  useEffect(() => {
    if (!lastStartedAt) {
      setShowNext(true);
      return;
    }
    const elapsed = Date.now() - new Date(lastStartedAt).getTime();
    if (elapsed > 30_000) {
      setShowNext(true);
      return;
    }
    setShowNext(false);
    const timer = setTimeout(() => setShowNext(true), 30_000 - elapsed);
    return () => clearTimeout(timer);
  }, [lastStartedAt]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const previewRow =
    isActive && showNext && schedule.nextRunAt ? (
      <NextRunPreview
        runNumber={(firstExec?.runNumber ?? 0) + 1}
        agentName={agentName}
        scheduleName={schedule.name || schedule.id}
        nextRunAt={schedule.nextRunAt}
      />
    ) : null;

  return (
    <RunList
      scheduleId={schedule.id}
      pageSize={12}
      fixedAgentName={agentName}
      fixedScheduleName={schedule.name}
      firstPageBanner={previewRow}
      emptyState={
        <div className="border-border rounded-md border">
          {previewRow}
          <div className="p-6">
            <EmptyState message={t("schedule.noRuns")} icon={Clock} compact />
          </div>
        </div>
      }
    />
  );
}
