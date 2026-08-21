// SPDX-License-Identifier: Apache-2.0

/**
 * Settings surface: a rail of sections plus the active page, always as an
 * overlay.
 *
 * There is no page-shaped variant. A settings URL opened cold falls back to the
 * dashboard underneath (see `app.tsx`), so this renders one way in every case —
 * which is the point: a second rendering of the same screens is a second thing
 * to keep looking like the first.
 *
 * Every group carries its label, including a surface that has only one. The
 * label states the KIND where the head only gives the NAME — "Tractr" alone
 * does not say it is an organisation — and it keeps the three surfaces built
 * the same way, which matters more than sparing one line inside any one of
 * them.
 *
 * The rail's head is the org/workspace chip rather than a page title. The title
 * only ever repeated the entry already highlighted below it, while the question
 * it left unanswered — WHICH organisation, WHICH workspace am I configuring —
 * is the one that matters once the two surfaces look alike.
 */
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { AppVersion } from "./app-version";
import { PanelDialog } from "./panel-dialog";
import { openAsModal, useBackgroundLocation } from "../lib/modal-route";
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
  /** Announced to screen readers, and shown as the rail's scope name. */
  title: string;
  /**
   * What these settings configure. The rail head reads "Paramètres" over this
   * NAME; which kind of thing it is comes from the section label below, where
   * it also does the work of separating one group from the next. Putting the
   * kind in both places just said the same word twice.
   */
  scope: { icon: LucideIcon; name: string };
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

export function SettingsLayout({ sections, title, scope }: SettingsLayoutProps) {
  const { t } = useTranslation("common");
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();

  const visibleSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.show !== false) }))
    .filter((s) => s.items.length > 0);

  const allItems = visibleSections.flatMap((s) => s.items);
  const activeItem =
    allItems.find((i) => location.pathname === i.to) ??
    allItems.find((i) => location.pathname.startsWith(i.to + "/"));

  // Keep the same screen underneath while moving between sections; without it
  // every rail click would close the overlay and navigate for real.
  const keepOverlay = background ? openAsModal(background) : undefined;

  const rail = (
    <div className="flex h-full flex-col">
      <div className="border-sidebar-border flex items-center gap-2.5 border-b px-4 py-3">
        <scope.icon className="text-muted-foreground size-4 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="text-muted-foreground text-[0.7rem] tracking-[0.04em] uppercase">
            {t("nav.settings", { ns: "common" })}
          </span>
          <span className="truncate text-sm font-semibold">{scope.name}</span>
        </span>
      </div>
      <div className="flex-1 px-2 py-1">
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
                  state={keepOverlay}
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
      onValueChange={(to) => navigate(to, { state: keepOverlay })}
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

  return (
    <PanelDialog
      title={title}
      rail={rail}
      mobileNav={mobileNav}
      onClose={() => navigate(background?.pathname ?? "/", { replace: true })}
    >
      {activeItem && <h3 className="mb-6 text-lg font-semibold">{activeItem.label}</h3>}
      <Outlet />
    </PanelDialog>
  );
}
