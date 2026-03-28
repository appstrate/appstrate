import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  useUnreadCount,
  useAllExecutions,
  useMarkRead,
  useMarkAllRead,
} from "../hooks/use-notifications";
import { useFlows } from "../hooks/use-packages";
import { formatDateField } from "../lib/markdown";

export function NotificationBell() {
  const { t } = useTranslation(["common", "flows"]);
  const { data: count } = useUnreadCount();
  const { data: flows } = useFlows();
  const { data: executionsData } = useAllExecutions(0, 50);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const [open, setOpen] = useState(false);
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "relative inline-flex items-center justify-center size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer",
            hasRunning && unread === 0 && "text-primary animate-pulse",
          )}
          aria-label={t("notifications.ariaLabel")}
        >
          <Bell size={18} />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">{t("notifications.title")}</h4>
            {unread > 0 && (
              <span className="flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-medium">
                {unread}
              </span>
            )}
          </div>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck size={14} className="mr-1.5" />
              {t("notifications.markAllRead")}
            </Button>
          )}
        </div>
        <Separator />

        {/* Notification list */}
        {unreadExecutions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <Bell size={32} className="text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">{t("notifications.empty")}</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {unreadExecutions.map((execution) => (
              <Link
                key={execution.id}
                to={`/flows/${execution.packageId}/executions/${execution.id}`}
                onClick={() => handleClick(execution.id)}
                className="flex gap-3 px-4 py-3 hover:bg-muted/50 transition-colors group"
              >
                <Circle
                  size={8}
                  className="mt-1.5 shrink-0 fill-destructive text-destructive"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-sm font-medium truncate">
                      {flowNameMap.get(execution.packageId) ?? execution.packageId}
                    </span>
                    <Badge status={execution.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">
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
            onClick={() => setOpen(false)}
            className="flex items-center justify-center rounded-md py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            {t("notifications.viewAll")}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
