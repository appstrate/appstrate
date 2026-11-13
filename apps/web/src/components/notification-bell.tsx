// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { CountBadge } from "./count-badge";
import { RunStatusBadge } from "./status-badge";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Sheet, SheetContent, SheetTrigger } from "@appstrate/ui/components/sheet";
import { Separator } from "@appstrate/ui/components/separator";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { EmptyState, ErrorState } from "./page-states";
import {
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  useNotifications,
} from "../hooks/use-notifications";
import { useCanReach } from "../hooks/use-can-reach";
import { useAgents } from "../hooks/use-packages";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import { formatDateField } from "../lib/format-date";
import { catalogueHref } from "../lib/catalogue-link";
import type { paths } from "../api/client";

/** One notification as returned by `GET /api/notifications`. */
type NotificationItem =
  paths["/api/notifications"]["get"]["responses"]["200"]["content"]["application/json"]["data"][number];

/** What a row says and where it leads (`null` when that page is closed to the caller). */
interface NotificationRow {
  title: string;
  status: string | null;
  target: string | null;
}

/**
 * One row per kind. Notifications follow the session's ceiling, not the
 * space's reads, so each target is asked of `canReach`.
 */
function notificationRow(
  notification: NotificationItem,
  agentName: (packageId: string) => string,
  canReach: (target: string) => boolean,
  t: TFunction<["common", "agents"]>,
): NotificationRow {
  if (notification.type === "package_shared") {
    // One share, one decision: open THAT package's sheet, not a list to search.
    const share = notification.payload;
    const href = share ? catalogueHref(share.package_type, { packageId: share.packageId }) : null;
    return {
      title: t("notifications.packageShared", {
        name: share?.shared_by_name ?? "",
        package: share?.packageId ?? "",
      }),
      status: null,
      target: href && canReach(href) ? href : null,
    };
  }
  // A run that needs attention: it failed or timed out.
  const packageId = notification.payload?.packageId ?? null;
  const href =
    packageId && notification.runId ? `/agents/${packageId}/runs/${notification.runId}` : null;
  return {
    title: packageId ? agentName(packageId) : t("runs.deletedAgent", { ns: "agents" }),
    status: notification.payload?.status ?? null,
    target: href && canReach(href) ? href : null,
  };
}

/**
 * The bell's list, exported for the rendering tests: a Radix popover mounts
 * nothing under `renderToStaticMarkup`, so the trigger's chrome is not what a
 * test can look at.
 */
export function NotificationContent({
  unread,
  notifications,
  agentName,
  canReach,
  onItemClick,
  markAllRead,
  loading = false,
  failed = false,
}: {
  unread: number;
  notifications: NotificationItem[];
  /** An agent's display name, from its package id. */
  agentName: (packageId: string) => string;
  canReach: (target: string) => boolean;
  onItemClick: (notificationId: string) => void;
  markAllRead: () => void;
  /** The list is still being read: the badge may already say N. */
  loading?: boolean;
  /** The list could not be read. */
  failed?: boolean;
}) {
  const { t } = useTranslation(["common", "agents"]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold">{t("notifications.ariaLabel")}</h4>
          <CountBadge count={unread} label={t("notifications.ariaLabel")} tone="spark" />
        </div>
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-auto px-2 py-1 text-xs"
            onClick={markAllRead}
          >
            <CheckCheck className="mr-1.5" />
            {t("notifications.markAllRead")}
          </Button>
        )}
      </div>
      <Separator />

      {/* Notification list */}
      {loading ? (
        <div className="divide-y" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3 px-4 py-3">
              <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : failed ? (
        <ErrorState compact />
      ) : notifications.length === 0 ? (
        <EmptyState compact icon={Bell} message={t("notifications.empty")} />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto sm:max-h-96">
          {notifications.map((notification) => {
            const { title, status, target } = notificationRow(notification, agentName, canReach, t);
            const body = (
              <>
                <Circle size={8} className="fill-destructive text-destructive mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{title}</span>
                    {status && <RunStatusBadge status={status} />}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {formatDateField(notification.createdAt)}
                  </p>
                </div>
              </>
            );
            const row = {
              onClick: () => onItemClick(notification.id),
              className:
                "hover:bg-muted/50 flex w-full gap-3 px-4 py-3 text-left transition-colors",
              children: body,
            };
            // Nowhere to go: clicking still marks it read.
            return target ? (
              <Link key={notification.id} to={target} {...row} />
            ) : (
              <button key={notification.id} type="button" {...row} />
            );
          })}
        </div>
      )}
    </>
  );
}

export function NotificationBell() {
  const { t } = useTranslation("common");
  const { data: agents } = useAgents();
  const { data: count } = useUnreadCount();
  const {
    data: notifications,
    isPending: notificationsPending,
    isError: notificationsFailed,
  } = useNotifications({ unread: true, limit: 50 });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const canReach = useCanReach();
  const unread = count ?? 0;
  const agentNames = new Map(agents?.map((a) => [a.id, a.display_name ?? a.id]));

  const handleClick = (notificationId: string) => {
    markRead.mutate({ params: { path: { id: notificationId } } });
    setOpen(false);
  };

  const triggerButton = (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground hover:bg-accent relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 transition-colors"
      aria-label={t("notifications.ariaLabel")}
    >
      <Bell size={18} />
      <CountBadge
        count={unread}
        label={t("notifications.ariaLabel")}
        tone="spark"
        className="absolute -top-1 -right-1"
      />
    </button>
  );

  const contentProps = {
    unread,
    notifications: notifications ?? [],
    agentName: (packageId: string) => agentNames.get(packageId) ?? packageId,
    canReach,
    onItemClick: handleClick,
    markAllRead: () => markAllRead.mutate({}),
    loading: notificationsPending,
    failed: notificationsFailed && notifications === undefined,
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
