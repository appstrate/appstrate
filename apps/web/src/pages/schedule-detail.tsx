import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
import { ExecutionRow } from "../components/execution-row";
import { ProviderConnectionCard } from "../components/provider-connection-card";
import { OrgProfileProvidersBlock } from "../components/org-profile-providers-block";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import {
  useScheduleById,
  useScheduleExecutions,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import { usePackageDetail, useFlows } from "../hooks/use-packages";
import { useScheduleProviderReadiness } from "../hooks/use-schedule-readiness";
import { formatDateField } from "../lib/markdown";
import {
  User,
  Building2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Play,
  Pause,
  Calendar,
  Clock,
} from "lucide-react";
import type { Execution } from "@appstrate/shared-types";

export function ScheduleDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const { data: flowDetail } = usePackageDetail("flow", schedule?.packageId);
  const hasProviders = (flowDetail?.dependencies?.providers?.length ?? 0) > 0;

  const tabs = hasProviders
    ? (["executions", "providers", "details"] as const)
    : (["executions", "details"] as const);

  const needsSetup = hasProviders && schedule?.readiness?.status !== "ready";
  const defaultTab = needsSetup ? "providers" : "executions";
  const [activeTab, setActiveTab] = useTabWithHash(tabs, defaultTab);

  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const handleToggle = () => {
    updateSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled });
  };

  const handleDelete = () => {
    if (confirm(t("schedule.deleteConfirm"))) {
      deleteSchedule.mutate(schedule.id, {
        onSuccess: () => navigate("/schedules"),
      });
    }
  };

  return (
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
                  onSelect={handleDelete}
                  disabled={deleteSchedule.isPending}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 size={14} />
                  {t("schedule.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <TabsList className="mt-3">
          <TabsTrigger value="executions">{t("schedule.tabExecutions")}</TabsTrigger>
          {hasProviders && (
            <TabsTrigger value="providers">{t("schedule.tabProviders")}</TabsTrigger>
          )}
          <TabsTrigger value="details">{t("schedule.tabDetails")}</TabsTrigger>
        </TabsList>
      </PageHeader>

      <TabsContent value="executions">
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
  const { t } = useTranslation(["flows"]);
  const { data: flows } = useFlows();
  const flowDisplayName =
    flows?.find((f) => f.id === schedule.packageId)?.displayName ?? schedule.packageId;
  const ProfileIcon = schedule.profileType === "org" ? Building2 : User;
  const input = schedule.input as Record<string, unknown> | null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramProfile")}</p>
          <p className="text-sm font-medium inline-flex items-center gap-1.5">
            <ProfileIcon className="size-3.5" />
            {schedule.profileType === "user" && schedule.profileOwnerName
              ? `${schedule.profileOwnerName} — ${schedule.profileName}`
              : (schedule.profileName ?? "-")}
            {schedule.profileType && (
              <UIBadge variant="outline" className="text-[10px] px-1 py-0">
                {schedule.profileType}
              </UIBadge>
            )}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramFlow")}</p>
          <Link to={`/flows/${schedule.packageId}`} className="text-sm font-medium hover:underline">
            {flowDisplayName}
          </Link>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramCron")}</p>
          <p className="text-sm font-mono">{schedule.cronExpression}</p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramTimezone")}</p>
          <p className="text-sm font-medium">{schedule.timezone ?? "UTC"}</p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramNextRun")}</p>
          <p className="text-sm font-medium">
            {schedule.nextRunAt ? formatDateField(schedule.nextRunAt) : "-"}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground mb-1">{t("schedule.paramLastRun")}</p>
          <p className="text-sm font-medium">
            {schedule.lastRunAt ? formatDateField(schedule.lastRunAt) : "-"}
          </p>
        </div>
      </div>

      {/* Input data */}
      {input && Object.keys(input).length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-muted-foreground mb-3">
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
  const { t } = useTranslation(["flows"]);
  const { flowProviders } = useScheduleProviderReadiness(schedule);

  const isOrgProfile = schedule.profileType === "org";
  const orgProfileId = isOrgProfile ? schedule.connectionProfileId : undefined;

  if (flowProviders.length === 0) {
    return <EmptyState message={t("schedule.noProviders")} icon={Calendar} compact />;
  }

  if (isOrgProfile && orgProfileId) {
    return (
      <OrgProfileProvidersBlock
        orgProfileId={orgProfileId}
        orgProfileName={schedule.profileName ?? "-"}
        providerIds={flowProviders}
      />
    );
  }

  // User profile schedule — show provider cards directly
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <User className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {schedule.profileOwnerName && schedule.profileName
            ? `${schedule.profileOwnerName} — ${schedule.profileName}`
            : (schedule.profileName ?? "-")}
        </span>
        <UIBadge variant="outline" className="text-[10px] px-1 py-0">
          {schedule.profileType}
        </UIBadge>
      </div>
      <div className="p-2 space-y-2">
        {flowProviders.map((providerId) => (
          <ProviderConnectionCard key={providerId} providerId={providerId} />
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
  const { t } = useTranslation(["flows"]);
  const { data: executions, isLoading } = useScheduleExecutions(schedule.id);
  const { data: flows } = useFlows();
  const flowName =
    flows?.find((f) => f.id === schedule.packageId)?.displayName ?? schedule.packageId;

  const isActive = schedule.enabled && schedule.readiness.status === "ready";

  // Show the fake "next execution" row only if the last execution started > 30s ago.
  // This synchronizes with a time-based external system (wall clock), which legitimately
  // requires setState in an effect to react to data changes + schedule a delayed reveal.
  const lastStartedAt = executions?.[0]?.startedAt;
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

  if (isLoading) return <LoadingState />;

  return (
    <div className="rounded-md border border-border">
      {/* Next execution preview — same layout as ExecutionRow */}
      {isActive &&
        showNext &&
        schedule.nextRunAt &&
        (() => {
          const lastNumber = executions?.[0]?.executionNumber ?? 0;
          return (
            <div className="flex items-center gap-2 px-3 py-2 text-sm opacity-50">
              <div className="flex flex-1 items-center gap-2 min-w-0">
                <span className="text-muted-foreground font-mono text-xs">#{lastNumber + 1}</span>
                {flowName && <span className="font-medium truncate max-w-[150px]">{flowName}</span>}
                <UIBadge variant="secondary" className="gap-1">
                  <Clock className="size-3" />
                  {t("schedule.scheduled")}
                </UIBadge>
                <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                  <Calendar className="size-3" />
                  {schedule.name || schedule.id}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {formatDateField(schedule.nextRunAt)}
                  </span>
                </div>
              </div>
            </div>
          );
        })()}

      {!executions || executions.length === 0 ? (
        <div className="p-6">
          <EmptyState message={t("schedule.noExecutions")} icon={Clock} compact />
        </div>
      ) : (
        executions.map((exec: Execution) => (
          <ExecutionRow key={exec.id} execution={exec} flowName={flowName} />
        ))
      )}
    </div>
  );
}
