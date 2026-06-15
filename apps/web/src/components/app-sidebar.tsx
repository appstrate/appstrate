// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Activity,
  Calendar,
  Layers,
  Wrench,
  Plug,
  Boxes,
  LifeBuoy,
  Users,
  Webhook,
  PanelLeft,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUnreadCount } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { usePermissions } from "../hooks/use-permissions";
import { useAppConfig } from "../hooks/use-app-config";
import { useSidebarStore } from "../stores/sidebar-store";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  external?: boolean;
}

/** The nav groups + items. Shared by the desktop rail and the mobile drawer. */
export function SidebarNavList({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  const { data: unreadCount } = useUnreadCount();
  const { data: agents } = useAgents();
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const { data: runningInline } = usePaginatedRuns({
    kind: "inline",
    status: "running",
    limit: 1,
    offset: 0,
  });

  const runningCount =
    (agents?.reduce((n, a) => n + (a.running_runs ?? 0), 0) ?? 0) + (runningInline?.total ?? 0);
  const unread = unreadCount ?? 0;

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: t("nav.sectionActivity", { defaultValue: "Activité" }),
      items: [
        { to: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
        { to: "/runs", label: t("nav.runs"), icon: Activity },
        { to: "/schedules", label: t("nav.schedules"), icon: Calendar },
      ],
    },
    {
      label: t("nav.sectionBuild", { defaultValue: "Construire" }),
      items: [
        { to: "/agents", label: t("nav.agents"), icon: Layers },
        { to: "/skills", label: t("nav.skills"), icon: Wrench },
        { to: "/mcp-servers", label: t("nav.mcpServers"), icon: Plug },
        { to: "/integrations", label: t("nav.integrations"), icon: Boxes },
      ],
    },
    ...(isAdmin
      ? [
          {
            label: t("nav.sectionAdmin"),
            items: [
              ...(features.webhooks
                ? [{ to: "/webhooks", label: t("nav.webhooks"), icon: Webhook }]
                : []),
              { to: "/end-users", label: t("nav.endUsers"), icon: Users },
            ] as NavItem[],
          },
        ]
      : []),
    {
      label: t("nav.sectionResources"),
      items: [
        {
          to: "/api/docs",
          label: t("nav.help", { defaultValue: "Aide et ressources" }),
          icon: LifeBuoy,
          external: true,
        },
      ],
    },
  ];

  const isActive = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));

  const NavLink = ({ item }: { item: NavItem }) => {
    const active = !item.external && isActive(item.to);
    const showRunning = item.to === "/runs" && runningCount > 0;
    const showUnread = item.to === "/runs" && runningCount === 0 && unread > 0;
    const inner = (
      <>
        {showRunning ? (
          <Loader2 className="text-primary size-[18px] shrink-0 animate-spin" />
        ) : (
          <item.icon
            className={cn(
              "size-[18px] shrink-0",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          />
        )}
        {!collapsed && <span className="flex-1 truncate text-left">{item.label}</span>}
        {!collapsed && showUnread && (
          <span className="bg-spark text-spark-foreground flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] px-1.5 text-[0.66rem] font-semibold">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </>
    );
    const className = cn(
      "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
      collapsed && "justify-center px-2",
      active
        ? "bg-foreground/[0.08] text-foreground font-semibold"
        : "text-foreground hover:bg-foreground/[0.05]",
    );
    if (item.external) {
      return (
        <a
          href={item.to}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
          title={collapsed ? item.label : undefined}
          onClick={onNavigate}
        >
          {inner}
        </a>
      );
    }
    return (
      <Link
        to={item.to}
        className={className}
        title={collapsed ? item.label : undefined}
        onClick={onNavigate}
      >
        {inner}
      </Link>
    );
  };

  return (
    <nav className="flex-1 overflow-y-auto px-2.5 py-3">
      {groups.map((g, i) => (
        <div key={i} className={i === 0 ? "" : "mt-2"}>
          {!collapsed && (
            <div className="text-muted-foreground/80 px-2.5 pt-3 pb-1.5 text-[0.68rem] font-semibold tracking-wide">
              {g.label}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {g.items.map((item) => (
              <NavLink key={item.to} item={item} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Desktop sidebar rail (hidden below `md`; the mobile drawer takes over). */
export function AppSidebar() {
  const { t } = useTranslation();
  const { open, setOpen } = useSidebarStore();
  const collapsed = !open;

  return (
    <aside
      className={cn(
        "bg-sidebar hidden shrink-0 flex-col transition-[width] duration-200 md:flex",
        collapsed ? "md:w-[68px]" : "md:w-[246px]",
      )}
    >
      <SidebarNavList collapsed={collapsed} />
      <div
        className={cn(
          "border-border flex items-center border-t px-2.5 py-1.5",
          collapsed && "justify-center",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={
            collapsed
              ? t("sidebar.expand", { defaultValue: "Déplier" })
              : t("sidebar.collapse", { defaultValue: "Replier" })
          }
          className="text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground flex size-8 items-center justify-center rounded-md transition-colors"
        >
          <PanelLeft className="size-[18px]" />
        </button>
      </div>
    </aside>
  );
}
