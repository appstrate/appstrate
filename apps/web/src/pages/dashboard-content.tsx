// SPDX-License-Identifier: Apache-2.0

import { usePermissions } from "../hooks/use-permissions";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import i18n from "../i18n";
import type { AgentListItem, EnrichedRun, EnrichedSchedule } from "@appstrate/shared-types";
import {
  ArrowRight,
  Bot,
  MessageSquareText,
  Copy,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@appstrate/ui/components/carousel";
import { useCarousel } from "@appstrate/ui/components/carousel-context";
import { AgentIdentityTile } from "../components/agent-identity";
import { Badge } from "../components/status-badge";
import { EmptyState } from "../components/page-states";
import { Modal } from "../components/modal";
import { useModalParam } from "../hooks/use-modal-param";
import { PageHeader } from "../components/page-header";
import { RunDuration } from "../components/run-duration";
import { RunAgentButton } from "../components/run-agent-button";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { scheduleNextRunAt } from "../lib/schedule-options";
import { useCanReach } from "../hooks/use-can-reach";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { chatDraftNavigationState } from "../lib/creation-handoff";
import { formatDateField } from "../lib/format-date";
import { dashboardSections } from "../lib/dashboard-sections";
import { packageDetailPath, runDetailPath, scheduleDetailPath } from "../lib/package-paths";
import { RunProvenanceBadges } from "../components/run-cells";
import { toast } from "sonner";

const CODING_AGENT_SETUP_URL = "https://raw.githubusercontent.com/appstrate/skills/main/README.md";

const CODING_AGENT_SETUP_PROMPT = `Fetch and follow the Appstrate coding-agent setup instructions from ${CODING_AGENT_SETUP_URL}. Install the relevant Appstrate skills, then ask me what I want to create, run, or monitor in this workspace.`;

export interface DashboardData {
  firstName: string;
  agents: AgentListItem[];
  runs: EnrichedRun[];
  runTotal: number;
  /** Every schedule: the active ones are counted, the soonest listed. */
  schedules: EnrichedSchedule[];
  agentName: (run: EnrichedRun) => string;
  /** Unread run notifications per agent id. */
  unreadCounts?: Record<string, number>;
}

function SectionHeading({ title, href, action }: { title: string; href: string; action: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <Link
        to={href}
        className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 text-xs font-medium transition-colors"
      >
        {action}
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

function DashboardHeader({ firstName, runningCount }: { firstName: string; runningCount: number }) {
  const { t, i18n } = useTranslation("agents");
  const canChat = useCanReach()("/chat");
  const { copy } = useCopyToClipboard();
  const assist = useModalParam("assist");
  const date = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const openChat = () => {
    assist.leave("/chat", chatDraftNavigationState(t("dashboard.askAi.draft")));
  };

  const copyCodingAgentSetup = async () => {
    if (await copy(CODING_AGENT_SETUP_PROMPT))
      toast.success(t("dashboard.askAi.codingAgentCopied"));
  };

  return (
    <>
      <PageHeader
        title={
          firstName
            ? t("dashboard.greeting", { name: firstName })
            : t("dashboard.greetingAnonymous")
        }
        titleClassName="text-3xl font-bold tracking-tight"
        breadcrumbs={[{ label: t("dashboard.breadcrumb") }]}
        actions={
          <Button type="button" variant="outline" onClick={() => assist.open()}>
            <Sparkles />
            {t("dashboard.askAi.action")}
          </Button>
        }
      >
        <p className="text-muted-foreground mt-1 text-sm first-letter:uppercase">
          {t("dashboard.subtitle", { date, count: runningCount })}
        </p>
      </PageHeader>

      {assist.value !== null && (
        <Modal
          open
          onClose={assist.close}
          title={t("dashboard.askAi.title")}
          className="sm:max-w-xl"
        >
          <p className="text-muted-foreground text-sm">{t("dashboard.askAi.description")}</p>
          <div className="space-y-2">
            {/* Offered where `/chat` opens: the module loaded AND the caller's grants. */}
            {canChat && (
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
                onClick={openChat}
              >
                <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
                  <MessageSquareText />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{t("dashboard.askAi.chat")}</span>
                  <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
                    {t("dashboard.askAi.chatDescription")}
                  </span>
                </span>
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
              onClick={() => void copyCodingAgentSetup()}
            >
              <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
                <Bot />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {t("dashboard.askAi.codingAgent")}
                  <Copy className="size-3.5" />
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
                  {t("dashboard.askAi.codingAgentDescription")}
                </span>
              </span>
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function MetricCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string | number;
  detail: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border bg-card rounded-xl border p-4 shadow-sm",
        "flex min-h-32 flex-col justify-between",
        className,
      )}
    >
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <div>
        <p className="text-3xl font-semibold tabular-nums">{value}</p>
        <p className="text-muted-foreground mt-1 text-xs">{detail}</p>
      </div>
    </div>
  );
}

function DashboardAgentCard({
  agent,
  unreadCount,
  className,
}: {
  agent: AgentListItem;
  unreadCount: number | undefined;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  const href = packageDetailPath("agent", agent.id);

  return (
    <div
      className={cn(
        "border-border bg-card hover:border-foreground/20 hover:bg-accent/30 group relative flex min-h-48 flex-col rounded-xl border p-4 shadow-sm transition-colors",
        className,
      )}
    >
      <Link
        to={href}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
        aria-label={t("dashboard.openAgent", { name: agent.display_name || agent.id })}
      />
      <div className="flex items-start justify-between gap-3">
        <AgentIdentityTile
          agentId={agent.id}
          icon={agent.icon}
          color={agent.color}
          className="size-10 rounded-[10px]"
        />
        <div className="relative z-20 flex items-center gap-1.5">
          {agent.source === "system" && (
            <ShieldCheck
              className="text-muted-foreground size-4"
              aria-label={t("dashboard.systemAgent")}
            />
          )}
          {!!unreadCount && (
            <span
              className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium"
              aria-label={t("dashboard.unreadRuns", { count: unreadCount })}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {agent.running_runs ? <Badge status="running" /> : null}
          <RunAgentButton
            packageId={agent.id}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-primary size-7"
          />
        </div>
      </div>
      <h3 className="mt-4 truncate text-sm font-semibold">{agent.display_name || agent.id}</h3>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
        {agent.description || t("dashboard.agentFallbackDescription")}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-4">
        {agent.version && (
          <span className="bg-muted text-muted-foreground rounded-md px-2 py-1 font-mono text-[10px]">
            v{agent.version}
          </span>
        )}
        <span className="text-muted-foreground group-hover:text-foreground ml-auto text-[11px] transition-colors">
          {t("dashboard.open")}
        </span>
        <ArrowRight className="text-muted-foreground size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </div>
  );
}

function RecentAgents({
  agents,
  unreadCounts,
  className,
}: {
  agents: AgentListItem[];
  unreadCounts: Record<string, number> | undefined;
  className?: string;
}) {
  const { t } = useTranslation("agents");

  return (
    <Carousel
      opts={{ align: "start", dragFree: true, slidesToScroll: "auto" }}
      className={className}
      aria-label={t("dashboard.recentAgents")}
      data-dashboard-agent-carousel
    >
      <CarouselContent className="-ml-3 pb-1">
        {agents.map((agent) => (
          <CarouselItem key={agent.id} className="basis-auto pl-3">
            <DashboardAgentCard
              agent={agent}
              unreadCount={unreadCounts?.[agent.id]}
              className="w-[19rem]"
            />
          </CarouselItem>
        ))}
      </CarouselContent>
      <CarouselPrevious
        className="left-2 z-20 disabled:hidden"
        aria-label={t("dashboard.previousAgents")}
      />
      <RecentAgentsEndFade />
      <CarouselNext
        className="right-2 z-20 disabled:hidden"
        aria-label={t("dashboard.moreAgents")}
      />
    </Carousel>
  );
}

/** Fades the last visible card while more agents sit past the edge. */
function RecentAgentsEndFade() {
  const { canScrollNext } = useCarousel();
  return (
    <div
      className={cn(
        "from-canvas pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l to-transparent transition-opacity",
        canScrollNext ? "opacity-100" : "opacity-0",
      )}
      aria-hidden="true"
      data-carousel-end-fade
    />
  );
}

function DashboardRunRow({
  run,
  agentName,
  agent,
}: {
  run: EnrichedRun;
  agentName: (run: EnrichedRun) => string;
  agent?: AgentListItem;
}) {
  const { t } = useTranslation("agents");
  const name = agentName(run);
  const content = (
    <>
      <AgentIdentityTile
        agentId={run.packageId ?? run.agent_name ?? run.id}
        icon={agent?.icon}
        color={agent?.color}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {run.runNumber != null && (
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
              #{run.runNumber}
            </span>
          )}
          <RunProvenanceBadges run={run} />
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {run.started_at ? formatDateField(run.started_at) : t("dashboard.runPending")}
        </p>
      </div>
      <Badge status={run.status} unread={run.unread} />
      <span className="text-muted-foreground w-14 text-right text-xs tabular-nums">
        <RunDuration status={run.status} startedAt={run.started_at} duration={run.duration} />
      </span>
    </>
  );

  const className =
    "hover:bg-muted/40 flex min-h-16 items-center gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl";

  return run.packageId ? (
    <Link
      to={runDetailPath(run.packageId, run.id)}
      state={{ runNumber: run.runNumber }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

function RecentRuns({
  runs,
  agentName,
  agentById,
  limit = 7,
}: {
  runs: EnrichedRun[];
  agentName: (run: EnrichedRun) => string;
  agentById: Map<string, AgentListItem>;
  limit?: number;
}) {
  return (
    <div className="border-border bg-card divide-border divide-y rounded-xl border shadow-sm">
      {runs.slice(0, limit).map((run) => (
        <DashboardRunRow
          key={run.id}
          run={run}
          agentName={agentName}
          agent={run.packageId ? agentById.get(run.packageId) : undefined}
        />
      ))}
    </div>
  );
}

function DashboardScheduleRow({
  schedule,
  agent,
}: {
  schedule: EnrichedSchedule;
  agent?: AgentListItem;
}) {
  const { t } = useTranslation("agents");
  return (
    <Link
      to={scheduleDetailPath(schedule.id)}
      className="hover:bg-muted/40 flex min-h-[74px] items-center gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl"
    >
      <AgentIdentityTile
        agentId={schedule.packageId}
        icon={agent?.icon}
        color={agent?.color}
        className="size-9"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{schedule.name || schedule.id}</p>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {agent?.display_name ?? schedule.packageId}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <ScheduleStatusBadge schedule={schedule} />
        <p className="text-muted-foreground mt-1 text-[11px] tabular-nums">
          {schedule.next_run_at
            ? formatDateField(schedule.next_run_at, "datetime", schedule.timezone)
            : t("dashboard.noDate")}
        </p>
      </div>
    </Link>
  );
}

function UpcomingSchedules({
  schedules,
  agentById,
}: {
  schedules: EnrichedSchedule[];
  agentById: Map<string, AgentListItem>;
}) {
  return (
    <div className="border-border bg-card divide-border divide-y rounded-xl border shadow-sm">
      {schedules.map((schedule) => (
        <DashboardScheduleRow
          key={schedule.id}
          schedule={schedule}
          agent={agentById.get(schedule.packageId)}
        />
      ))}
    </div>
  );
}

function dashboardMetrics(
  data: DashboardData,
  sections: ReturnType<typeof dashboardSections>,
  t: TFunction,
) {
  const running = data.runs.filter((run) => run.status === "running").length;
  const terminal = data.runs.filter((run) => !["running", "pending"].includes(run.status));
  const successful = terminal.filter((run) => run.status === "success").length;
  // No finished run has no rate: « 0 % » would read as every run failing.
  const successRate = terminal.length
    ? new Intl.NumberFormat(i18n.language, { style: "percent" }).format(
        successful / terminal.length,
      )
    : "—";
  const activeSchedules = data.schedules.filter((schedule) => schedule.enabled);
  // The five that fire soonest; an active schedule with no next run is counted, not listed.
  const upcomingSchedules = data.schedules
    .flatMap((schedule) => {
      const nextRunAt = scheduleNextRunAt(schedule);
      return nextRunAt ? [{ schedule, at: new Date(nextRunAt).getTime() }] : [];
    })
    .sort((a, b) => a.at - b.at)
    .slice(0, 5)
    .map(({ schedule }) => schedule);

  return {
    running,
    upcomingSchedules,
    // A card whose read is closed to the caller is dropped, not shown as 0.
    cards: [
      sections.recentRuns && {
        label: t("dashboard.metric.runs"),
        value: data.runTotal,
        detail: t("dashboard.metric.runsDetail", { count: running }),
      },
      sections.recentAgents && {
        label: t("dashboard.metric.agents"),
        value: data.agents.length,
        detail: t("dashboard.metric.agentsDetail", {
          count: data.agents.filter((agent) => agent.running_runs).length,
        }),
      },
      sections.recentRuns && {
        label: t("dashboard.metric.success"),
        value: successRate,
        detail: t("dashboard.metric.successDetail", { successful, count: terminal.length }),
      },
      sections.schedules && {
        label: t("dashboard.metric.schedules"),
        value: activeSchedules.length,
        detail: upcomingSchedules[0]?.next_run_at
          ? t("dashboard.metric.schedulesNext", {
              date: formatDateField(
                upcomingSchedules[0].next_run_at,
                "datetime",
                upcomingSchedules[0].timezone,
              ),
            })
          : t("dashboard.metric.schedulesNone"),
      },
    ].filter((card) => card !== false),
  };
}

export function DashboardContent(data: DashboardData) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  // The dashboard is the fallback route and renders for ANY principal: each
  // section answers to the guard of the query that feeds it.
  const sections = dashboardSections(can);
  const metrics = dashboardMetrics(data, sections, t);
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));
  // What is DRAWN, not merely readable: a readable section with nothing in it
  // is left out rather than drawn as an empty box.
  const shown = {
    recentAgents: sections.recentAgents && data.agents.length > 0,
    recentRuns: sections.recentRuns && data.runs.length > 0,
    schedules: sections.schedules && metrics.upcomingSchedules.length > 0,
  };

  if (!shown.recentAgents && !shown.recentRuns && !shown.schedules) {
    return (
      <div className="space-y-8">
        <DashboardHeader firstName={data.firstName} runningCount={metrics.running} />
        <EmptyState
          message={t("dashboard.empty")}
          hint={t("dashboard.emptyHint")}
          icon={LayoutDashboard}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader firstName={data.firstName} runningCount={metrics.running} />

      {metrics.cards.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.cards.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </div>
      )}

      {shown.recentAgents && (
        <section>
          <SectionHeading
            title={t("dashboard.recentAgents")}
            href="/agents"
            action={t("dashboard.allAgents")}
          />
          <RecentAgents agents={data.agents} unreadCounts={data.unreadCounts} />
        </section>
      )}

      {/* The schedules column follows the same permission as its nav entry, so
          its link never 403s. When one column is absent the other takes the
          full width rather than leaving a hole. */}
      <div
        className={cn(
          "grid grid-cols-1 gap-6",
          shown.schedules &&
            shown.recentRuns &&
            "lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]",
        )}
      >
        {shown.recentRuns && (
          <section className="min-w-0">
            <SectionHeading
              title={t("dashboard.recentRuns")}
              href="/runs"
              action={t("dashboard.seeAll")}
            />
            <RecentRuns runs={data.runs} agentName={data.agentName} agentById={agentById} />
          </section>
        )}
        {shown.schedules && (
          <section className="min-w-0">
            <SectionHeading
              title={t("dashboard.upcomingSchedules")}
              href="/schedules"
              action={t("dashboard.schedules")}
            />
            <UpcomingSchedules schedules={metrics.upcomingSchedules} agentById={agentById} />
          </section>
        )}
      </div>
    </div>
  );
}
