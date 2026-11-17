// SPDX-License-Identifier: Apache-2.0

/**
 * A notification's own page (`/notifications/:id`), where the bell leads every
 * kind but a failed run: opening it marks the notification read.
 */

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { DetailBar } from "../components/detail-bar";
import { DetailSectionCard } from "../components/detail-section-card";
import { HeaderActionButton } from "../components/header-action-button";
import { NotificationDetailSkeleton } from "../components/loading-skeletons";
import { ResourceErrorState } from "../components/page-states";
import { RunStatusBadge } from "../components/status-badge";
import { notificationRow } from "../lib/notification-row";
import { useMarkRead, useNotification } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { useCanReach } from "../hooks/use-can-reach";
import { isQueryInFlight } from "../lib/query-state";

export function NotificationDetailPage() {
  const { t } = useTranslation(["common", "agents"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const canReach = useCanReach();
  const query = useNotification(id);
  const { data: notification, error } = query;
  const { data: agents, isLoading: agentsLoading } = useAgents();
  const { mutate: markRead } = useMarkRead();

  // Opening the page reads the notification, once per notification shown unread.
  const notificationId = notification?.id;
  const unread = notification?.read_at === null;
  useEffect(() => {
    if (notificationId && unread) markRead({ params: { path: { id: notificationId } } });
  }, [notificationId, unread, markRead]);

  // The title waits for the agent names, like the bell's rows: it never shows the raw id first.
  if (isQueryInFlight(query) || agentsLoading) return <NotificationDetailSkeleton />;
  if (error || !notification) return <ResourceErrorState error={error} />;

  const agentNames = new Map(agents?.map((a) => [a.id, a.display_name ?? a.id]));
  const view = notificationRow(notification, (packageId) => agentNames.get(packageId), canReach, t);

  return (
    <div className="flex flex-col gap-4">
      <DetailBar
        title={view.title}
        icon={
          <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
            <Bell className="size-5" />
          </span>
        }
        badge={view.status ? <RunStatusBadge status={view.status} /> : undefined}
        trail={[{ label: t("notifications.ariaLabel") }]}
        meta={<span className="truncate">{view.meta}</span>}
        actions={
          view.target && (
            <HeaderActionButton onClick={() => navigate(view.target!)}>
              {t(notification.runId ? "notifications.openRun" : "notifications.openPackage")}
            </HeaderActionButton>
          )
        }
      />
      <DetailSectionCard title={t("notifications.message")} icon={Bell}>
        <p className="text-sm break-words whitespace-pre-line">{view.message ?? view.title}</p>
      </DetailSectionCard>
    </div>
  );
}
