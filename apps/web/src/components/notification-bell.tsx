// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { CountBadge } from "./count-badge";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Sheet, SheetContent, SheetTrigger } from "@appstrate/ui/components/sheet";
import { Separator } from "@appstrate/ui/components/separator";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { EmptyState, ErrorState } from "./page-states";
import {
  BELL_NOTIFICATION_TYPE,
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  useNotifications,
} from "../hooks/use-notifications";
import { useCanReach } from "../hooks/use-can-reach";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import { formatDateField } from "../lib/format-date";
import { catalogueHref } from "../lib/catalogue-link";
import type { paths } from "../api/client";

/** One notification as returned by `GET /api/notifications`. */
type NotificationItem =
  paths["/api/notifications"]["get"]["responses"]["200"]["content"]["application/json"]["data"][number];

/** The bell lists shares only: a finished run is on the runs page, unread dot included. */
type ShareNotification = Extract<NotificationItem, { type: "package_shared" }>;

function isShare(notification: NotificationItem): notification is ShareNotification {
  return notification.type === "package_shared";
}

/**
 * Where a share leads, or `null` when that page is closed to the caller:
 * notifications follow the session's ceiling, not the space's reads.
 */
function shareTarget(
  notification: ShareNotification,
  canReach: (target: string) => boolean,
): string | null {
  // One share, one decision: open THAT package's sheet, not a list to search.
  const share = notification.payload;
  if (!share) return null;
  const href = catalogueHref(share.package_type, { packageId: share.packageId });
  return canReach(href) ? href : null;
}

/**
 * The bell's list, exported for the rendering tests: a Radix popover mounts
 * nothing under `renderToStaticMarkup`, so the trigger's chrome is not what a
 * test can look at.
 */
export function NotificationContent({
  unread,
  notifications,
  canReach,
  onItemClick,
  markAllRead,
  loading = false,
  failed = false,
}: {
  unread: number;
  notifications: NotificationItem[];
  canReach: (target: string) => boolean;
  onItemClick: (notificationId: string) => void;
  markAllRead: () => void;
  /** The list is still being read: the badge may already say N. */
  loading?: boolean;
  /** The list could not be read. */
  failed?: boolean;
}) {
  const { t } = useTranslation("common");
  const shares = notifications.filter(isShare);

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
      ) : shares.length === 0 ? (
        <EmptyState compact icon={Bell} message={t("notifications.empty")} />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto sm:max-h-96">
          {shares.map((notification) => {
            const target = shareTarget(notification, canReach);
            const body = (
              <>
                <Circle size={8} className="fill-destructive text-destructive mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className="mb-0.5 block truncate text-sm font-medium">
                    {t("notifications.packageShared", {
                      name: notification.payload?.shared_by_name ?? "",
                      package: notification.payload?.packageId ?? "",
                    })}
                  </span>
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
  const { data: count } = useUnreadCount(BELL_NOTIFICATION_TYPE);
  const {
    data: notifications,
    isPending: notificationsPending,
    isError: notificationsFailed,
  } = useNotifications({ type: BELL_NOTIFICATION_TYPE, unread: true, limit: 50 });
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const canReach = useCanReach();
  const unread = count ?? 0;

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
    canReach,
    onItemClick: handleClick,
    markAllRead: () => markAllRead.mutate({ params: { query: { type: BELL_NOTIFICATION_TYPE } } }),
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
