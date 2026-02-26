import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";

export function NotificationBell() {
  const { data: count } = useUnreadCount();
  const unread = count ?? 0;

  return (
    <Link to="/executions" className="notification-bell" title="Executions">
      <Bell size={18} />
      {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}
