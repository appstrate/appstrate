// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./status-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  useNotifications,
} from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { useIsMobile } from "../hooks/use-mobile";
import { formatDateField } from "../lib/markdown";

/** One notification as returned by `GET /api/notifications`. */
type NotificationItem = {
  id: string;
  run_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

/** Narrow a jsonb payload field to a string. */
function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key];
  return typeof v === "string" ? v : null;
}

function NotificationContent({
  unread,
  notifications,
  agentNameMap,
  onItemClick,
  onClose,
  markAllRead,
}: {
  unread: number;
  notifications: NotificationItem[];
  agentNameMap: Map<string, string>;
  onItemClick: (notificationId: string) => void;
  onClose: () => void;
  markAllRead: () => void;
}) {
  const { t } = useTranslation(["common", "agents"]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold">{t("notifications.title")}</h4>
          {unread > 0 && (
            <span className="bg-destructive text-destructive-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium">
              {unread}
            </span>
          )}
        </div>
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-auto px-2 py-1 text-xs"
            onClick={markAllRead}
          >
            <CheckCheck size={14} className="mr-1.5" />
            {t("notifications.markAllRead")}
          </Button>
        )}
      </div>
      <Separator />

      {/* Notification list */}
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-4 py-10">
          <Bell size={32} className="text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm">{t("notifications.empty")}</p>
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto sm:max-h-96">
          {notifications.map((notification) => {
            const agentId = payloadString(notification.payload, "agent_id");
            const status = payloadString(notification.payload, "status");
            const displayName = agentId
              ? (agentNameMap.get(agentId) ?? agentId)
              : t("runs.deletedAgent", { ns: "agents" });
            // Source agent gone → fall back to the run-scoped route. Marking
            // it read still flows through `onItemClick`.
            const linkTarget =
              agentId && notification.run_id
                ? `/agents/${agentId}/runs/${notification.run_id}`
                : notification.run_id
                  ? `/runs/${notification.run_id}`
                  : "/runs";
            return (
              <Link
                key={notification.id}
                to={linkTarget}
                onClick={() => onItemClick(notification.id)}
                className="hover:bg-muted/50 group flex gap-3 px-4 py-3 transition-colors"
              >
                <Circle size={8} className="fill-destructive text-destructive mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{displayName}</span>
                    {status && <Badge status={status} />}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {formatDateField(notification.created_at)}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <Separator />
      <div className="p-2">
        <Link
          to="/runs"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center justify-center rounded-md py-2 text-xs font-medium transition-colors"
        >
          {t("notifications.viewAll")}
        </Link>
      </div>
    </>
  );
}

export function NotificationBell() {
  const { t } = useTranslation(["common", "agents"]);
  const { data: count } = useUnreadCount();
  const { data: agents } = useAgents();
  const { data: notifications } = useNotifications({ unread: true, limit: 50 });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const unread = count ?? 0;
  const hasRunning = agents?.some((f) => f.running_runs > 0) ?? false;

  const agentNameMap = new Map<string, string>();
  if (agents) {
    for (const f of agents) agentNameMap.set(f.id, f.display_name ?? f.id);
  }

  const notificationItems = notifications ?? [];

  const handleClick = (notificationId: string) => {
    markRead.mutate({ params: { path: { id: notificationId } } });
    setOpen(false);
  };

  const triggerButton = (
    <button
      type="button"
      className={cn(
        "text-muted-foreground hover:text-foreground hover:bg-accent relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 transition-colors",
        hasRunning && unread === 0 && "text-primary animate-pulse",
      )}
      aria-label={t("notifications.ariaLabel")}
    >
      <Bell size={18} />
      {unread > 0 && (
        <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );

  const contentProps = {
    unread,
    notifications: notificationItems,
    agentNameMap,
    onItemClick: handleClick,
    onClose: () => setOpen(false),
    markAllRead: () => markAllRead.mutate({}),
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{triggerButton}</SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-xl p-0 [&>button:last-child]:hidden">
          <NotificationContent {...contentProps} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <NotificationContent {...contentProps} />
      </PopoverContent>
    </Popover>
  );
}
