// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { CountBadge } from "./count-badge";
import { PendingButton } from "@/components/app-ui/pending-button";
import { RunStatusBadge } from "./status-badge";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Sheet, SheetContent, SheetTrigger } from "@appstrate/ui/components/sheet";
import { Separator } from "@appstrate/ui/components/separator";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { EmptyState, ErrorState } from "./page-states";
import { useUnreadCount, useMarkAllRead, useNotifications } from "../hooks/use-notifications";
import { useCanReachInSpace } from "../hooks/use-can-reach";
import { useAgents } from "../hooks/use-packages";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useSpaces } from "../hooks/use-spaces";
import { useIsMobile } from "@appstrate/ui/use-mobile";
import { notificationHref, notificationRow, type NotificationItem } from "../lib/notification-row";
import { spacesHeld } from "../lib/space-lists";
import { SpaceNameOf } from "./space-name";

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
  currentSpaceId,
  spanning = false,
  onItemClick,
  markAllRead,
  loading = false,
  failed = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  unread: number;
  notifications: NotificationItem[];
  /** A listed agent's display name, from its package id. */
  agentName: (packageId: string) => string | undefined;
  /** Whether a row's page opens, judged in the row's space (`useCanReachInSpace`). */
  canReach: (target: string, spaceId: string | undefined) => boolean;
  /** The working space: a row of another one enters its space on the way. */
  currentSpaceId: string | null;
  /** « Tous les espaces »: each row names its space. */
  spanning?: boolean;
  /** A row was followed; the page it opens marks the notification read. */
  onItemClick: () => void;
  markAllRead: () => void;
  /** The list is still being read: the badge may already say N. */
  loading?: boolean;
  /** The list could not be read. */
  failed?: boolean;
  /** More notifications than the pages read so far. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
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
                {/* A row in « Tous les espaces » names its space on a third line. */}
                {spanning && <Skeleton className="h-4 w-20" />}
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
            const { title, status, message, meta, target } = notificationRow(
              notification,
              agentName,
              (href) => canReach(href, notification.spaceId),
              t,
            );
            const body = (
              <>
                <Circle size={8} className="fill-destructive text-destructive mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{title}</span>
                    {status && <RunStatusBadge status={status} />}
                  </div>
                  {message && (
                    <p className="mb-0.5 line-clamp-3 text-xs break-words whitespace-pre-line">
                      {message}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">{meta}</p>
                  {spanning && (
                    <SpaceNameOf
                      spaceId={notification.spaceId}
                      className="text-muted-foreground mt-1 text-xs"
                    />
                  )}
                </div>
              </>
            );
            return (
              <Link
                key={notification.id}
                to={notificationHref(notification, target, currentSpaceId)}
                onClick={onItemClick}
                className="hover:bg-muted/50 flex w-full gap-3 px-4 py-3 text-left transition-colors"
              >
                {body}
              </Link>
            );
          })}
          {hasMore && (
            <div className="flex justify-center border-t px-4 py-2">
              <PendingButton variant="ghost" size="sm" pending={loadingMore} onClick={onLoadMore}>
                {t("notifications.loadMore")}
              </PendingButton>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function NotificationBell() {
  const { t } = useTranslation("common");
  // « Tous les espaces »: every space the caller holds a role in, as the org routes read them.
  const { on: spanning } = useOverviewMode();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const [open, setOpen] = useState(false);
  // Only the badge's count is read on every page; the rows and the agent names they show are
  // read while the list is open.
  // `isLoading`, not `isPending`: the read is off for a role that sees no agent,
  // and a disabled query stays pending forever.
  const { data: agents, isLoading: agentsLoading } = useAgents({ spanning, enabled: open });
  const { data: count } = useUnreadCount({ spanning });
  const {
    data: notifications,
    isPending: notificationsPending,
    isError: notificationsFailed,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useNotifications({ unread: true, limit: 50, spanning, enabled: open });
  const markAllRead = useMarkAllRead();
  const isMobile = useIsMobile();
  const canReach = useCanReachInSpace();
  const unread = count ?? 0;
  const agentNames = new Map(agents?.map((a) => [a.id, a.display_name ?? a.id]));

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
    agentName: (packageId: string) => agentNames.get(packageId),
    canReach,
    currentSpaceId,
    spanning,
    onItemClick: () => setOpen(false),
    // The spaces the list reads, every one of them.
    markAllRead: () =>
      markAllRead.mutate(spanning ? spacesHeld(spaces).map((space) => space.id) : null),
    // Rows wait for the agent names: a title never shows the raw package id first.
    loading: notificationsPending || agentsLoading,
    failed: notificationsFailed && notifications === undefined,
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    onLoadMore: () => void fetchNextPage(),
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{triggerButton}</SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-xl p-0" showCloseButton={false}>
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
