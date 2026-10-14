// SPDX-License-Identifier: Apache-2.0

import { usePermissions } from "../hooks/use-permissions";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import i18n from "../i18n";
import type { AgentListItem, EnrichedRun, EnrichedSchedule } from "@appstrate/shared-types";
import { ArrowRight, Bot, MessageSquareText, Copy, LayoutDashboard, Sparkles } from "lucide-react";
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
import { PackageIcon } from "../components/package-icon";
import { EmptyState } from "../components/page-states";
import { ChoiceCard } from "../components/choice-card";
import { Modal } from "../components/modal";
import { useModalParam } from "../hooks/use-modal-param";
import { PageHeader } from "../components/page-header";
import { ScheduleStateBadges } from "../components/schedule-status-badge";
import { PackageCard } from "../components/package-card";
import { RunRow } from "../components/run-row";
import { scheduleLabel, scheduleNextRunAt } from "../lib/schedule-options";
import { agentCardItem } from "../lib/package-card-item";
import { useCanReach } from "../hooks/use-can-reach";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { chatDraftNavigationState } from "../lib/creation-handoff";
import { formatDateField } from "../lib/format-date";
import { dashboardSections } from "../lib/dashboard-sections";
import { scheduleDetailPath } from "../lib/package-paths";
import { toast } from "sonner";
import { Skeleton } from "@appstrate/ui/components/skeleton";

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

/** The greeting: drawn at once, its running count a placeholder until the runs answer. */
export function DashboardHeader({
  firstName,
  runningCount,
}: {
  firstName: string;
  runningCount?: number;
}) {
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
        {runningCount === undefined ? (
          <Skeleton className="mt-1.5 h-3.5 w-56" />
        ) : (
          <p className="text-muted-foreground mt-1 text-sm first-letter:uppercase">
            {t("dashboard.subtitle", { date, count: runningCount })}
          </p>
        )}
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
              <ChoiceCard
                icon={MessageSquareText}
                title={t("dashboard.askAi.chat")}
                description={t("dashboard.askAi.chatDescription")}
                onClick={openChat}
              />
            )}
            <ChoiceCard
              icon={Bot}
              title={t("dashboard.askAi.codingAgent")}
              adornment={<Copy className="size-3.5" />}
              description={t("dashboard.askAi.codingAgentDescription")}
              onClick={() => void copyCodingAgentSetup()}
            />
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
            <div className="h-full w-[19rem]">
              <PackageCard {...agentCardItem(agent, unreadCounts?.[agent.id])} headingLevel={3} />
            </div>
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
        <RunRow
          key={run.id}
          run={run}
          agentName={agentName(run)}
          agent={run.packageId ? agentById.get(run.packageId) : undefined}
          className="first:rounded-t-xl last:rounded-b-xl"
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
  const nextRunAt = scheduleNextRunAt(schedule);
  return (
    <Link
      to={scheduleDetailPath(schedule.id)}
      className="hover:bg-muted/40 flex min-h-[74px] items-center gap-3 px-4 py-3 transition-colors first:rounded-t-xl last:rounded-b-xl"
    >
      <PackageIcon
        type="agent"
        icon={agent?.icon}
        color={agent?.color}
        className="size-9 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{scheduleLabel(schedule, t)}</p>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {agent?.display_name ?? schedule.packageId}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <ScheduleStateBadges schedule={schedule} />
        <p className="text-muted-foreground mt-1 text-[11px] tabular-nums">
          {nextRunAt ? formatDateField(nextRunAt, "datetime", schedule.timezone) : "—"}
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
