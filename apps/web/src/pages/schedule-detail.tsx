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
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { ActorLabel } from "../components/actor-label";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { useScheduleById, useUpdateSchedule, useDeleteSchedule } from "../hooks/use-schedules";
import { useAgents } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";
import { MoreHorizontal, Pencil, Trash2, Play, Pause, Clock } from "lucide-react";

export function ScheduleDetailPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isMember } = usePermissions();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: schedule, isLoading, error } = useScheduleById(id);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const tabs = ["runs", "details"] as const;
  const [activeTab, setActiveTab] = useTabWithHash(tabs, "runs");
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error || !schedule) return <ErrorState message={error?.message} />;

  const handleToggle = () => {
    updateSchedule.mutate({ id: schedule.id, enabled: !schedule.enabled });
  };

  return (
    <div className="p-6">
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
            <TabsTrigger value="details">{t("schedule.tabDetails")}</TabsTrigger>
          </TabsList>
        </PageHeader>

        <TabsContent value="runs">
          <ScheduleHistory schedule={schedule} />
        </TabsContent>

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
    </div>
  );
}

// ─── Live Status Badge (reactive) ────────────────────────

function LiveScheduleStatusBadge({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  return <ScheduleStatusBadge enabled={schedule.enabled ?? true} />;
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
    agents?.find((f) => f.id === schedule.packageId)?.display_name ?? schedule.packageId;
  const input = schedule.input;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramActor")}</p>
          <p className="inline-flex items-center gap-1.5 text-sm font-medium">
            <ActorLabel
              actor_type={schedule.actor_type}
              actor_name={schedule.actor_name}
              iconSize="size-3.5"
            />
            {schedule.actor_type && (
              <UIBadge variant="outline" className="px-1 py-0 text-[10px]">
                {schedule.actor_type}
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
          <p className="font-mono text-sm">{schedule.cron_expression}</p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramTimezone")}</p>
          <p className="text-sm font-medium">{schedule.timezone ?? "UTC"}</p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramNextRun")}</p>
          <p className="text-sm font-medium">
            {schedule.next_run_at ? formatDateField(schedule.next_run_at) : "-"}
          </p>
        </div>

        <div className="border-border bg-muted/30 rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs">{t("schedule.paramLastRun")}</p>
          <p className="text-sm font-medium">
            {schedule.last_run_at ? formatDateField(schedule.last_run_at) : "-"}
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

// ─── History Tab ─────────────────────────────────────────

function ScheduleHistory({
  schedule,
}: {
  schedule: NonNullable<ReturnType<typeof useScheduleById>["data"]>;
}) {
  const { t } = useTranslation(["agents"]);
  const { data: agents } = useAgents();
  const agentName =
    agents?.find((f) => f.id === schedule.packageId)?.display_name ?? schedule.packageId;

  const isActive = schedule.enabled;

  // Use the same hook as RunList so React Query deduplicates the fetch.
  // We only need the first run for the "next run" preview row.
  const { data } = usePaginatedRuns({
    scheduleId: schedule.id,
    limit: 20,
    offset: 0,
  });
  const firstExec = data?.data?.[0];

  // Show the fake "next run" row only if the last run started > 30s ago.
  const lastStartedAt = firstExec?.started_at;
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
    isActive && showNext && schedule.next_run_at ? (
      <NextRunPreview
        runNumber={(firstExec?.runNumber ?? 0) + 1}
        agentName={agentName}
        schedule_name={schedule.name || schedule.id}
        next_run_at={schedule.next_run_at}
      />
    ) : null;

  return (
    <RunList
      scheduleId={schedule.id}
      pageSize={12}
      fixedAgentName={agentName}
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
