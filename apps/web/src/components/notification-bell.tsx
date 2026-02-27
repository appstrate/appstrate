import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";
import { useFlows } from "../hooks/use-flows";

export function NotificationBell() {
  const { data: count } = useUnreadCount();
  const { data: flows } = useFlows();
  const unread = count ?? 0;
  const hasRunning = flows?.some((f) => f.runningExecutions > 0) ?? false;

  const className = ["notification-bell", hasRunning && unread === 0 ? "is-running" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <Link to="/executions" className={className} title="Executions">
      <Bell size={18} />
      {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}
