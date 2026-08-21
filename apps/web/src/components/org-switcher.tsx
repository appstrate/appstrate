// SPDX-License-Identifier: Apache-2.0

/**
 * Organisation and workspace switcher, at the head of the header trail.
 *
 * Two columns rather than a menu with a submenu: the left one lists the
 * organisations, the right one the workspaces OF THE ONE BEING EXPLORED —
 * clicking an organisation opens its workspaces, it does not switch to it.
 *
 * That is not a nicety, it is what the context actually is: you are always in a
 * workspace, never in an organisation alone. A click that switched org on its
 * own had to invent a workspace to land you in (whichever `useAutoSelect`
 * picked), so half the choice was made for you and silently. Here the pick ends
 * on a workspace, always, and org + workspace are applied together.
 *
 * The current context and the explored one are two different things and read
 * differently: the current organisation keeps the coral fill and the only gear,
 * the explored one is the highlighted row with the chevron into column two.
 */
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { openAsModal } from "../lib/modal-route";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, ChevronsUpDown, Plus, Search, Settings, Library } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { $api } from "../api/client";
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

export function OrgSwitcher({ variant = "chip" }: { variant?: "chip" | "row" }) {
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
  // The organisation whose workspaces column two is showing. Null means "the
  // one you are in": the panel always opens on your own context, and reopening
  // it after a look around never leaves you exploring somewhere else.
  const [exploredOrgId, setExploredOrgId] = useState<string | null>(null);

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;
  const exploredId = exploredOrgId ?? currentOrg?.id ?? null;
  const isExploringElsewhere = exploredId !== null && exploredId !== currentOrg?.id;

  // Workspaces of the EXPLORED organisation. The header is passed explicitly,
  // so it is part of the query key and the client middleware leaves it alone
  // (it only fills headers a request does not already carry). Exploring your
  // own org therefore hits the very same key as `useApplications()` — same
  // cache entry, no second request.
  const exploredApps = $api.useQuery(
    "get",
    "/api/applications",
    { params: { header: { "X-Org-Id": exploredId ?? undefined } } },
    { enabled: open && !!exploredId, select: (e) => e.data },
  );

  if (loading) return <Skeleton className="h-6 w-40" />;
  if (!currentOrg) return null;

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const shownOrgs = orgs.filter((o) => matches(o.name));
  const shownApps = (exploredApps.data ?? []).filter((a) => matches(a.name));

  /**
   * The one place the context is applied — and it is applied whole. Switching
   * org first would blank the workspace and let the auto-selector land the user
   * anywhere for a frame; both stores are set in the same tick instead.
   *
   * A new organisation also means the current URL may not exist there (an agent
   * id, a run number), so the landing is the root of the product you are in —
   * changing org from the chat keeps you in the chat.
   */
  const applyContext = (orgId: string, applicationId: string) => {
    const orgChanged = orgId !== currentOrg.id;
    if (orgChanged) switchOrg(orgId);
    switchApp(applicationId);
    setOpen(false);
    if (orgChanged) {
      navigate(location.pathname.startsWith("/chat") ? "/chat" : "/", { replace: true });
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setExploredOrgId(null);
          setQuery("");
        }
      }}
    >
      <PopoverTrigger asChild>
        {/* Two shapes, one control. `chip` sits in the header trail;
            `row` sits in the sidebar, under the brand cell, at full width.
            Deliberately NOT shaped like the trail segments next to it. A
            breadcrumb segment means "go up a level" — cheap and reversible.
            This one replaces the whole context. The coloured avatar and the
            up/down chevron (never a right chevron) are what say so. */}
        {variant === "row" ? (
          <button
            type="button"
            data-testid="org-switcher-button"
            aria-label={t("switcher.orgAriaLabel")}
            className="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0!"
          >
            <OrgAvatar
              name={currentOrg.name}
              className="size-5 shrink-0 rounded-[5px] text-[0.65rem]"
            />
            <span className="min-w-0 flex-1 truncate text-left font-medium group-data-[collapsible=icon]:hidden">
              {currentOrg.name}
              {currentApp && (
                <>
                  <span className="text-border mx-1" aria-hidden>
                    |
                  </span>
                  {currentApp.name}
                </>
              )}
            </span>
            <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0 group-data-[collapsible=icon]:hidden" />
          </button>
        ) : (
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
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={variant === "row" ? "right" : "bottom"}
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
              const isCurrent = org.id === currentOrg.id;
              const isExplored = org.id === exploredId;
              return (
                <div
                  key={org.id}
                  className={cn(
                    "hover:bg-accent flex items-center rounded-md",
                    isExplored && "bg-accent",
                    isCurrent && "bg-spark-soft hover:bg-spark-soft",
                  )}
                >
                  {/* Opens this organisation's workspaces beside it. It does
                      NOT switch: you are always in a workspace, so the pick is
                      only complete one column to the right. */}
                  <button
                    type="button"
                    data-testid={`org-item-${org.id}`}
                    aria-expanded={isExplored}
                    onClick={() => setExploredOrgId(org.id)}
                    className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left"
                  >
                    <OrgAvatar name={org.name} className="size-[30px] text-[0.82rem]" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{org.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t(`switcher.role.${org.role}`)}
                      </span>
                    </span>
                    {isCurrent && <Check size={15} className="text-spark ml-auto shrink-0" />}
                    <ChevronRight
                      className={cn(
                        "text-muted-foreground shrink-0",
                        isCurrent ? "ml-1" : "ml-auto",
                        !isExplored && "opacity-0",
                      )}
                      size={15}
                    />
                  </button>
                  {/* Only on the current org: the gear configures what you are
                      IN, and switching org first is one honest click rather
                      than a shortcut that silently changes context. */}
                  {isCurrent && (
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
            {/* Adding a workspace lands in the CURRENT org's settings, so the
                shortcut is offered only while you are looking at your own —
                elsewhere it would create it in the wrong place. */}
            <ColumnHeader
              label={t("switcher.workspacesColumn")}
              addLabel={t("switcher.add")}
              onAdd={isExploringElsewhere ? undefined : "/org-settings/applications"}
            />
            {exploredApps.isPending ? (
              <div className="space-y-1 p-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
              </div>
            ) : shownApps.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">
                {t("switcher.workspacesEmpty")}
              </p>
            ) : (
              shownApps.map((app) => {
                const isCurrent = app.id === currentAppId && !isExploringElsewhere;
                return (
                  <div
                    key={app.id}
                    className={cn(
                      "hover:bg-accent flex items-center rounded-md",
                      isCurrent && "bg-primary-soft hover:bg-primary-soft",
                    )}
                  >
                    {/* The end of the pick: org AND workspace applied together. */}
                    <button
                      type="button"
                      data-testid={`app-item-${app.id}`}
                      onClick={() => applyContext(exploredId ?? currentOrg.id, app.id)}
                      className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left"
                    >
                      <span className="truncate text-sm font-medium">{app.name}</span>
                      {isCurrent && <Check size={15} className="text-primary ml-auto shrink-0" />}
                    </button>
                    {isCurrent && (
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
              })
            )}
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
