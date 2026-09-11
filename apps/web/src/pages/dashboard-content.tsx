// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { usePermissions } from "../hooks/use-permissions";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { AgentListItem, EnrichedRun, EnrichedSchedule } from "@appstrate/shared-types";
import {
  ArrowRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  MessageSquareText,
  Copy,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { ScrollArea } from "@appstrate/ui/components/scroll-area";
import { AgentIdentityTile } from "../components/agent-identity";
import { Badge } from "../components/status-badge";
import { Modal } from "../components/modal";
import { PageHeader } from "../components/page-header";
import { RunDuration } from "../components/run-duration";
import { RunAgentButton } from "../components/run-agent-button";
import { ScheduleStatusBadge } from "../components/schedule-status-badge";
import { useAppConfig } from "../hooks/use-app-config";
import { chatDraftNavigationState } from "../lib/creation-handoff";
import { formatDateField } from "../lib/format-date";
import { packageDetailPath } from "../lib/package-paths";
import { toast } from "sonner";

const CODING_AGENT_SETUP_URL = "https://raw.githubusercontent.com/appstrate/skills/main/README.md";

const CODING_AGENT_SETUP_PROMPT = `Fetch and follow the Appstrate coding-agent setup instructions from ${CODING_AGENT_SETUP_URL}. Install the relevant Appstrate skills, then ask me what I want to create, run, or monitor in this workspace.`;

export interface DashboardData {
  firstName: string;
  agents: AgentListItem[];
  runs: EnrichedRun[];
  runTotal: number;
  schedules: EnrichedSchedule[];
  agentName: (run: EnrichedRun) => string;
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
  const { t } = useTranslation("agents");
  const { features } = useAppConfig();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAiOpen = searchParams.get("assist") === "1";
  const date = new Intl.DateTimeFormat("fr-CA", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const openChat = () => {
    navigate("/chat", { state: chatDraftNavigationState(t("dashboard.askAi.draft")) });
  };

  const copyCodingAgentSetup = async () => {
    await navigator.clipboard.writeText(CODING_AGENT_SETUP_PROMPT);
    toast.success(t("dashboard.askAi.codingAgentCopied"));
  };

  const setAiOpen = (open: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (open) next.set("assist", "1");
    else next.delete("assist");
    setSearchParams(next, { replace: !open });
  };

  return (
    <>
      <PageHeader
        title={`Bonjour, ${firstName || "Olivier"}`}
        titleClassName="text-3xl font-bold tracking-tight"
        breadcrumbs={[{ label: t("dashboard.breadcrumb") }]}
        actions={
          <Button type="button" variant="outline" onClick={() => setAiOpen(true)}>
            <Sparkles />
            {t("dashboard.askAi.action")}
          </Button>
        }
      >
        <p className="text-muted-foreground mt-1 text-sm first-letter:uppercase">
          {date} · {runningCount} exécution{runningCount === 1 ? "" : "s"} en cours
        </p>
      </PageHeader>

      {isAiOpen && (
        <Modal
          open
          onClose={() => setAiOpen(false)}
          title={t("dashboard.askAi.title")}
          className="sm:max-w-xl"
        >
          <p className="text-muted-foreground text-sm">{t("dashboard.askAi.description")}</p>
          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
              onClick={openChat}
              disabled={!features.chat}
            >
              <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
                <MessageSquareText />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{t("dashboard.askAi.chat")}</span>
                <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
                  {t(
                    features.chat
                      ? "dashboard.askAi.chatDescription"
                      : "dashboard.askAi.chatUnavailable",
                  )}
                </span>
              </span>
            </Button>
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

function DashboardAgentCard({ agent, className }: { agent: AgentListItem; className?: string }) {
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
        aria-label={`Ouvrir ${agent.display_name || agent.id}`}
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
            <ShieldCheck className="text-muted-foreground size-4" aria-label="Agent système" />
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
        {agent.description || "Agent Appstrate"}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-4">
        {agent.version && (
          <span className="bg-muted text-muted-foreground rounded-md px-2 py-1 font-mono text-[10px]">
            v{agent.version}
          </span>
        )}
        <span className="text-muted-foreground group-hover:text-foreground ml-auto text-[11px] transition-colors">
          Ouvrir
        </span>
        <ArrowRight className="text-muted-foreground size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </div>
  );
}

function RecentAgents({ agents, className }: { agents: AgentListItem[]; className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [canScrollBack, setCanScrollBack] = useState(false);
  const [canScrollForward, setCanScrollForward] = useState(false);

  const viewport = useCallback(
    () => rootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null,
    [],
  );

  const updateScrollState = useCallback(() => {
    const element = viewport();
    if (!element) return;
    const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft;
    setCanScrollBack(element.scrollLeft > 2);
    setCanScrollForward(remaining > 2);
  }, [viewport]);

  useEffect(() => {
    const element = viewport();
    if (!element) return;
    const frame = requestAnimationFrame(updateScrollState);
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", updateScrollState);
    };
  }, [agents.length, updateScrollState, viewport]);

  const scroll = (direction: -1 | 1) => {
    const element = viewport();
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(304, element.clientWidth * 0.72),
      behavior: "smooth",
    });
  };

  return (
    <div
      className={cn("relative", className)}
      role="region"
      aria-label="Agents récents"
      data-dashboard-agent-carousel
    >
      <ScrollArea ref={rootRef} className="w-full [&_[data-radix-scroll-area-scrollbar]]:hidden">
        <div className="flex w-max gap-3 pb-1">
          {agents.map((agent) => (
            <DashboardAgentCard key={agent.id} agent={agent} className="w-[19rem] shrink-0" />
          ))}
        </div>
      </ScrollArea>

      {canScrollBack && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute top-1/2 left-2 z-10 size-8 -translate-y-1/2 rounded-full"
          onClick={() => scroll(-1)}
          aria-label="Afficher les agents précédents"
        >
          <ChevronLeft />
        </Button>
      )}

      <div
        className={cn(
          "from-canvas pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l to-transparent transition-opacity",
          canScrollForward ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
        data-carousel-end-fade
      />
      {canScrollForward && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute top-1/2 right-2 z-10 size-8 -translate-y-1/2 rounded-full"
          onClick={() => scroll(1)}
          aria-label="Afficher plus d’agents"
        >
          <ChevronRight />
        </Button>
      )}
    </div>
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
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {run.started_at ? formatDateField(run.started_at) : "Démarrage en attente"}
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
      to={`/agents/${run.packageId}/runs/${run.id}`}
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
  return (
    <Link
      to={`/schedules/${schedule.id}`}
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
        <ScheduleStatusBadge enabled={schedule.enabled ?? true} />
        <p className="text-muted-foreground mt-1 text-[11px] tabular-nums">
          {schedule.next_run_at ? formatDateField(schedule.next_run_at) : "Aucune date"}
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
      {schedules.slice(0, 5).map((schedule) => (
        <DashboardScheduleRow
          key={schedule.id}
          schedule={schedule}
          agent={agentById.get(schedule.packageId)}
        />
      ))}
    </div>
  );
}

function dashboardMetrics(data: DashboardData) {
  const running = data.runs.filter((run) => run.status === "running").length;
  const terminal = data.runs.filter((run) => !["running", "pending"].includes(run.status));
  const successful = terminal.filter((run) => run.status === "success").length;
  const successRate = terminal.length ? Math.round((successful / terminal.length) * 100) : 0;
  const activeSchedules = data.schedules.filter((schedule) => schedule.enabled !== false);

  return {
    running,
    successRate,
    activeSchedules,
    cards: [
      {
        label: "Runs",
        value: data.runTotal,
        detail: `${running} en cours dans les derniers runs`,
      },
      {
        label: "Agents disponibles",
        value: data.agents.length,
        detail: `${data.agents.filter((agent) => agent.running_runs).length} actifs maintenant`,
      },
      {
        label: "Réussite des derniers runs",
        value: `${successRate} %`,
        detail: `${successful}/${terminal.length} runs terminés`,
      },
      {
        label: "Planifications actives",
        value: activeSchedules.length,
        detail: activeSchedules[0]?.next_run_at
          ? `Prochaine ${formatDateField(activeSchedules[0].next_run_at)}`
          : "Aucune exécution prévue",
      },
    ],
  };
}

export function DashboardContent(data: DashboardData) {
  const { t } = useTranslation("agents");
  const { can } = usePermissions();
  const canReadSchedules = can("schedules:read");
  const metrics = dashboardMetrics(data);
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));

  return (
    <div className="space-y-8">
      <DashboardHeader firstName={data.firstName} runningCount={metrics.running} />

      <div className="grid grid-cols-4 gap-3">
        {metrics.cards.map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </div>

      <section>
        <SectionHeading
          title={t("dashboard.recentAgents")}
          href="/agents"
          action={t("dashboard.allAgents")}
        />
        <RecentAgents agents={data.agents} />
      </section>

      {/* The schedules column follows the same permission as its nav entry: a
          caller who cannot reach `/schedules` was still being shown what is
          scheduled, with a link that 403s. When it is absent the runs column
          takes the full width rather than leaving a hole. */}
      <div
        className={cn(
          "grid gap-6",
          canReadSchedules ? "grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]" : "grid-cols-1",
        )}
      >
        <section className="min-w-0">
          <SectionHeading
            title={t("dashboard.recentRuns")}
            href="/runs"
            action={t("dashboard.seeAll")}
          />
          <RecentRuns runs={data.runs} agentName={data.agentName} agentById={agentById} />
        </section>
        {canReadSchedules && (
          <section className="min-w-0">
            <SectionHeading
              title={t("dashboard.upcomingSchedules")}
              href="/schedules"
              action={t("dashboard.schedules")}
            />
            <UpcomingSchedules schedules={metrics.activeSchedules} agentById={agentById} />
          </section>
        )}
      </div>
    </div>
  );
}
