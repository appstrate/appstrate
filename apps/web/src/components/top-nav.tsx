// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronsUpDown,
  Check,
  Plus,
  Star,
  Settings,
  Library,
  Grid3x3,
  LogOut,
  FileText,
  Palette,
  Menu,
  Search,
} from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useAuth } from "../hooks/use-auth";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, useAppSwitcher } from "../hooks/use-current-application";
import { usePermissions } from "../hooks/use-permissions";
import { useTheme } from "../stores/theme-store";
import { themeOptions } from "../lib/theme";
import { GlobalSearch } from "./global-search";
import { NotificationBell } from "./notification-bell";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Maps the current path to a breadcrumb label shown in the top nav. */
function usePageCrumb(): string {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  if (pathname === "/") return t("nav.dashboard");
  if (pathname.startsWith("/agents")) return t("nav.agents");
  if (pathname.startsWith("/runs")) return t("nav.runs");
  if (pathname.startsWith("/schedules")) return t("nav.schedules");
  if (pathname.startsWith("/skills")) return t("nav.skills");
  if (pathname.startsWith("/mcp-servers")) return t("nav.mcpServers");
  if (pathname.startsWith("/integrations")) return t("nav.integrations");
  if (pathname.startsWith("/library")) return t("nav.library");
  if (pathname.startsWith("/org-settings")) return t("nav.settings");
  if (pathname.startsWith("/preferences")) return t("userMenu.preferences");
  return "";
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

function OrgWsSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg } = useOrg();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  if (!currentOrg) return null;

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;
  const query = q.trim().toLowerCase();
  const orgList = orgs.filter((o) => !query || o.name.toLowerCase().includes(query));
  const appList = (applications ?? []).filter((a) => !query || a.name.toLowerCase().includes(query));

  const roleLabel = (role?: string) =>
    role === "owner"
      ? t("switcher.roleOwner", { defaultValue: "Propriétaire" })
      : role === "admin"
        ? t("switcher.roleAdmin", { defaultValue: "Admin" })
        : t("switcher.roleMember", { defaultValue: "Membre" });

  const close = () => {
    setOpen(false);
    setQ("");
  };

  const colLabel =
    "text-muted-foreground px-2 pt-1.5 pb-1 text-[0.72rem] font-semibold tracking-wide uppercase";
  const addLink =
    "text-muted-foreground hover:text-primary inline-flex items-center gap-1 pr-2 text-[0.78rem] hover:underline";

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="org-switcher-button"
          className="border-border hover:bg-accent flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors"
        >
          <span
            className="bg-spark text-spark-foreground flex size-[22px] shrink-0 items-center justify-center rounded-md text-[0.72rem] font-bold"
            aria-hidden
          >
            {currentOrg.name.charAt(0).toUpperCase()}
          </span>
          <span className="max-w-[12ch] truncate">{currentOrg.name}</span>
          {currentApp && (
            <>
              <span className="text-border">|</span>
              <span className="text-muted-foreground max-w-[12ch] truncate">{currentApp.name}</span>
            </>
          )}
          <ChevronsUpDown className="text-muted-foreground size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[540px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl p-0"
      >
        {/* Search */}
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search.placeholder", { defaultValue: "Rechercher…" })}
            className="placeholder:text-muted-foreground w-full border-0 bg-transparent p-0 text-sm outline-none focus:ring-0"
          />
        </div>

        {/* Two columns: organisations | workspaces */}
        <div className="grid grid-cols-2">
          <div className="p-1.5">
            <div className="flex items-center justify-between">
              <span className={colLabel}>
                {t("switcher.orgsLabel", { defaultValue: "Vos organisations" })}
              </span>
              <Link
                to="/onboarding/create"
                state={{ fromSwitcher: true }}
                onClick={close}
                className={addLink}
              >
                {t("switcher.add", { defaultValue: "Ajouter" })} <Plus className="size-3" />
              </Link>
            </div>
            {orgList.map((o) => {
              const sel = o.id === currentOrg.id;
              return (
                <button
                  key={o.id}
                  data-testid={`org-item-${o.id}`}
                  onClick={() => {
                    if (!sel) switchOrg(o.id);
                    close();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors",
                    sel ? "bg-spark-soft" : "hover:bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-[30px] shrink-0 items-center justify-center rounded-lg text-[0.82rem] font-bold text-white",
                      sel ? "bg-spark" : "bg-muted-foreground/60",
                    )}
                  >
                    {o.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.88rem] font-medium">{o.name}</span>
                    <span className="text-muted-foreground block text-[0.72rem]">
                      {roleLabel((o as { role?: string }).role)}
                    </span>
                  </span>
                  {sel && <Settings className="text-muted-foreground size-[15px] shrink-0" />}
                </button>
              );
            })}
          </div>

          <div className="border-border border-l p-1.5">
            <div className="flex items-center justify-between">
              <span className={colLabel}>
                {t("switcher.appsLabel", { defaultValue: "Espaces de travail" })}
              </span>
              {isAdmin && (
                <Link to="/org-settings/applications" onClick={close} className={addLink}>
                  {t("switcher.add", { defaultValue: "Ajouter" })} <Plus className="size-3" />
                </Link>
              )}
            </div>
            {appList.map((a) => {
              const sel = a.id === currentAppId;
              return (
                <button
                  key={a.id}
                  data-testid={`app-item-${a.id}`}
                  onClick={() => {
                    if (!sel) switchApp(a.id);
                    close();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors",
                    sel ? "bg-primary-soft" : "hover:bg-accent",
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[0.88rem] font-medium">{a.name}</span>
                    {a.isDefault && <Star className="size-3 shrink-0 fill-amber-500 text-amber-500" />}
                  </span>
                  {sel && <Settings className="text-muted-foreground size-[15px] shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        {isAdmin && (
          <div className="border-border grid grid-cols-2 border-t">
            <Link
              to="/org-settings"
              onClick={close}
              className="hover:bg-accent flex items-center gap-2 px-3 py-2.5 text-[0.84rem] font-medium"
            >
              <Settings className="text-muted-foreground size-[15px] shrink-0" />
              <span className="truncate">{t("nav.settings")}</span>
            </Link>
            <Link
              to="/library"
              onClick={close}
              className="border-border hover:bg-accent flex items-center gap-2 border-l px-3 py-2.5 text-[0.84rem] font-medium"
            >
              <Library className="text-muted-foreground size-[15px] shrink-0" />
              {t("nav.library")}
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { user, profile, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();

  if (!user) return null;

  const displayName = profile?.displayName || user.email || "";

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("userMenu.ariaLabel")}
          className="bg-spark text-spark-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-[0.78rem] font-bold"
        >
          {initials(displayName)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-56 rounded-xl">
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5">
            <span className="bg-spark text-spark-foreground flex size-8 items-center justify-center rounded-full text-[0.78rem] font-bold">
              {initials(displayName)}
            </span>
            <div className="grid flex-1 leading-tight">
              <span className="truncate text-sm font-semibold">{displayName}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/preferences" className="gap-2">
            <Settings className="size-3.5" /> {t("userMenu.preferences")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2">
            <Palette className="size-3.5" /> {t("userMenu.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {themeOptions.map(({ value, labelKey, icon: Icon }) => (
              <DropdownMenuItem key={value} onSelect={() => setTheme(value)} className="gap-2">
                <Icon className="size-3.5" />
                {t(labelKey)}
                {theme === value && <Check className="text-primary ml-auto size-3.5" strokeWidth={2.5} />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem asChild>
          <a href="/api/docs" target="_blank" rel="noopener noreferrer" className="gap-2">
            <FileText className="size-3.5" /> {t("userMenu.apiDocs")}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleLogout()} className="gap-2">
          <LogOut className="size-3.5" /> {t("userMenu.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopNav({ onMenuClick }: { onMenuClick?: () => void }) {
  const { resolvedTheme } = useTheme();
  const crumb = usePageCrumb();

  return (
    <header className="bg-sidebar flex h-14 min-w-0 shrink-0 items-center gap-1 pr-3 sm:gap-2">
      {/* Hamburger — opens the nav drawer below `md` */}
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Menu"
        className="text-foreground hover:bg-accent ml-1.5 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors md:hidden"
      >
        <Menu className="size-5" />
      </button>

      {/* Brand — aligns over the sidebar column on desktop, logo-only on mobile */}
      <Link
        to="/"
        className="flex h-full shrink-0 items-center gap-2 px-2 md:w-[246px] md:px-3.5"
      >
        <img
          src={resolvedTheme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
          alt="Appstrate"
          className="h-6 w-auto"
        />
      </Link>

      {/* Org / workspace switcher (desktop) + crumb */}
      <div className="hidden md:block">
        <OrgWsSwitcher />
      </div>
      {crumb && (
        <span className="text-foreground hidden truncate text-sm font-semibold lg:block">
          {crumb}
        </span>
      )}

      <span className="min-w-0 flex-1" />

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <GlobalSearch variant="topnav" />
        <NotificationBell />
        <button
          type="button"
          title="Applications"
          className="text-foreground hover:bg-accent hidden size-9 items-center justify-center rounded-lg transition-colors sm:flex"
        >
          <Grid3x3 className="size-[19px]" />
        </button>
        <UserMenu />
      </div>
    </header>
  );
}
