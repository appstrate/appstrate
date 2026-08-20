// SPDX-License-Identifier: Apache-2.0

/**
 * Organisation and workspace switcher, at the head of the header trail.
 *
 * Two columns rather than a menu with a submenu, following the redesign: an
 * organisation and a workspace are two independent dimensions of the same
 * context, so both are visible and pickable in one pass instead of one hiding
 * behind the other.
 */
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { openAsModal } from "../lib/modal-route";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Plus, Search, Settings, Library } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, useAppSwitcher } from "../hooks/use-current-application";
import { usePermissions } from "../hooks/use-permissions";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";

function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center rounded-lg font-bold",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function ColumnHeader({
  label,
  onAdd,
  addLabel,
}: {
  label: string;
  onAdd?: string;
  addLabel: string;
}) {
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-2">
      <span className="text-muted-foreground text-[0.72rem] font-semibold tracking-[0.05em] uppercase">
        {label}
      </span>
      {onAdd && (
        <Link to={onAdd} className="text-primary flex items-center gap-1 text-xs font-medium">
          {addLabel}
          <Plus size={13} />
        </Link>
      )}
    </div>
  );
}

export function OrgSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  if (loading) return <Skeleton className="h-6 w-40" />;
  if (!currentOrg) return null;

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const shownOrgs = orgs.filter((o) => matches(o.name));
  const shownApps = (applications ?? []).filter((a) => matches(a.name));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Deliberately NOT shaped like the trail segments next to it. A
            breadcrumb segment means "go up a level" — cheap and reversible.
            This one replaces the whole context. The coloured avatar and the
            up/down chevron (never a right chevron) are what say so. */}
        <button
          type="button"
          data-testid="org-switcher-button"
          aria-label={t("switcher.orgAriaLabel")}
          className="hover:bg-accent data-[state=open]:bg-accent flex min-w-0 shrink items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1 text-sm transition-colors"
        >
          <OrgAvatar name={currentOrg.name} className="size-5 rounded-[5px] text-[0.65rem]" />
          <span className="truncate font-semibold">{currentOrg.name}</span>
          {currentApp && (
            <>
              {/* The workspace stays visible even when there is only one: a
                  level nobody ever sees is a level nobody learns. */}
              <span className="text-border" aria-hidden>
                |
              </span>
              <span className="truncate font-semibold">{currentApp.name}</span>
            </>
          )}
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[540px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0"
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("switcher.searchPlaceholder")}
            className="w-full border-none bg-transparent p-0 text-sm shadow-none focus:ring-0 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2">
          <div className="p-2.5">
            <ColumnHeader
              label={t("switcher.orgsColumn")}
              addLabel={t("switcher.add")}
              onAdd="/onboarding/create"
            />
            {shownOrgs.map((org) => {
              const isActive = org.id === currentOrg.id;
              return (
                <div
                  key={org.id}
                  className={cn(
                    "hover:bg-accent flex items-center rounded-md",
                    isActive && "bg-spark-soft hover:bg-spark-soft",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`org-item-${org.id}`}
                    onClick={() => {
                      if (!isActive) {
                        switchOrg(org.id);
                        navigate("/", { replace: true });
                      }
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left"
                  >
                    <OrgAvatar name={org.name} className="size-[30px] text-[0.82rem]" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{org.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t(`switcher.role.${org.role}`)}
                      </span>
                    </span>
                  </button>
                  {/* Only on the current org: the gear configures what you are
                      IN, and switching org first is one honest click rather
                      than a shortcut that silently changes context. */}
                  {isActive && (
                    <Link
                      to="/org-settings"
                      state={openAsModal(location)}
                      onClick={() => setOpen(false)}
                      aria-label={t("switcher.orgSettings", { org: org.name })}
                      className="text-muted-foreground hover:text-foreground shrink-0 p-2"
                    >
                      <Settings size={15} />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-l p-2.5">
            <ColumnHeader
              label={t("switcher.workspacesColumn")}
              addLabel={t("switcher.add")}
              onAdd="/org-settings/applications"
            />
            {shownApps.map((app) => {
              const isActive = app.id === currentAppId;
              return (
                <div
                  key={app.id}
                  className={cn(
                    "hover:bg-accent flex items-center rounded-md",
                    isActive && "bg-primary-soft hover:bg-primary-soft",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`app-item-${app.id}`}
                    onClick={() => {
                      if (!isActive) switchApp(app.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left"
                  >
                    <span className="truncate text-sm font-medium">{app.name}</span>
                  </button>
                  {isActive && (
                    <Link
                      to="/workspace-settings"
                      state={openAsModal(location)}
                      onClick={() => setOpen(false)}
                      aria-label={t("workspaceSettings.pageTitle", { ns: "settings" })}
                      className="text-muted-foreground hover:text-foreground shrink-0 p-2"
                    >
                      <Settings size={15} />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 border-t">
          <Link
            to="/org-settings"
            state={openAsModal(location)}
            onClick={() => setOpen(false)}
            className="hover:bg-accent flex items-center gap-2 px-3 py-2.5 text-[0.84rem] font-medium"
          >
            <Settings size={15} className="text-muted-foreground shrink-0" />
            <span className="truncate">{t("switcher.orgSettings", { org: currentOrg.name })}</span>
          </Link>
          {isAdmin && (
            <Link
              to="/library"
              onClick={() => setOpen(false)}
              className="hover:bg-accent flex items-center gap-2 border-l px-3 py-2.5 text-[0.84rem] font-medium"
            >
              <Library size={15} className="text-muted-foreground shrink-0" />
              <span className="truncate">{t("nav.library")}</span>
            </Link>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
