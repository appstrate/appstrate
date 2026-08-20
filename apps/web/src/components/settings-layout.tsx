// SPDX-License-Identifier: Apache-2.0

/**
 * Settings surface: a rail of sections plus the active page.
 *
 * Presented as an overlay when opened from inside the app, as a full page when
 * reached by a cold link or a reload — `useIsModalRoute` decides, the route
 * tree is the same either way.
 *
 * The nested `SidebarProvider` this used to build is gone, and with it the
 * side-effect that made it worth removing: entering settings collapsed the
 * app's own sidebar and restored it on the way out, so the shell moved under
 * the user because they had clicked a link. As an overlay nothing underneath
 * moves at all.
 */
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
import { AppVersion } from "./app-version";
import { PanelDialog } from "./panel-dialog";
import { openAsModal, useIsModalRoute, useBackgroundLocation } from "../lib/modal-route";
import { cn } from "@appstrate/ui/cn";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

export interface SettingsNavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  show?: boolean;
}

export interface SettingsSection {
  label?: React.ReactNode;
  items: SettingsNavItem[];
}

interface SettingsLayoutProps {
  sections: SettingsSection[];
  title: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
}

function RailLink({
  to,
  icon: Icon,
  label,
  isActive,
  state,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  state?: unknown;
}) {
  return (
    <Link
      to={to}
      state={state}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

export function SettingsLayout({ sections, title, emoji, breadcrumbs }: SettingsLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const asModal = useIsModalRoute();
  const background = useBackgroundLocation();

  const visibleSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.show !== false) }))
    .filter((s) => s.items.length > 0);

  const allItems = visibleSections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));

  const rail = (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          {emoji && <span aria-hidden>{emoji}</span>}
          {title}
        </h2>
      </div>
      <div className="flex-1 px-2">
        {visibleSections.map((section, idx) => (
          <div key={idx} className="py-1">
            {section.label && (
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                {section.label}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <RailLink
                  key={item.to}
                  to={item.to}
                  icon={item.icon}
                  label={item.label}
                  isActive={activeItem?.to === item.to}
                  // Keep the same screen underneath while moving between
                  // sections; without this every section click would close the
                  // overlay and navigate for real.
                  state={background ? openAsModal(background) : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 py-3">
        <AppVersion />
      </div>
    </div>
  );

  // Same items, one line high. Grouped so the sections survive the collapse.
  const mobileNav = (
    <Select
      value={activeItem?.to ?? allItems[0]?.to ?? ""}
      onValueChange={(to) =>
        navigate(to, { state: background ? openAsModal(background) : undefined })
      }
    >
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {visibleSections.map((section, idx) => (
          <SelectGroup key={idx}>
            {section.label && <SelectLabel>{section.label}</SelectLabel>}
            {section.items.map((item) => (
              <SelectItem key={item.to} value={item.to}>
                <span className="inline-flex items-center gap-2">
                  <item.icon className="size-4" />
                  {item.label}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );

  if (asModal) {
    return (
      <PanelDialog
        title={title}
        rail={rail}
        mobileNav={mobileNav}
        onClose={() => navigate(background?.pathname ?? "/", { replace: true })}
      >
        {activeItem && <h3 className="mb-4 text-lg font-semibold">{activeItem.label}</h3>}
        <Outlet />
      </PanelDialog>
    );
  }

  return (
    <div data-full-bleed className="flex h-[calc(100dvh-var(--spacing-header))] min-h-0">
      <aside className="bg-sidebar border-sidebar-border w-56 shrink-0 overflow-y-auto border-r max-sm:hidden">
        {rail}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs} />
        <div className="mb-4 sm:hidden">{mobileNav}</div>
        <Outlet />
      </div>
    </div>
  );
}
