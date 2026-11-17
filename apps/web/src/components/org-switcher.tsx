// SPDX-License-Identifier: Apache-2.0

import { requestScopeChange } from "../hooks/use-unsaved-changes";

/**
 * Organization and workspace switcher, at the head of the header trail: two columns, the
 * organizations and the workspaces OF THE ONE BEING EXPLORED (clicking an organization
 * opens its workspaces, it does not switch to it); one column, the organization above its
 * workspaces, on a phone or with a single organization. You are always in a workspace, never
 * in an organization alone, so org + workspace are applied together. The current context
 * keeps the tinted fill and the check; the explored one is the highlighted row. Every row leads
 * to its own settings, entering its organization or space first.
 */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLandAfterOrgSwitch, useOpenOverlayAfterOrgSwitch } from "../lib/modal-route";
import { mayCreateSpaceIn, settingsEntry, switcherShape } from "../lib/switcher-context";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, ChevronsUpDown, Plus, Settings, Star } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useOrgSpaces, useSpaces } from "../hooks/use-spaces";
import { spaceRoleLabel } from "../hooks/use-roles";
import { spaceLabel } from "../lib/space-label";
import { orgTile, spaceTile } from "../lib/identity-tile-props";
import { matchesSearch } from "../lib/strings";
import { isSpaceEnterable, useCurrentSpaceId } from "../hooks/use-current-space";
import { useEnterSpace } from "../hooks/use-enter-space";
import { useCanCreateOrg } from "../hooks/use-auth";
import { useViewer } from "../hooks/use-viewer";
import { Command, CommandInput } from "@appstrate/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { useSidebar } from "@appstrate/ui/components/sidebar";
import { cn } from "@appstrate/ui/cn";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { NEW_SPACE_PARAM } from "./space-create-modal";
import { SpaceName } from "./space-name";

function ColumnHeader({ label }: { label: string }) {
  return (
    <p className="text-muted-foreground px-2 pt-1 pb-1.5 text-[0.72rem] font-semibold tracking-[0.05em] uppercase">
      {label}
    </p>
  );
}

/**
 * The last row of a column, under its list: where one more of what it lists is created.
 * `onPick` replaces the link's own navigation, for a creation that changes organization first.
 */
function AddRow({
  to,
  state,
  label,
  onNavigate,
  onPick,
}: {
  to: string;
  state?: unknown;
  label: string;
  onNavigate: () => void;
  onPick?: () => void;
}) {
  // The rule sits on a wrapper: on the rounded row itself its ends would curve.
  return (
    <div className="mt-1 border-t pt-1">
      <Link
        to={to}
        state={state}
        onClick={(event) => {
          if (!onPick) return onNavigate();
          event.preventDefault();
          onPick();
        }}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm"
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          <Plus size={15} />
        </span>
        {label}
      </Link>
    </div>
  );
}

/**
 * A pickable row: the pick on the left, the gear to its settings on the right. The gear shows on
 * the row pointed at or focused, and stays on the current one (`pinned`) and on a screen
 * nothing hovers (a touch screen, `hover: none`). `onPick` replaces the link's own navigation,
 * for settings of another context that is entered first.
 */
function PickerRow({
  rowClassName,
  settings,
  onNavigate,
  className,
  ...pick
}: ComponentProps<"button"> & {
  rowClassName?: string | false;
  settings?: { to: string; label: string; pinned: boolean; onPick?: () => void };
  onNavigate: () => void;
}) {
  return (
    <div className={cn("group hover:bg-accent flex items-center rounded-md", rowClassName)}>
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center justify-start gap-2.5 px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...pick}
      />
      {settings && (
        <Link
          to={settings.to}
          onClick={(event) => {
            if (!settings.onPick) return onNavigate();
            event.preventDefault();
            settings.onPick();
          }}
          aria-label={settings.label}
          title={settings.label}
          className={cn(
            "text-muted-foreground hover:text-foreground shrink-0 px-2 py-1.5",
            !settings.pinned &&
              "hidden group-focus-within:block group-hover:block [@media(hover:none)]:block",
          )}
        >
          <Settings size={15} />
        </Link>
      )}
    </div>
  );
}

/** What the reader is on a row, after its name: it yields to the name and keeps its full text in `title`. */
function RowRole({ children }: { children: string | null | undefined }) {
  return (
    <span
      title={children ?? undefined}
      className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs"
    >
      {children}
    </span>
  );
}

/** Where a space is created: the organization's spaces settings, its creation dialog open. */
const NEW_SPACE_ADDRESS = `/org-settings/spaces?${NEW_SPACE_PARAM}=1`;

/** A column's rows: it scrolls past eight of them, under a header that stays. */
const LIST_BOX = "max-h-80 overflow-y-auto";

/** The trigger's box per shape, shared by the live control and its loading placeholder. */
const TRIGGER_BOX = {
  brand: "h-11 w-full",
  mobile: "h-11 min-w-0 flex-1",
};

export function OrgSwitcher({ variant }: { variant: "brand" | "mobile" }) {
  const { t } = useTranslation();
  const landAfterOrgSwitch = useLandAfterOrgSwitch();
  const openOverlayAfterOrgSwitch = useOpenOverlayAfterOrgSwitch();
  const { currentOrg, orgs, loading, switchOrg } = useOrg();
  const { data: spaces, isPending: spacesPending } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const enterSpace = useEnterSpace();
  const { isMobile, setOpenMobile } = useSidebar();
  const canCreateOrg = useCanCreateOrg();
  const viewer = useViewer();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The organization whose workspaces column two shows; null = the one you are in (the panel always reopens there).
  const [exploredOrgId, setExploredOrgId] = useState<string | null>(null);
  const spacesColumnId = useId();

  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;
  const exploredId = exploredOrgId ?? currentOrg?.id ?? null;
  const isExploringElsewhere = exploredId !== null && exploredId !== currentOrg?.id;
  const { mobilePresentation, stacked } = switcherShape({
    variant,
    isMobile,
    orgCount: orgs.length,
  });
  const closeSwitcherAndSidebar = () => {
    setOpen(false);
    setOpenMobile(false);
  };

  // Spaces of the EXPLORED organization; your own org shares `useSpaces()`'s cache entry.
  const exploredSpaces = useOrgSpaces(open ? exploredId : null);

  // The trigger's own box (avatar + name), so the column does not move when the org lands.
  if (loading) {
    return (
      <div className={cn("flex items-center gap-2 px-2", TRIGGER_BOX[variant])} aria-hidden>
        <Skeleton className="mr-1 size-8 shrink-0 rounded-lg" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    );
  }
  if (!currentOrg) return null;

  const shownOrgs = orgs.filter((o) => matchesSearch(query, [o.name]));
  // "Mon espace" sits above the team spaces, and is called by the reader's own
  // word rather than the French the server stored once (`spaceLabel`): the wire
  // deliberately never says whose space it is (RBAC spec §3.6).
  const shownSpaces = (exploredSpaces.data ?? [])
    .filter((a) => matchesSearch(query, [spaceLabel(a, t)]))
    .sort((a, b) => Number(Boolean(b.personal)) - Number(Boolean(a.personal)));

  /** The pick is applied whole (`useEnterSpace`); the current page may not exist in another organization, so `useLandAfterOrgSwitch` moves it. */
  const applyContext = (orgId: string, spaceId: string) =>
    requestScopeChange(() => {
      if (enterSpace(orgId, spaceId)) landAfterOrgSwitch();
      closeSwitcherAndSidebar();
    });

  const maySpaceWrite = mayCreateSpaceIn(orgs, exploredId);
  /**
   * The pick of settings (or of a creation) in another context: enter it, then open them. Over
   * another organization's settings the page beneath moves to its landing, as a pick does.
   * `undefined` for the current context's, which its link opens as is.
   */
  const settingsPick = (to: string, target: { orgId: string; spaceId?: string }) => {
    const entry = settingsEntry({ orgId: currentOrg.id, spaceId: currentSpaceId }, target);
    if (entry === "link") return undefined;
    return () =>
      requestScopeChange(() => {
        if (target.spaceId === undefined) switchOrg(target.orgId);
        else enterSpace(target.orgId, target.spaceId);
        if (entry === "organization") openOverlayAfterOrgSwitch(to);
        else navigate(to);
        closeSwitcherAndSidebar();
      });
  };
  const currentContextLabel = currentSpace ? spaceLabel(currentSpace, t) : undefined;
  // The space's tile is a badge on the organization's, ringed in the trigger's background.
  const spaceBadge: ReactNode = currentSpace ? (
    <IdentityTile
      {...spaceTile(currentSpace, viewer)}
      className={cn(
        "absolute -right-1 -bottom-1 size-4 rounded-[5px] ring-2",
        variant === "mobile" ? "ring-background" : "ring-sidebar",
      )}
    />
  ) : null;
  const spaceName: ReactNode = currentContextLabel ? (
    <span className="truncate" title={currentContextLabel}>
      {currentContextLabel}
    </span>
  ) : (
    spacesPending && <Skeleton className="mt-0.5 h-3 w-16" />
  );

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
        {/* Two shapes, one control: `brand` heads the sidebar, `mobile` the phone header. It
            replaces the whole context, which the coloured avatar and the up/down chevron
            (never a right chevron) say. The workspace stays visible even when there is only
            one: a level nobody ever sees is a level nobody learns. */}
        <button
          type="button"
          data-testid="org-switcher-button"
          aria-label={t("switcher.ariaLabel", {
            current: [currentOrg.name, currentContextLabel].filter(Boolean).join(", "),
          })}
          className={cn(
            // No hover fill: the chevron answers the pointer, a focus ring the keyboard.
            "group/trigger focus-visible:ring-ring flex items-center gap-2 rounded-lg px-2 text-sm outline-none focus-visible:ring-2",
            TRIGGER_BOX[variant],
          )}
        >
          {/* The organization's tile, the space's as a badge on its corner. */}
          <span className="relative mr-1 shrink-0">
            <IdentityTile {...orgTile(currentOrg)} className="size-8 rounded-lg" />
            {spaceBadge}
          </span>
          {/* Two lines, each truncating by itself: a long organization name never hides the space. */}
          <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
            <span className="truncate font-semibold" title={currentOrg.name}>
              {currentOrg.name}
            </span>
            {spaceName && (
              <span className="text-muted-foreground flex min-w-0 text-xs">{spaceName}</span>
            )}
          </span>
          <ChevronsUpDown className="text-muted-foreground group-hover/trigger:text-foreground group-data-[state=open]/trigger:text-foreground size-3.5 shrink-0 transition-colors" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={mobilePresentation ? "bottom" : "right"}
        sideOffset={variant === "mobile" ? 47 : 6}
        className={cn(
          // Beside the sidebar the panel takes what the viewport leaves it, never more.
          "max-w-[min(calc(100vw-2rem),calc(var(--radix-popover-content-available-width)-0.5rem))] overflow-hidden rounded-xl p-0",
          stacked ? "w-[340px]" : "w-[660px]",
          mobilePresentation && "max-h-[calc(100svh-4.5rem)] overflow-y-auto",
          variant === "mobile" && "w-[calc(100vw-1rem)] max-w-none",
          isMobile && variant !== "mobile" && "w-[calc(100vw-1rem)] max-w-[17rem]",
        )}
      >
        {/* The lists filter themselves (`matchesSearch`); cmdk only supplies the field. */}
        <Command shouldFilter={false} className="h-auto overflow-visible">
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("switcher.searchPlaceholder")}
            aria-label={t("switcher.searchAriaLabel")}
          />

          <div className={cn("grid", stacked ? "grid-cols-1" : "grid-cols-2")}>
            <div className="flex min-h-0 flex-col p-2">
              <ColumnHeader label={t("switcher.orgsColumn")} />
              <div className={cn("flex flex-col gap-1", !mobilePresentation && LIST_BOX)}>
                {shownOrgs.map((org) => {
                  const isCurrent = org.id === currentOrg.id;
                  const isExplored = org.id === exploredId;
                  return (
                    // Opens this organization's workspaces beside it. It does NOT switch: you
                    // are always in a workspace, so the pick is only complete one column to the
                    // right. Its gear does switch: the settings it opens are this organization's.
                    <PickerRow
                      key={org.id}
                      data-testid={`org-item-${org.id}`}
                      aria-current={isCurrent || undefined}
                      // With one organization there is nothing to open: its spaces are always shown.
                      aria-expanded={orgs.length > 1 ? isExplored : undefined}
                      aria-controls={orgs.length > 1 ? spacesColumnId : undefined}
                      onClick={() => setExploredOrgId(org.id)}
                      rowClassName={cn(
                        isExplored && "bg-accent",
                        isCurrent && "bg-primary/10 hover:bg-primary/10",
                      )}
                      settings={{
                        to: "/org-settings",
                        label: t("switcher.settingsOf", { name: org.name }),
                        pinned: isCurrent || mobilePresentation,
                        onPick: settingsPick("/org-settings", { orgId: org.id }),
                      }}
                      onNavigate={closeSwitcherAndSidebar}
                    >
                      <IdentityTile {...orgTile(org)} className="size-6" />
                      <span className="max-w-[65%] shrink-0 truncate text-sm font-medium">
                        {org.name}
                      </span>
                      <RowRole>{t(`switcher.role.${org.role}`)}</RowRole>
                      {isCurrent && <Check size={15} className="text-primary shrink-0" />}
                      {isExplored && !isCurrent && (
                        <ChevronRight className="text-muted-foreground shrink-0" size={15} />
                      )}
                    </PickerRow>
                  );
                })}
              </div>
              {/* Whether this user may create one is the server's rule, not a flag. Without
                  the state the create step forwards a user who already has an org. */}
              {canCreateOrg && (
                <AddRow
                  to="/onboarding/create"
                  state={{ fromSwitcher: true }}
                  label={t("switcher.newOrg")}
                  onNavigate={closeSwitcherAndSidebar}
                />
              )}
            </div>

            <div
              id={spacesColumnId}
              className={cn("flex min-h-0 flex-col p-2", stacked ? "border-t" : "border-l")}
            >
              <ColumnHeader label={t("switcher.workspacesColumn")} />
              {exploredSpaces.isPending ? (
                <div className="flex flex-col gap-1 p-2">
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
                <div className={cn("flex flex-col gap-1", !mobilePresentation && LIST_BOX)}>
                  {shownSpaces.map((space) => {
                    const isCurrent = space.id === currentSpaceId && !isExploringElsewhere;
                    const enterable = isSpaceEnterable(space);
                    return (
                      // The end of the pick: org AND workspace applied together. A closed space
                      // is listed but cannot be entered (and an orphaned personal one only
                      // managed): disabled, and says why.
                      <PickerRow
                        key={space.id}
                        data-testid={`space-item-${space.id}`}
                        aria-current={isCurrent || undefined}
                        disabled={!enterable}
                        title={
                          enterable ? undefined : t("spaces.requestAccess", { ns: "settings" })
                        }
                        onClick={() => applyContext(exploredId ?? currentOrg.id, space.id)}
                        rowClassName={isCurrent && "bg-primary/10 hover:bg-primary/10"}
                        settings={
                          enterable
                            ? {
                                to: "/workspace-settings",
                                label: t("switcher.settingsOf", { name: spaceLabel(space, t) }),
                                pinned: isCurrent || mobilePresentation,
                                onPick: settingsPick("/workspace-settings", {
                                  orgId: exploredId ?? currentOrg.id,
                                  spaceId: space.id,
                                }),
                              }
                            : undefined
                        }
                        onNavigate={closeSwitcherAndSidebar}
                      >
                        <SpaceName
                          space={space}
                          size="md"
                          className="max-w-[65%] shrink-0 font-medium"
                        >
                          {space.isDefault && (
                            <Star
                              size={12}
                              role="img"
                              aria-label={t("switcher.defaultSpace")}
                              className="shrink-0 fill-amber-500 text-amber-500"
                            >
                              <title>{t("switcher.defaultSpace")}</title>
                            </Star>
                          )}
                        </SpaceName>
                        <RowRole>
                          {enterable
                            ? space.role && spaceRoleLabel(space.role, t)
                            : t("switcher.spaceOnRequest")}
                        </RowRole>
                        {isCurrent && <Check size={15} className="text-primary shrink-0" />}
                      </PickerRow>
                    );
                  })}
                </div>
              )}
              {/* Adding a workspace happens in the settings of the organization being explored:
                  in another one, the pick switches there first. Creating is `spaces:write`,
                  an organization-level permission the org listing carries. */}
              {maySpaceWrite && (
                <AddRow
                  to={NEW_SPACE_ADDRESS}
                  label={t("spaces.create", { ns: "settings" })}
                  onNavigate={closeSwitcherAndSidebar}
                  onPick={settingsPick(NEW_SPACE_ADDRESS, { orgId: exploredId ?? currentOrg.id })}
                />
              )}
            </div>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
