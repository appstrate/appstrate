// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
import { SidebarNavLink } from "./sidebar-nav-link";
import { useSidebarStore } from "../stores/sidebar-store";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface SettingsNavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  show?: boolean;
}

export interface SettingsSection {
  label?: string;
  items: SettingsNavItem[];
}

interface SettingsLayoutProps {
  sections: SettingsSection[];
  title: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
  /**
   * Map of legacy hash values (without `#`) to destination pathnames.
   * When the current URL has a matching hash, we redirect to the pathname.
   */
  legacyHashRedirects?: Record<string, string>;
}

export function SettingsLayout({
  sections,
  title,
  emoji,
  breadcrumbs,
  legacyHashRedirects,
}: SettingsLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // Auto-collapse the global sidebar while in settings, restore on leave.
  // Uses transient setter so the user's persisted preference is untouched.
  useEffect(() => {
    const { open, setOpenTransient } = useSidebarStore.getState();
    const prev = open;
    setOpenTransient(false);
    return () => {
      useSidebarStore.getState().setOpenTransient(prev);
    };
  }, []);

  // Backwards-compat: redirect old hash URLs (e.g. /preferences#security) to /preferences/security
  useEffect(() => {
    if (!legacyHashRedirects) return;
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const target = legacyHashRedirects[hash];
    if (target && target !== location.pathname) {
      navigate(target, { replace: true });
    }
  }, [location.hash, location.pathname, legacyHashRedirects, navigate]);

  const visibleSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.show !== false) }))
    .filter((s) => s.items.length > 0);

  const allItems = visibleSections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));

  return (
    <SidebarProvider
      disableKeyboardShortcut
      defaultOpen
      className="min-h-0! w-auto flex-1"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      {/* Desktop: real sidebar flush against the global AppSidebar */}
      <Sidebar
        collapsible="none"
        className="bg-sidebar border-sidebar-border text-sidebar-foreground hidden border-r md:flex"
      >
        <SidebarContent>
          {visibleSections.map((section, idx) => (
            <SidebarGroup key={idx}>
              {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
              <SidebarMenu>
                {section.items.map((item) => {
                  const isActive = activeItem?.to === item.to;
                  return (
                    <SidebarNavLink
                      key={item.to}
                      to={item.to}
                      icon={item.icon}
                      label={item.label}
                      isActive={isActive}
                    />
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>

      <SidebarInset className="bg-background min-w-0 p-6">
        <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs} />

        {/* Mobile: dropdown selector (sidebar hidden) */}
        <div className="mb-4 md:hidden">
          <Select
            value={activeItem?.to ?? allItems[0]?.to ?? ""}
            onValueChange={(v) => navigate(v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allItems.map((item) => (
                <SelectItem key={item.to} value={item.to}>
                  <span className="inline-flex items-center gap-2">
                    <item.icon className="size-4" />
                    {item.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
