// SPDX-License-Identifier: Apache-2.0

/**
 * Organization and workspace switcher, at the head of the header trail.
 *
 * Two columns rather than a menu with a submenu: the left one lists the
 * organizations, the right one the workspaces OF THE ONE BEING EXPLORED —
 * clicking an organization opens its workspaces, it does not switch to it.
 *
 * That is what the context is: you are always in a workspace, never in an
 * organization alone, so the pick ends on a workspace and org + workspace are
 * applied together. Switching org alone would have to choose a workspace for you.
 *
 * The current context and the explored one are two different things and read
 * differently: the current organization keeps the coral fill and the only gear,
 * the explored one is the highlighted row with the chevron into column two.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useLandAfterOrgSwitch } from "../lib/modal-route";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, ChevronsUpDown, Plus, Search, Settings, Star } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useOrgSpaces, useSpaces } from "../hooks/use-spaces";
import { spaceRoleLabel } from "../hooks/use-roles";
import { usePermissions } from "../hooks/use-permissions";
import { spaceLabel } from "../lib/space-label";
import { matchesSearch } from "../lib/strings";
import { isSpaceEnterable, useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import { useCanCreateOrg } from "../hooks/use-auth";
import { spaceStore } from "../stores/space-store";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useSidebar } from "@appstrate/ui/components/sidebar-context";
import { cn } from "@appstrate/ui/cn";
import { OrganizationAvatar } from "./organization-avatar";
import { NEW_SPACE_PARAM } from "./space-create-modal";

function ColumnHeader({
  label,
  onAdd,
  addState,
  addLabel,
  onNavigate,
}: {
  label: string;
  onAdd?: string;
  addState?: unknown;
  addLabel: string;
  onNavigate: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-2">
      <span className="text-muted-foreground text-[0.72rem] font-semibold tracking-[0.05em] uppercase">
        {label}
      </span>
      {onAdd && (
        <Link
          to={onAdd}
          state={addState}
          onClick={onNavigate}
          className="text-primary flex items-center gap-1 text-xs font-medium"
        >
          {addLabel}
          <Plus size={13} />
        </Link>
      )}
    </div>
  );
}

export function OrgSwitcher({ variant }: { variant: "brand" | "mobile" }) {
  const { t } = useTranslation();
  const landAfterOrgSwitch = useLandAfterOrgSwitch();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const { isMobile, setOpenMobile } = useSidebar();
  const { can } = usePermissions();
  const canCreateOrg = useCanCreateOrg();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The organization whose workspaces column two is showing. Null means "the
  // one you are in": the panel always opens on your own context, and reopening
  // it after a look around never leaves you exploring somewhere else.
  const [exploredOrgId, setExploredOrgId] = useState<string | null>(null);

  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;
  const exploredId = exploredOrgId ?? currentOrg?.id ?? null;
  const isExploringElsewhere = exploredId !== null && exploredId !== currentOrg?.id;
  const mobilePresentation = variant === "mobile" || isMobile;
  const closeSwitcherAndSidebar = () => {
    setOpen(false);
    setOpenMobile(false);
  };

  // Spaces of the EXPLORED organization; your own org shares `useSpaces()`'s cache entry.
  const exploredSpaces = useOrgSpaces(open ? exploredId : null);

  if (loading) return <Skeleton className="h-6 w-40" />;
  if (!currentOrg) return null;

  const shownOrgs = orgs.filter((o) => matchesSearch(query, [o.name]));
  // "Mon espace" sits above the team spaces, and is called by the reader's own
  // word rather than the French the server stored once (`spaceLabel`): the wire
  // deliberately never says whose space it is (RBAC spec §3.6).
  const shownSpaces = (exploredSpaces.data ?? [])
    .filter((a) => matchesSearch(query, [spaceLabel(a, t)]))
    .sort((a, b) => Number(Boolean(b.personal)) - Number(Boolean(a.personal)));

  /**
   * The one place the context is applied — and it is applied whole. In a new
   * organization the pick is remembered there first, so the space resolver
   * enters it as soon as that organization's listing proves it enterable,
   * instead of landing on its default.
   *
   * A new organization also means the current page may not exist there (an
   * agent id, a run number): `useLandAfterOrgSwitch` moves it.
   */
  const applyContext = (orgId: string, spaceId: string) => {
    if (orgId !== currentOrg.id) {
      spaceStore.getState().remember(orgId, spaceId);
      switchOrg(orgId);
      landAfterOrgSwitch();
    } else switchSpace(spaceId);
    closeSwitcherAndSidebar();
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
        {/* Two shapes, one control: `brand` heads the sidebar, `mobile` the
            phone header. It replaces the whole context, which the coloured
            avatar and the up/down chevron (never a right chevron) say. */}
        {variant === "mobile" ? (
          <button
            type="button"
            data-testid="org-switcher-button"
            aria-label={t("switcher.orgAriaLabel")}
            className="hover:bg-accent data-[state=open]:bg-accent flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-sm transition-colors"
          >
            <OrganizationAvatar
              name={currentOrg.name}
              logo={currentOrg.logo}
              className="size-6 shrink-0 rounded-md text-[0.7rem]"
            />
            <span className="flex min-w-0 flex-1 items-center text-left">
              <span className="max-w-[48%] shrink-0 truncate font-semibold">{currentOrg.name}</span>
              {currentSpace && (
                <>
                  <span className="text-border mx-1.5 shrink-0" aria-hidden>
                    |
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate">
                    {spaceLabel(currentSpace, t)}
                  </span>
                </>
              )}
            </span>
            <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        ) : (
          /* The head of the column: whose data you are in, wearing its own
             avatar — the workspace you are looking at names itself, the way
             Notion puts the workspace logo where a product logo would go. Flat:
             the rules under it separate the three bands (context, tool,
             navigation). */
          <button
            type="button"
            data-testid="org-switcher-button"
            aria-label={t("switcher.orgAriaLabel")}
            className="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-sm transition-colors"
          >
            <OrganizationAvatar
              name={currentOrg.name}
              logo={currentOrg.logo}
              className="size-6 shrink-0 rounded-md text-[0.7rem]"
            />
            <span className="min-w-0 flex-1 truncate text-left">
              <span className="font-semibold">{currentOrg.name}</span>
              {/* The workspace stays visible even when there is only one: a
                  level nobody ever sees is a level nobody learns. */}
              {currentSpace && (
                <>
                  <span className="text-border mx-1.5" aria-hidden>
                    |
                  </span>
                  <span className="text-muted-foreground">{spaceLabel(currentSpace, t)}</span>
                </>
              )}
            </span>
            <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={mobilePresentation ? "bottom" : "right"}
        sideOffset={variant === "mobile" ? 47 : 6}
        className={cn(
          "w-[540px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0",
          mobilePresentation && "max-h-[calc(100svh-4.5rem)] overflow-y-auto",
          variant === "mobile" && "w-[calc(100vw-1rem)] max-w-none",
          isMobile && variant !== "mobile" && "w-[calc(100vw-1rem)] max-w-[17rem]",
        )}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("switcher.searchPlaceholder")}
            aria-label={t("switcher.searchAriaLabel")}
            className="w-full border-none bg-transparent p-0 text-sm shadow-none focus:ring-0 focus:outline-none"
          />
        </div>

        <div className={cn("grid grid-cols-2", mobilePresentation && "grid-cols-1")}>
          <div className="p-2.5">
            <ColumnHeader
              label={t("switcher.orgsColumn")}
              addLabel={t("switcher.add")}
              // Whether this user may create one is the server's rule, not a flag.
              onAdd={canCreateOrg ? "/onboarding/create" : undefined}
              // Without it the create step forwards a user who already has an org.
              addState={{ fromSwitcher: true }}
              onNavigate={closeSwitcherAndSidebar}
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
                  {/* Opens this organization's workspaces beside it. It does
                      NOT switch: you are always in a workspace, so the pick is
                      only complete one column to the right. */}
                  <button
                    type="button"
                    data-testid={`org-item-${org.id}`}
                    aria-expanded={isExplored}
                    onClick={() => setExploredOrgId(org.id)}
                    className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left"
                  >
                    <OrganizationAvatar
                      name={org.name}
                      logo={org.logo}
                      className="size-[30px] text-[0.82rem]"
                    />
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
                      onClick={closeSwitcherAndSidebar}
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

          <div className={cn("border-l p-2.5", mobilePresentation && "border-t border-l-0")}>
            {/* Adding a workspace lands in the CURRENT org's settings, so the
                shortcut is offered only while you are looking at your own —
                elsewhere it would create it in the wrong place. Creating is
                `spaces:write`. */}
            <ColumnHeader
              label={t("switcher.workspacesColumn")}
              addLabel={t("switcher.add")}
              onAdd={
                isExploringElsewhere || !can("spaces:write")
                  ? undefined
                  : `/org-settings/spaces?${NEW_SPACE_PARAM}=1`
              }
              onNavigate={closeSwitcherAndSidebar}
            />
            {exploredSpaces.isPending ? (
              <div className="space-y-1 p-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
              </div>
            ) : exploredSpaces.isError ? (
              <p className="text-destructive px-2 py-4 text-xs">{t("error.generic")}</p>
            ) : shownSpaces.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">
                {t("switcher.workspacesEmpty")}
              </p>
            ) : (
              shownSpaces.map((space, index) => {
                const isCurrent = space.id === currentSpaceId && !isExploringElsewhere;
                // One heading per group, printed on the first row of each: the
                // personal space is a different KIND of place, not a space that
                // sorts first.
                const heading =
                  index === 0 && space.personal
                    ? t("spaces.personal.switcherGroup", { ns: "settings" })
                    : !space.personal && (index === 0 || shownSpaces[index - 1]?.personal)
                      ? t("spaces.personal.teamGroup", { ns: "settings" })
                      : null;
                return (
                  <div key={`group-${space.id}`}>
                    {heading && (
                      <p className="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide uppercase">
                        {heading}
                      </p>
                    )}
                    <div
                      key={space.id}
                      className={cn(
                        "hover:bg-accent flex items-center rounded-md",
                        isCurrent && "bg-primary-soft hover:bg-primary-soft",
                      )}
                    >
                      {/* The end of the pick: org AND workspace applied together. */}
                      {/* A closed space is listed but cannot be entered (and an
                          orphaned personal one only managed): disabled, and says why. */}
                      <button
                        type="button"
                        data-testid={`space-item-${space.id}`}
                        disabled={!isSpaceEnterable(space)}
                        title={
                          isSpaceEnterable(space)
                            ? undefined
                            : t("spaces.requestAccess", { ns: "settings" })
                        }
                        onClick={() => applyContext(exploredId ?? currentOrg.id, space.id)}
                        className="flex min-w-0 flex-1 items-center justify-start gap-2.5 p-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                            {spaceLabel(space, t)}
                            {space.isDefault && (
                              <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
                            )}
                          </span>
                          {isSpaceEnterable(space) && space.role && (
                            <span className="text-muted-foreground truncate text-xs">
                              {spaceRoleLabel(space.role, t)}
                            </span>
                          )}
                        </span>
                        {!isSpaceEnterable(space) && (
                          <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                            {t("switcher.spaceOnRequest")}
                          </span>
                        )}
                        {isCurrent && <Check size={15} className="text-primary ml-auto shrink-0" />}
                      </button>
                      {isCurrent && (
                        <Link
                          to="/workspace-settings"
                          onClick={closeSwitcherAndSidebar}
                          aria-label={t("workspaceSettings.pageTitle", { ns: "settings" })}
                          className="text-muted-foreground hover:text-foreground shrink-0 p-2"
                        >
                          <Settings size={15} />
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
