// SPDX-License-Identifier: Apache-2.0

/**
 * Data on its way, drawn where it will be and in its shape. The page's frame
 * (header, toolbar, tabs) never waits on a read it does not show; whatever does
 * wait is grey blocks laid out as the content will be. A spinner is a control
 * at work, never content on its way.
 *
 * A route's fallback (`skeletonOf` in `app.tsx`) is the same skeleton its page
 * draws while loading, so the chunk and the data wait under one shape.
 */

import {
  ComposerSkeleton,
  ConversationListSkeleton,
  ConversationSkeleton,
} from "@appstrate/module-chat/conversation-skeleton";
import { Card } from "@appstrate/ui/components/card";
import { CardList } from "./card-list";
import { PackageCardSkeleton } from "./package-card";
import { AgentOverviewSkeleton } from "./agent-detail/agent-overview-tab";
import { PackageOverviewSkeleton } from "./package-detail/package-overview";
import { IntegrationOverviewSkeleton } from "./package-detail/integration-overview";
import { ScheduleOverviewSkeleton } from "./schedule-overview-skeleton";
import { RunOverviewSkeleton } from "./run-detail/run-snapshot-inspector";
import { SkeletonBadge, SkeletonLine } from "./skeleton-line";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import { canReadRuns } from "@appstrate/core/permissions";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import { usePageBreadcrumb } from "../hooks/use-overlay-breadcrumb";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";
import { useCurrentOrgId } from "../hooks/use-org";
import { usePermissions } from "../hooks/use-permissions";
import { useChatFilter } from "../modules/chat/use-chat-runtime";
import { useListView } from "../stores/list-view-store";
import { useAdmittingSpaces, useHereSpaceId, useOverviewMode } from "../hooks/use-overview-mode";
import {
  agentSectionVisible,
  isSpaceSetting,
  resolveAgentSettingsSection,
  SECTION_PERMISSION,
} from "../lib/agent-settings-sections";
import {
  isIntegrationSpaceSection,
  resolveIntegrationSettingsSection,
} from "../lib/integration-settings-sections";
import { useSpacesFor } from "../hooks/use-space-action";
import { CardGridSkeleton } from "./card-grid";
import { FileTileSkeleton } from "./file-tile";
import { ShellHeaderActions } from "./shell-header-slots";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { ACROSS_SPACES, agentsKeys, packageKeys } from "../lib/query-keys";
import { usePackageListCrumb } from "../hooks/use-package-list-crumb";
import { DetailBarSkeleton } from "./detail-bar";

/** One `status` for assistive technology; the blocks themselves are hidden from it. */
export function Waiting({ className, children }: { className?: string; children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-busy="true" aria-label={t("loading")} className={className}>
      <div aria-hidden className="contents">
        {children}
      </div>
    </div>
  );
}

const LINE_WIDTHS = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4"];

function Lines({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === lines - 1 && lines > 1 ? "w-2/5" : LINE_WIDTHS[i % 5])}
        />
      ))}
    </div>
  );
}

/** A block of text, a panel or a modal body whose content is prose or a short list. */
export function TextSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Waiting className={className}>
      <Lines lines={lines} />
    </Waiting>
  );
}

/**
 * `PageHeader`'s box on a collection page: the same height, so the real title
 * replaces it in place. Publishes the part of the trail the page already knows
 * from its address.
 */
function HeaderBlocks({
  breadcrumbs,
  actions = true,
  description = false,
}: {
  breadcrumbs: BreadcrumbEntry[];
  /** A page with no deed draws no placeholder where its menu will not land. */
  actions?: boolean;
  /** The page draws one line under its title (`PageHeader`'s `description`). */
  description?: boolean;
}) {
  usePageBreadcrumb(breadcrumbs);
  return (
    <div data-page-header className="mb-4">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <Skeleton className="h-7 w-44" />
        {actions && <Skeleton className="h-8 w-24 shrink-0" />}
      </div>
      {description && <SkeletonLine className="mt-1 w-56 text-sm" />}
    </div>
  );
}

function CardBlocks({ count }: { count: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg border p-4">
          <Skeleton className="h-4 w-24" />
          <Lines lines={3} />
        </div>
      ))}
    </div>
  );
}

/**
 * A resource's page: its identity, controls and tabs are in the shell header
 * (`DetailBar`), so the page waits with its panel alone. Each detail route draws
 * the same element as its fallback and as its page's loading state, so the two
 * waits share one shape. `title` is drawn as text when known; `trail` is the
 * part of the header's trail the address already tells.
 */
export function DetailPageSkeleton({
  title,
  trail,
  tabCount,
  panel,
  meta,
  spaces,
  actions,
}: {
  title?: string;
  trail?: readonly BreadcrumbEntry[];
  tabCount: number;
  /** Whether the page draws an action at the bar's end (`DetailBarSkeleton`). */
  actions?: boolean;
  /** Whether the page draws a line under its title (`DetailBarSkeleton`). */
  meta?: boolean;
  /** Whether that line opens with the resource's spaces (`DetailBarSkeleton`). */
  spaces?: boolean;
  /** The first tab's own skeleton, when the page has one; generic blocks otherwise. */
  panel?: ReactNode;
}) {
  return (
    <Waiting>
      <DetailBarSkeleton
        title={title}
        trail={trail}
        tabCount={tabCount}
        meta={meta}
        spaces={spaces}
        actions={actions}
      />
      {/* The first tab lays its blocks on the page, like `DetailTabPanel`: no frame around them. */}
      {panel ?? <CardBlocks count={3} />}
    </Waiting>
  );
}

/** The detail tab the address opens on (`useTabWithHash`): its skeleton is the one to draw. */
function useOpenTab(): string {
  return useLocation().hash.replace(/^#/, "");
}

/** The space a per-space tab is read in (`ConfigurationSpace`): its label, then its button. */
function SpaceLineBlocks() {
  return (
    <div className="mb-6 flex min-h-8 items-center gap-2">
      <SkeletonLine className="w-36 text-sm" />
      <Skeleton className="h-8 w-32" />
    </div>
  );
}

/** {@link ListTabBlocks} on its own, while a tab's rows load inside the page. */
export function ListTabSkeleton() {
  return (
    <Waiting>
      <ListTabBlocks />
    </Waiting>
  );
}

/** A list tab (runs, connections, usage): its toolbar over the table's own card. */
function ListTabBlocks({ spaceLine = false }: { spaceLine?: boolean }) {
  return (
    <>
      {spaceLine && <SpaceLineBlocks />}
      <ToolbarBlocks columns />
      <TableBlocks framed />
    </>
  );
}

/**
 * Whether a package's open tab starts with the space it is read in, in « Tous les espaces »
 * (`ConfigurationSpace`): the section the page opens (its own resolver, from the reader's grants
 * in any space, before the detail says which spaces are the package's), when it asks a permission
 * of its space: always for an agent's setting set there, else when the working space refuses it;
 * an integration's Connexions, and its Authentification or Accès.
 */
function useOpensWithSpaceLine(type: PackageType, tab: string): boolean {
  const { on } = useOverviewMode();
  const { can } = usePermissions();
  const search = new URLSearchParams(useLocation().search);
  const configures = useSpacesFor({ permission: "agents:configure" }).offered;
  const readsIntegrations = useSpacesFor({ permission: "integrations:read" }).offered;
  const readsAgent = useSpacesFor({ permission: "agents:read" }).offered;
  const readsSchedules = useAdmittingSpaces("schedules").length > 0;
  const configuresIntegration = useSpacesFor({ permission: "integrations:configure" }).offered;
  if (!on) return false;
  if (type === "agent" && tab === "settings") {
    const grants: Record<string, boolean> = {
      "agents:configure": configures,
      "integrations:read": readsIntegrations,
      "agents:read": readsAgent,
    };
    // An organization agent, its definition read only: what most readers open.
    const sectionGrants = {
      grants: (permission: string) => !!grants[permission],
      readsSchedules,
      canEditDefinition: false,
      isSystem: false,
    };
    const section = resolveAgentSettingsSection(search.get("agentSettings"), sectionGrants);
    const permission = SECTION_PERMISSION[section];
    return (
      !!permission &&
      agentSectionVisible(section, sectionGrants) &&
      (isSpaceSetting(section) || !can(permission))
    );
  }
  if (type !== "integration") return false;
  if (tab !== "settings") return false;
  // A section named in the address exists: the rail offers it.
  const section = resolveIntegrationSettingsSection(search.get("integrationSettings"), {
    canConfigure: configuresIntegration,
    isOwned: true,
    hasDefinition: true,
  });
  return isIntegrationSpaceSection(section);
}

/**
 * A framed two-pane tab (settings, a run's results): `AgentDetailSplit`'s rail beside its section,
 * in the tab panel's card.
 */
function RailPanelBlocks({
  spaceLine = false,
  rows,
}: {
  spaceLine?: boolean;
  /** The open section's rows, when it has fewer than `SettingsSkeleton`'s default. */
  rows?: number;
}) {
  return (
    <Card className="@container/split overflow-hidden">
      <div className="grid min-h-[610px] grid-cols-1 @xl/split:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="bg-card hidden flex-col gap-2 border-r p-3 @xl/split:flex">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <div className="min-w-0">
          {/* Below the rail's breakpoint, `PhoneNavigation`'s menu button stands in for it. */}
          <div className="p-4 pb-0 @xl/split:hidden">
            <Skeleton className="h-11 w-full" />
          </div>
          <div className="p-6">
            {spaceLine && <SpaceLineBlocks />}
            {/* The open section's `SettingsHeading` (title over its hint), then its rows. */}
            <header className="mb-6">
              <SkeletonLine className="w-32 text-xl font-semibold" />
              <div className="mt-1 max-w-2xl">
                <SkeletonLine className="w-full text-sm leading-relaxed" />
                <SkeletonLine className="w-1/3 text-sm leading-relaxed" />
              </div>
            </header>
            <SettingsSkeleton rows={rows} />
          </div>
        </div>
      </div>
    </Card>
  );
}

/** An agent's memory: its toolbar, the one-line hint under it, then the table's own card. */
function MemoryTabBlocks() {
  return (
    <>
      <ToolbarBlocks />
      <SkeletonLine className="mb-2 w-2/3 text-xs" />
      <TableBlocks framed />
    </>
  );
}

/**
 * A run journal's rows on their way, shaped like its rows: the leading icon, the event's line,
 * the trailing metadata.
 */
export function JournalRowsSkeleton() {
  return (
    <Waiting>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 px-4">
          <Skeleton className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <Skeleton className={cn("h-3.5", LINE_WIDTHS[i % 5])} />
          </div>
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </Waiting>
  );
}

/** A run's journal: its toolbar (with the actions menu), then its own card of rows. */
function JournalTabBlocks() {
  return (
    <>
      <ToolbarBlocks action />
      <Card className="overflow-hidden">
        <JournalRowsSkeleton />
      </Card>
    </>
  );
}

/** The name the family's list (the space's, or the one across spaces it was opened from) already holds for this package, when it was read. */
function useCachedPackageName(type: PackageType, packageId: string | undefined) {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  if (!packageId) return undefined;
  const cached = <Row extends { id: string }>(...keys: (readonly unknown[])[]) =>
    keys.flatMap((key) => qc.getQueryData<Row[]>(key) ?? []).find((row) => row.id === packageId);
  if (type === "agent") {
    return cached<{ id: string; display_name?: string }>(
      agentsKeys.list(orgId, spaceId),
      agentsKeys.list(orgId, ACROSS_SPACES),
    )?.display_name;
  }
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return cached<{ id: string; name?: string }>(
    packageKeys.list(segment, orgId, spaceId),
    packageKeys.list(segment, orgId, ACROSS_SPACES),
  )?.name;
}

/**
 * A package's page while its detail loads (and its route's fallback): its
 * family's list as the parent, and its name when the list was read on the way here.
 */
export function PackageDetailSkeleton({ type }: { type: PackageType }) {
  const { scope, name } = useParams();
  const packageId = scope && name ? `${scope}/${name}` : undefined;
  const listCrumb = usePackageListCrumb(type);
  const title = useCachedPackageName(type, packageId);
  const tab = useOpenTab();
  const spaceLine = useOpensWithSpaceLine(type, tab);
  const search = new URLSearchParams(useLocation().search);
  const configuresIntegration = useSpacesFor({ permission: "integrations:configure" }).offered;
  // « Création de connexions » is one setting; the other sections hold several.
  const opensAccess =
    type === "integration" &&
    resolveIntegrationSettingsSection(search.get("integrationSettings"), {
      canConfigure: configuresIntegration,
      isOwned: true,
      hasDefinition: true,
    }) === "access";
  return (
    <DetailPageSkeleton
      title={title}
      trail={[listCrumb]}
      // An agent offers four tabs, every other family three.
      tabCount={type === "agent" ? 4 : 3}
      // A package's line opens with the spaces it is active in where the reader reaches one, as
      // most do: a package active nowhere they reach draws none, which only its detail says.
      spaces
      panel={
        tab === "settings" ? (
          <RailPanelBlocks spaceLine={spaceLine} rows={opensAccess ? 1 : undefined} />
        ) : tab === "memory" ? (
          <MemoryTabBlocks />
        ) : tab === "runs" || tab === "connections" || tab === "usedBy" ? (
          <ListTabBlocks spaceLine={spaceLine} />
        ) : type === "agent" ? (
          <AgentOverviewSkeleton />
        ) : type === "integration" ? (
          <IntegrationOverviewSkeleton />
        ) : (
          <PackageOverviewSkeleton />
        )
      }
    />
  );
}

/** A run's page, under its agent; an inline run (no agent page) under the runs list, as the page. */
export function RunDetailSkeleton({ agentName }: { agentName?: string }) {
  const { t } = useTranslation("agents");
  const { scope, name } = useParams();
  const listCrumb = usePackageListCrumb("agent");
  const tab = useOpenTab();
  return (
    <DetailPageSkeleton
      trail={
        scope === "@inline"
          ? [{ label: t("runs.title"), href: "/runs" }]
          : agentName
            ? [listCrumb, { label: agentName, href: `/agents/${scope}/${name}#runs` }]
            : [listCrumb]
      }
      tabCount={3}
      meta={false}
      panel={
        tab === "journal" ? (
          <JournalTabBlocks />
        ) : tab === "results" ? (
          <RailPanelBlocks />
        ) : (
          <RunOverviewSkeleton />
        )
      }
    />
  );
}

/** A notification's page: the bar, then the card holding its message. */
export function NotificationDetailSkeleton() {
  const { t } = useTranslation("common");
  // The page names its notification's space in « Tous les espaces ».
  const { on } = useOverviewMode();
  return (
    <DetailPageSkeleton
      trail={[{ label: t("notifications.ariaLabel") }]}
      tabCount={0}
      spaces={on}
      panel={
        <div className="bg-muted/40 flex min-w-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex min-h-5 items-center gap-2 px-4 py-3">
            <SkeletonLine className="w-24 text-sm font-semibold" />
          </div>
          <div className="bg-card rounded-t-lg border-t p-4">
            <Lines lines={3} />
          </div>
        </div>
      }
    />
  );
}

/** The height of a file's frame on its page (the reader), shared with its skeleton. */
export const FILE_READER_FRAME = "h-[max(28rem,calc(100svh-16rem))]";

/**
 * A file's page (the reader), under the files list: the bar, then the file's frame. The address
 * names the file's space, so the space and « Ouvrir dans l'espace » are drawn exactly when the
 * page will draw them: while the switcher does not name that space.
 */
export function FileReaderSkeleton() {
  const { t } = useTranslation("common");
  const elsewhere = useSearchParams()[0].get("space") !== useHereSpaceId();
  return (
    <DetailPageSkeleton
      trail={[{ label: t("nav.files"), href: "/files" }]}
      tabCount={0}
      meta={false}
      spaces={elsewhere}
      actions={elsewhere}
      panel={
        <div
          className={`${FILE_READER_FRAME} flex min-w-0 flex-col overflow-hidden rounded-lg border`}
        >
          <div className="flex min-h-12 items-center gap-2.5 border-b px-4 py-2">
            <Skeleton className="size-4 shrink-0" />
            <SkeletonLine className="w-32 text-xs leading-5" />
          </div>
          <Skeleton className="min-h-0 flex-1 rounded-none" />
        </div>
      }
    />
  );
}

/** A schedule's page, under the schedules list. */
export function ScheduleDetailSkeleton() {
  const { t } = useTranslation("agents");
  const tab = useOpenTab();
  return (
    <DetailPageSkeleton
      trail={[{ label: t("common:nav.schedules"), href: "/schedules" }]}
      tabCount={3}
      meta={false}
      panel={
        tab === "settings" ? (
          <RailPanelBlocks />
        ) : tab === "runs" ? (
          <ListTabBlocks />
        ) : (
          <ScheduleOverviewSkeleton />
        )
      }
    />
  );
}

/**
 * A collection page: title, toolbar, then the table's frame with its header and rows — or the
 * card grid, when `list` names a screen the reader (or its default) shows as cards. The count
 * footer is not drawn: it stays silent until the list answers.
 */
export function ListPageSkeleton({
  list,
  titleKey,
  actions = true,
  views = false,
}: {
  list?: string;
  /** The namespaced key of the page's title, published as its crumb like the page does. */
  titleKey?: string;
  /** Whether the page has an Actions menu (`/files` has none). */
  actions?: boolean;
  /** The bar ends with the cards-or-table switch. */
  views?: boolean;
}) {
  const { t } = useTranslation(["common", "settings", "agents"]);
  return (
    <Waiting>
      <HeaderBlocks breadcrumbs={titleKey ? [{ label: t(titleKey) }] : []} actions={actions} />
      {list ? <ViewedCollectionBlocks list={list} views={views} /> : <CollectionBlocks columns />}
    </Waiting>
  );
}

function ViewedCollectionBlocks({ list, views }: { list: string; views: boolean }) {
  const [view] = useListView(list);
  // « Tous les espaces » names each card's space.
  const { on } = useOverviewMode();
  return (
    <CollectionBlocks
      cards={view === "cards"}
      runnable={list === "agent"}
      files={list === "documents"}
      // An integration's card line also says its source.
      cardMeta={list === "integrations" ? "both" : "version"}
      views={views}
      spaceName={on}
    />
  );
}

/** `ListToolbar`'s bar: an `h-8` search, the filter and columns buttons, the view switch. */
function ToolbarBlocks({
  filters = true,
  columns = false,
  views = false,
  action = false,
}: {
  /** The filter button: absent on a list that only searches. */
  filters?: boolean;
  columns?: boolean;
  views?: boolean;
  /** An action at the bar's end (`ListToolbar`'s `actions`, `TOOLBAR_ACTION` size). */
  action?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Skeleton className="h-8 min-w-40 flex-1 sm:max-w-[280px]" />
      {filters && <Skeleton className="h-8 w-[5.5rem]" />}
      {columns && <Skeleton className="h-8 w-[6.5rem]" />}
      {views && <Skeleton className="ml-auto h-8 w-[5.25rem]" />}
      {action && <Skeleton className="ml-auto h-8 w-24" />}
    </div>
  );
}

/**
 * `DataTable`'s head and rows: in its own card on a page, frameless (the head ruled above and
 * below) on an integrated surface.
 */
function TableBlocks({ framed }: { framed: boolean }) {
  const body = (
    <>
      <div
        className={cn(
          "border-border flex h-10 items-center px-3",
          framed ? "border-b" : "border-y",
        )}
      >
        <Skeleton className="h-3 w-1/3" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          className={cn(
            "border-border/60 flex h-12 items-center border-b px-3",
            framed && "last:border-b-0",
          )}
        >
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </>
  );
  return framed ? <Card className="overflow-hidden">{body}</Card> : body;
}

/** A collection under its title: `ListToolbar`, then `DataTable`'s frame, head and rows — or its cards. */
function CollectionBlocks({
  cards = false,
  runnable = false,
  spaceName = false,
  files = false,
  cardMeta = "version",
  views = false,
  columns = false,
  frameless = false,
}: {
  /** Inside a surface that is already framed (an overlay), the table draws no card of its own. */
  frameless?: boolean;
  cards?: boolean;
  /** The cards are agents': a run button and the stack of their integrations. */
  runnable?: boolean;
  /** The cards name their space (a list spanning spaces). */
  spaceName?: boolean;
  /** The cards are file tiles (the gallery). */
  files?: boolean;
  /** What the cards' line under the description carries. */
  cardMeta?: "version" | "both";
  views?: boolean;
  /** The table's column menu (a table view only). */
  columns?: boolean;
}) {
  return (
    <>
      <ToolbarBlocks views={views} columns={!cards && (columns || views)} />
      {cards ? (
        files ? (
          <CardGridSkeleton min="12rem" placeholder={<FileTileSkeleton />} />
        ) : (
          <CardGridSkeleton
            placeholder={
              <PackageCardSkeleton
                runnable={runnable}
                integrations={runnable}
                meta={cardMeta}
                spaceName={spaceName}
              />
            }
          />
        )
      ) : (
        <TableBlocks framed={!frameless} />
      )}
    </>
  );
}

/**
 * A settings page or section: `SettingRow`s, label over description over control, each bar in a
 * box of its line's height (`text-sm`, then `mt-1 text-xs leading-relaxed`, then an `h-10` field)
 * so the rows that replace them stand where they did.
 */
export function SettingsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <Waiting className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pb-8 last:pb-0">
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-36" />
          </div>
          <div className="mt-1 flex h-[1.21875rem] items-center">
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="mt-3 h-10 w-full max-w-md" />
        </div>
      ))}
    </Waiting>
  );
}

/**
 * The space's tool policy while it loads: `ToolPolicyView`'s groups in their common case (the
 * review's title, hint and « nothing to review » line, then the blocked group's picker).
 */
export function ToolPolicySkeleton() {
  // The common case: nothing to review, nothing approved, the block picker. Each group is
  // `SettingsGroup`'s chrome (`mb-8`, a `mb-4` heading) over the body's own description line.
  return (
    <Waiting className="flex flex-col gap-2">
      <div className="mb-8">
        <header className="mb-4">
          <SkeletonLine className="w-40 text-base font-semibold" />
        </header>
        <SkeletonLine className="mb-3 w-2/3 text-sm" />
        <SkeletonLine className="w-36 text-sm" />
      </div>
      <div className="mb-8">
        <header className="mb-4">
          <SkeletonLine className="w-32 text-base font-semibold" />
        </header>
        <SkeletonLine className="mb-3 w-1/2 text-sm" />
        <Skeleton className="h-9 w-full max-w-sm" />
      </div>
    </Waiting>
  );
}

/**
 * A package's definition editor while its code loads: `PackageEditorFrame`'s padded column, its
 * section heading, then the section's rows.
 */
export function EditorPanelSkeleton() {
  return (
    <Waiting className="flex flex-1 flex-col gap-4 p-6">
      <div className="mb-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-1.5 h-4 w-80 max-w-full" />
      </div>
      <SettingsSkeleton />
    </Waiting>
  );
}

/**
 * A settings page that is a table (`DataTable` on the panel's integrated surface: no frame, the
 * head ruled above and below), with what leads it: a hint paragraph and the list's toolbar. With
 * `groups`, the page is that many titled tables (`SettingsGroup`) under the hint.
 */
export function SettingsTableSkeleton({
  toolbar = false,
  columns = false,
  intro,
  groups,
}: {
  /** The list's search bar. */
  toolbar?: boolean;
  /** The bar also holds the column menu. */
  columns?: boolean;
  intro?: "hint";
  groups?: number;
}) {
  return (
    <Waiting>
      {intro === "hint" && (
        <SkeletonLine className="mb-6 w-full max-w-2xl text-sm leading-relaxed" />
      )}
      {toolbar && <ToolbarBlocks filters={false} columns={columns} />}
      {groups ? (
        Array.from({ length: groups }, (_, i) => (
          <div key={i} className="mb-8">
            <SkeletonLine className="mb-4 w-32 text-base font-semibold" />
            <TableBlocks framed={false} />
          </div>
        ))
      ) : (
        <TableBlocks framed={false} />
      )}
    </Waiting>
  );
}

/**
 * The editor's own box, drawn as text lines: the same block waits for the data
 * and for the lazy chunk, so the editor replaces it in place.
 */
export function EditorSkeleton({ height }: { height?: string | number }) {
  return (
    <div className="overflow-hidden" style={{ height: height ?? "300px" }}>
      <TextSkeleton lines={8} className="p-4" />
    </div>
  );
}

/** A form page with its title in the shell header and no tabs (the MCP URL wizard). */
export function FormPageSkeleton() {
  return (
    <Waiting>
      <DetailBarSkeleton tabCount={0} />
      <SettingsSkeleton rows={4} />
    </Waiting>
  );
}

/** `SectionHeading` of the dashboard: its `<h2>` and its link. */
function DashboardSectionHeadingSkeleton() {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <SkeletonLine className="w-36 text-base font-semibold" />
      <SkeletonLine className="w-20 text-xs font-medium" />
    </div>
  );
}

/** The dashboard's `MetricCard`: label, figure, detail. */
function MetricCardSkeleton() {
  return (
    <Card className="flex min-h-32 flex-col justify-between p-4">
      <SkeletonLine className="w-20 text-xs font-medium" />
      <div>
        <SkeletonLine className="w-12 text-3xl font-semibold" />
        <SkeletonLine className="mt-1 w-32 text-xs" />
      </div>
    </Card>
  );
}

/** `RowSpaceName`: a space's small tile and its name, in a row spanning spaces. */
function RowSpaceNameSkeleton() {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Skeleton className="size-4 shrink-0 rounded-[4px]" />
      <SkeletonLine className="w-16 text-xs" />
    </span>
  );
}

/** `RunRow`: icon, agent and date, its space when `spanning`, status badge, duration. */
function RunRowSkeleton({ spanning = false }: { spanning?: boolean }) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <SkeletonLine className="w-40 text-sm font-medium" />
        <SkeletonLine className="mt-0.5 w-28 text-xs" />
      </div>
      {spanning && <RowSpaceNameSkeleton />}
      {/* `RunStatusBadge`'s own wrapper: its line box makes the row's badge column taller than the badge. */}
      <span className="relative shrink-0">
        <SkeletonBadge className="w-16" />
      </span>
      <SkeletonLine className="w-14 text-xs" />
    </div>
  );
}

/** The dashboard's schedule row: icon, label and agent, its space when `spanning`, state badge and next run. */
function ScheduleRowSkeleton({ spanning }: { spanning: boolean }) {
  return (
    <div className="flex min-h-[74px] items-center gap-3 px-4 py-3">
      <Skeleton className="size-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <SkeletonLine className="w-36 text-sm font-medium" />
        <SkeletonLine className="mt-0.5 w-24 text-xs" />
      </div>
      {spanning && <RowSpaceNameSkeleton />}
      <div className="flex shrink-0 flex-col items-end">
        <SkeletonBadge className="w-14" />
        <SkeletonLine className="mt-1 w-24 text-[11px]" />
      </div>
    </div>
  );
}

/**
 * The dashboard below its greeting: the figures, recent agents, the two lists —
 * each block built like the component it stands for, in the same layout
 * (`DashboardContent`), so nothing moves when the data lands. Recent runs at
 * their cap (`RecentRuns`, 7); schedules at two, their count being the data's.
 * In « Tous les espaces » the agent cards and the rows name their space.
 */
export function DashboardBodySkeleton() {
  const { on } = useOverviewMode();
  return (
    <Waiting className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
      <div>
        <DashboardSectionHeadingSkeleton />
        <div className="flex gap-3 overflow-hidden pb-1">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="w-[19rem] shrink-0">
              <PackageCardSkeleton runnable integrations spaceName={on} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]">
        <div className="min-w-0">
          <DashboardSectionHeadingSkeleton />
          <CardList>
            {Array.from({ length: 7 }, (_, i) => (
              <RunRowSkeleton key={i} spanning={on} />
            ))}
          </CardList>
        </div>
        <div className="min-w-0">
          <DashboardSectionHeadingSkeleton />
          <CardList>
            {Array.from({ length: 2 }, (_, i) => (
              <ScheduleRowSkeleton key={i} spanning={on} />
            ))}
          </CardList>
        </div>
      </div>
    </Waiting>
  );
}

/**
 * The dashboard while its route's code loads: the greeting's box (collection title, a line under
 * it, the actions menu), then the body.
 */
export function DashboardSkeleton() {
  const { t } = useTranslation("common");
  return (
    <div>
      <HeaderBlocks breadcrumbs={[{ label: t("nav.dashboard") }]} description />
      <DashboardBodySkeleton />
    </div>
  );
}

/** A panel page's title row (`settings/layout.tsx`): `mb-6 min-h-9` around an `text-xl` title. */
export function PanelTitleBlock() {
  return (
    <div className="mb-6 flex min-h-9 items-center" aria-hidden>
      <Skeleton className="h-6 w-48" />
    </div>
  );
}

/**
 * The panes of a routed overlay (settings, catalogue) whose code is not loaded
 * yet: `PanelLayout`'s rail and page as blocks. Content only — the dialog around
 * it is `OverlayFrame`'s and is already open, so the page replaces this inside
 * the same box instead of opening a second one. Reached only on a cold address,
 * since the shell preloads the overlays on intent.
 */
export function OverlayPanelSkeleton({ list }: { list?: boolean }) {
  return (
    <>
      <aside className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col gap-2 border-r p-3 max-md:hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </aside>
      {/* `PanelLayout`'s pane: its band (`py-3` around a `min-h-8` line) leaves 57px above the
          page, whose title row is `mb-6 min-h-9`. */}
      <div className="min-w-0 flex-1 p-6 pt-[57px]">
        <PanelTitleBlock />
        {list ? (
          <Waiting>
            <CollectionBlocks frameless columns />
          </Waiting>
        ) : (
          <SettingsSkeleton />
        )}
      </div>
    </>
  );
}

/**
 * The chat's header actions (`ChatModulePage`): the context tabs (one `size-7` tab per readable
 * pane in a `p-1` list), and for a stored conversation the writer's settings button.
 */
function ChatHeaderActionsBlocks({ conversation }: { conversation: boolean }) {
  const { can } = usePermissions();
  const tabs = 1 + Number(canReadRuns(can)) + Number(can("files:read"));
  return (
    <ShellHeaderActions>
      {conversation && can("chat:write") && <Skeleton className="size-8 rounded-md" />}
      <Skeleton className="h-8 rounded-md" style={{ width: tabs * 28 + 8 }} />
    </ShellHeaderActions>
  );
}

/**
 * `/chat` while its code loads: `ThreadWelcome` — the greeting and hint over the composer (with
 * its limit chip when a space is selected), centred in the thread's 42rem column. The module's own wait for a stored conversation is
 * {@link ChatConversationSkeleton}'s shape.
 */
export function ChatPanelSkeleton() {
  const canWrite = usePermissions().can("chat:write");
  // A new conversation is limited to the selected space, and its composer shows the chip.
  const limited = useChatFilter().spaceId !== null;
  return (
    <Waiting className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-4 md:justify-center-safe">
      <ChatHeaderActionsBlocks conversation={false} />
      <div className="flex w-full max-w-2xl flex-1 flex-col items-stretch gap-6 max-md:pb-4 md:flex-none">
        <div className="flex flex-1 flex-col items-center justify-center md:flex-none">
          {/* The `text-2xl` greeting's 32px line. */}
          <div className="flex h-8 items-center">
            <Skeleton className="h-6 w-44" />
          </div>
          <div className="mt-1 flex h-6 items-center md:h-5">
            <Skeleton className="h-3.5 w-96 max-w-full" />
          </div>
        </div>
        {canWrite ? (
          <ComposerSkeleton placeholder={<Skeleton className="h-4 w-48" />} limited={limited} />
        ) : (
          // A reader's composer is a read-only note.
          <Skeleton className="h-[46px] w-full rounded-xl" />
        )}
      </div>
    </Waiting>
  );
}

/**
 * `/chat/:conversationId` while its code loads: the stored conversation's wait, as the module
 * draws it (`ConversationSkeleton`) — turns at the top, the composer and its line at the bottom.
 */
export function ChatConversationSkeleton() {
  // The chat namespace loads with the module: its disclaimer text once loaded, a line until then.
  const { t, i18n } = useTranslation("common");
  const canWrite = usePermissions().can("chat:write");
  return (
    <>
      <ChatHeaderActionsBlocks conversation />
      <ConversationSkeleton
        label={t("loading")}
        placeholder={canWrite ? <Skeleton className="h-4 w-48" /> : null}
        disclaimer={
          i18n.hasLoadedNamespace("chat") ? (
            t("chat:thread.disclaimer")
          ) : (
            <Skeleton className="mx-auto my-0.5 h-3 w-64" />
          )
        }
      />
    </>
  );
}

/** The conversation list's shape while its permissions and chunk load: the module's own. */
export function ChatSidebarSkeleton() {
  const { t } = useTranslation("chat");
  return <ConversationListSkeleton newConversation={t("threads.new")} />;
}
