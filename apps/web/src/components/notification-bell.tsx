import { Link } from "react-router-dom";
import { useUnreadCount } from "../hooks/use-notifications";

export function NotificationBell() {
  const { data: count } = useUnreadCount();
  const unread = count ?? 0;

  return (
    <Link to="/executions" className="notification-bell" title="Executions">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}
