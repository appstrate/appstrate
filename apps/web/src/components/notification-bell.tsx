import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUnreadCount } from "../hooks/use-notifications";
import { useFlows } from "../hooks/use-packages";

export function NotificationBell() {
  const { data: count } = useUnreadCount();
  const { data: flows } = useFlows();
  const unread = count ?? 0;
  const hasRunning = flows?.some((f) => f.runningExecutions > 0) ?? false;

  return (
    <Link
      to="/executions"
      className={cn(
        "relative inline-flex items-center justify-center size-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
        hasRunning && unread === 0 && "text-primary animate-pulse",
      )}
      title="Executions"
    >
      <Bell size={18} />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
