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
  useAllExecutions,
  useMarkRead,
  useMarkAllRead,
} from "../hooks/use-notifications";
import { useFlows } from "../hooks/use-packages";
import { useIsMobile } from "../hooks/use-mobile";
import type { Execution } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";

function NotificationContent({
  unread,
  unreadExecutions,
  flowNameMap,
  onItemClick,
  onClose,
  markAllRead,
}: {
  unread: number;
  unreadExecutions: Pick<Execution, "id" | "packageId" | "status" | "startedAt">[];
  flowNameMap: Map<string, string>;
  onItemClick: (executionId: string) => void;
  onClose: () => void;
  markAllRead: () => void;
}) {
  const { t } = useTranslation(["common", "flows"]);

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
      {unreadExecutions.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-4 py-10">
          <Bell size={32} className="text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm">{t("notifications.empty")}</p>
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto sm:max-h-96">
          {unreadExecutions.map((execution) => (
            <Link
              key={execution.id}
              to={`/flows/${execution.packageId}/executions/${execution.id}`}
              onClick={() => onItemClick(execution.id)}
              className="hover:bg-muted/50 group flex gap-3 px-4 py-3 transition-colors"
            >
              <Circle size={8} className="fill-destructive text-destructive mt-1.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {flowNameMap.get(execution.packageId) ?? execution.packageId}
                  </span>
                  <Badge status={execution.status} />
                </div>
                <p className="text-muted-foreground text-xs">
                  {execution.startedAt ? formatDateField(execution.startedAt) : ""}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Footer */}
      <Separator />
      <div className="p-2">
        <Link
          to="/executions"
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
  const { t } = useTranslation(["common", "flows"]);
  const { data: count } = useUnreadCount();
  const { data: flows } = useFlows();
  const { data: executionsData } = useAllExecutions(0, 50);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const unread = count ?? 0;
  const hasRunning = flows?.some((f) => f.runningExecutions > 0) ?? false;

  const flowNameMap = new Map<string, string>();
  if (flows) {
    for (const f of flows) flowNameMap.set(f.id, f.displayName);
  }

  const unreadExecutions =
    executionsData?.executions.filter((e) => e.notifiedAt != null && e.readAt == null) ?? [];

  const handleClick = (executionId: string) => {
    markRead.mutate(executionId);
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
    unreadExecutions,
    flowNameMap,
    onItemClick: handleClick,
    onClose: () => setOpen(false),
    markAllRead: () => markAllRead.mutate(),
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
