// SPDX-License-Identifier: Apache-2.0

/**
 * A notification's own page (`/notifications/:id`): what it says, and links on
 * to what it is about (the run an agent wrote from, the package shared). It is
 * where the bell leads every kind but a failed run, and the one place such a
 * notification is read: opening it marks it read, viewing the run does not.
 */

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, MessageSquare, Share2 } from "lucide-react";
import { DetailBar } from "../components/detail-bar";
import { DetailSectionCard } from "../components/detail-section-card";
import { HeaderActionButton } from "../components/header-action-button";
import { NotificationDetailSkeleton } from "../components/loading-skeletons";
import { ResourceErrorState } from "../components/page-states";
import { RunStatusBadge } from "../components/status-badge";
import { useMarkRead, useNotification } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { useCanReach } from "../hooks/use-can-reach";
import { describeNotification } from "../lib/notification-view";
import { isQueryInFlight } from "../lib/query-state";

const KIND_ICON = {
  agent_message: MessageSquare,
  package_shared: Share2,
  run_failed: Bell,
} as const;

export function NotificationDetailPage() {
  const { t } = useTranslation(["common", "agents"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const canReach = useCanReach();
  const query = useNotification(id);
  const { data: notification, error } = query;
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const { mutate: markRead } = useMarkRead();

  // Opening the page reads the notification — the only door that does, for
  // every kind it is the page of. Keyed on the id and the unread flag, so it
  // fires once per notification shown unread.
  const notificationId = notification?.id;
  const unread = notification ? notification.read_at === null : false;
  useEffect(() => {
    if (notificationId && unread) markRead({ params: { path: { id: notificationId } } });
  }, [notificationId, unread, markRead]);

  // The title waits for the agent names, like the bell's rows: it never shows the raw id first.
  if (isQueryInFlight(query) || agentsLoading) return <NotificationDetailSkeleton />;
  if (error || !notification) return <ResourceErrorState error={error} />;

  const agentNames = new Map(agents?.map((a) => [a.id, a.display_name ?? a.id]));
  const view = describeNotification(notification, (packageId) => agentNames.get(packageId), t);
  const runHref = view.runHref && canReach(view.runHref) ? view.runHref : null;
  const packageHref = view.packageHref && canReach(view.packageHref) ? view.packageHref : null;
  const Icon = KIND_ICON[notification.type];

  return (
    <div className="flex flex-col gap-4">
      <DetailBar
        title={view.title}
        icon={
          <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
            <Icon className="size-5" />
          </span>
        }
        badge={view.status ? <RunStatusBadge status={view.status} /> : undefined}
        trail={[{ label: t("notifications.ariaLabel") }]}
        meta={<span className="truncate">{view.meta}</span>}
        actions={
          (runHref || packageHref) && (
            <>
              {runHref && (
                <HeaderActionButton onClick={() => navigate(runHref)}>
                  {t("notifications.openRun")}
                </HeaderActionButton>
              )}
              {packageHref && (
                <HeaderActionButton onClick={() => navigate(packageHref)}>
                  {t("notifications.openPackage")}
                </HeaderActionButton>
              )}
            </>
          )
        }
      />
      <DetailSectionCard
        title={t(view.message ? "notifications.message" : "notifications.detail")}
        icon={Icon}
      >
        <p className="text-sm break-words whitespace-pre-line">{view.message ?? view.title}</p>
      </DetailSectionCard>
    </div>
  );
}
