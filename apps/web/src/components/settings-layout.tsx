// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BreadcrumbEntry } from "./page-header";
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
  label?: React.ReactNode;
  items: SettingsNavItem[];
}

interface SettingsLayoutProps {
  sections: SettingsSection[];
  title: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
}

/**
 * Settings rendered as a Notion-style modal overlaid on the app: a dimmed
 * backdrop, a centered panel with a grouped nav rail (left) and the active
 * settings page (right). The nav links stay within the settings route tree so
 * the modal remains mounted; closing returns to the previous page.
 */
export function SettingsLayout({ sections, title }: SettingsLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  // Closing must escape the settings route tree entirely. `navigate(-1)` is
  // unreliable here because moving between settings pages stacks history
  // entries, so it would just step back through other settings tabs. Returning
  // to the dashboard always dismisses the modal.
  const close = () => {
    navigate("/");
  };

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.show !== false) }))
    .filter((s) => s.items.length > 0);

  const allItems = visibleSections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:items-center sm:p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden />

      {/* Panel */}
      <div className="bg-card text-card-foreground relative z-10 flex h-full w-full max-w-[1120px] overflow-hidden border shadow-2xl sm:h-[86vh] sm:max-h-[780px] sm:rounded-xl">
        {/* Nav rail (desktop) */}
        <aside className="bg-muted/40 border-border hidden w-[260px] shrink-0 flex-col overflow-y-auto border-r px-3 py-4 md:flex">
          {visibleSections.map((section, idx) => (
            <div key={idx} className={idx === 0 ? "" : "mt-4"}>
              {section.label && (
                <div className="text-muted-foreground px-2.5 pb-1 text-[0.72rem] font-semibold tracking-wide">
                  {section.label}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const isActive = activeItem?.to === item.to;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-foreground/[0.08] text-foreground"
                          : "text-foreground hover:bg-foreground/[0.05]",
                      )}
                    >
                      <item.icon
                        className={cn(
                          "size-[17px] shrink-0",
                          isActive ? "text-foreground" : "text-muted-foreground",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>

        {/* Content */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-muted-foreground hover:bg-accent hover:text-foreground absolute top-4 right-4 z-10 flex size-8 items-center justify-center rounded-md transition-colors"
          >
            <X className="size-[18px]" />
          </button>

          <div className="mx-auto w-full max-w-[760px] p-6 pt-7 sm:p-10">
            <h1 className="mb-1 text-2xl font-bold tracking-tight">
              {activeItem?.label ?? title}
            </h1>

            {/* Mobile section selector (nav rail hidden) */}
            <div className="mt-4 mb-2 md:hidden">
              <Select value={activeItem?.to ?? allItems[0]?.to ?? ""} onValueChange={(v) => navigate(v)}>
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

            <div className="mt-5">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
