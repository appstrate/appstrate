// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue: what this space could be given, and what it already has, with
 * the kinds in the rail and each package's placement per space in the table.
 *
 * A SYSTEM package has no `space_packages` row of its own, so the deployment's
 * default decides "active here" (`isActiveHere`, `services/package-activation.ts`);
 * an explicit row outvotes it (the sticky opt-out). A system INTEGRATION is the
 * one kind the library cannot answer for (its offered set is a boot-time env
 * constant), so only `/api/integrations` is trusted for it.
 *
 * A row opens HERE, not on the package's page: that page would throw away the
 * panel and its breadcrumb would claim the current space for a package not in it.
 *
 * It names no space of its own, so « Tous les espaces » opens it as it is and stays on: there,
 * nothing is « here » (`useHereSpaceId`) and every deed names its space.
 */
import { PendingButton } from "@/components/app-ui/pending-button";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ExternalLink, LibraryBig } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import type { PackageType } from "@appstrate/core/validation";
import { useHereSpaceId, useOverviewMode } from "../hooks/use-overview-mode";
import { useListScope } from "../hooks/use-org-scope";
import { MoveHomeSpaceDialog } from "./package-detail/move-home-space-dialog";
import { SHARE_PARAM, SharePackageDialog } from "./package-detail/share-package-dialog";
import { ActivationClosureDialog } from "./catalogue-activation-dialog";
import { RemoveFromSpaceConfirm, type RemovalTarget } from "./remove-from-space-confirm";
import {
  CATALOGUE_KINDS,
  CATALOGUE_PACKAGE_PARAM,
  CATALOGUE_VERSION_PARAM,
  catalogueListAddress,
  catalogueSheetAddress,
  type CatalogueView,
} from "../lib/catalogue-link";
import { searchOf } from "../lib/url-search";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { fetchPackageDetail, fetchPackageIndex, useAgents } from "../hooks/use-packages";
import { packageKeys } from "../lib/query-keys";
import { missingIntegrations, type MissingDependency } from "../lib/activation-closure";
import { useCurrentOrgId } from "../hooks/use-org";
import { useIntegrationsById } from "../hooks/use-integrations";
import { PackageIcon } from "./package-icon";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import {
  useCatalogueLibrary,
  useSetPackageActive,
  type LibraryPackageItem,
} from "../hooks/use-library";
import { activationGate, catalogueDeeds, catalogueOpenPage } from "../lib/catalogue-gates";
import { isSpaceEnterable } from "../lib/space-lists";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import {
  cataloguePlacement,
  detailSpace,
  inPlacedTab,
  type CataloguePlacement,
  type PlacementState,
} from "../lib/catalogue-placement";
import { useUrlModal, useUrlModalTarget } from "../hooks/use-url-modal";
import { useListParams } from "../lib/list-params";
import { INTEGRATION_SOURCES } from "../lib/integration-collection";
import { IntegrationSourceLabel } from "./integration-source-label";
import { CollectionTabs } from "./detail-tabs";
import type { CardItem } from "../lib/package-card-item";
import { PackageCardSkeleton } from "./package-card";
import { CataloguePreview } from "./catalogue-preview";
import { CatalogueMenuItems } from "./catalogue-row";
import { CatalogueAddButton } from "./catalogue-add-button";
import { PageActionsMenu } from "./page-actions-menu";
import { PanelLayout } from "./panel-layout";
import { PackageCollection } from "./package-collection";
import { usePackageNameColumn } from "./package-columns";
import { useColumnVisibility } from "../stores/column-visibility-store";
import type { FilterSpec } from "./list-toolbar";
import {
  useCatalogueActionsColumn,
  useCatalogueSourceColumn,
  useCatalogueOriginColumn,
  useCatalogueSpaceColumns,
  useCatalogueSelectColumn,
} from "./catalogue-columns";
import { RailLink } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";

const TITLE_KEY: Record<PackageType, string> = {
  agent: "packages.type.agents",
  skill: "packages.type.skills",
  integration: "packages.type.integrations",
};

/** The parameter that qualifies the sheet's `?package=`, and leaves with it. */
const SHEET_COMPANIONS = [CATALOGUE_VERSION_PARAM];

const toCardItem = (pkg: LibraryPackageItem): CardItem => ({
  id: pkg.id,
  displayName: pkg.name || pkg.id,
  description: pkg.description,
  type: pkg.type,
  source: pkg.source as CardItem["source"],
});

/** One activation waiting on the integration question. */
interface Closure {
  item: CardItem;
  spaceId: string;
  missing: MissingDependency[];
}

export function OrgCatalogueModal({
  view,
  type: active,
}: {
  /** Both from the URL, so a link opens exactly one view. */
  view: CatalogueView;
  type: PackageType;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  // « Here »: the working space, none in « Tous les espaces », where the catalogue claims no
  // space (no « ici », no bulk activation): the add menu and the « Par espace » matrix name the
  // space of every deed.
  const spaceId = useHereSpaceId();
  const orgId = useCurrentOrgId();
  const { currentOrg } = useOrg();
  const { data: library, isLoading, error } = useCatalogueLibrary();
  const activate = useSetPackageActive();
  const list = useListParams(["state", "origin", "source"]);
  // Découvrir is BROWSING (cards); Par espace is MANAGING (a table of per-space state). No toggle.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A tick belongs to one list: another view or kind starts with none.
  const listKey = `${view}/${active}`;
  const [selectedIn, setSelectedIn] = useState(listKey);
  if (selectedIn !== listKey) {
    setSelectedIn(listKey);
    setSelected(new Set());
  }
  const qc = useQueryClient();

  const discovering = view === "discover";
  const layout: "cards" | "table" = discovering ? "cards" : "table";
  const titleKey = TITLE_KEY[active];
  const orgName = currentOrg?.name ?? "";

  // Integrations resolve their activation server-side; only their view pays for the request.
  const integrationsQuery = useIntegrationsById(
    (library?.packages.integration ?? []).map((item) => item.id),
    { enabled: active === "integration" },
  );
  const { data: integrations } = integrationsQuery;
  // The library carries no icon: agents and integrations get theirs from their own reads — in
  // « Tous les espaces » those of every space reached, the index pages' own lists, so a package
  // absent from the hidden working space still has its icon.
  const { on: spanning } = useOverviewMode();
  const { data: agentsHere, isLoading: agentsHerePending } = useAgents({
    spanning,
    enabled: active === "agent",
  });
  const acrossScope = useListScope(true, true);
  const integrationsAcross = useQuery({
    queryKey: packageKeys.list("integrations", acrossScope.orgId, acrossScope.keySpace),
    queryFn: () => fetchPackageIndex("integration", acrossScope.acrossOrgId),
    enabled: spanning && active === "integration" && acrossScope.enabled,
  });
  const agentLook = new Map((agentsHere ?? []).map((agent) => [agent.id, agent] as const));
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  const integrationIconOf = new Map(
    (integrationsAcross.data ?? []).map((row) => [row.id, row.icon] as const),
  );
  // An integration's source: its read in the working space, else, in « Tous les espaces », the
  // index spanning the reader's spaces, so a package absent from the hidden space keeps its kind.
  const sourceKindAcross = new Map(
    (integrationsAcross.data ?? []).map((row) => [row.id, row.source_kind] as const),
  );
  const sourceKindOf = (id: string) =>
    integrationById.get(id)?.manifest.source.kind ?? sourceKindAcross.get(id);
  // One tile per package, the card's and the sheet's alike; it waits for the read that carries it.
  const iconPending =
    (active === "agent" && agentsHerePending) ||
    (active === "integration" && (integrationsQuery.isLoading || integrationsAcross.isLoading));
  const tileOf = (id: string, name: string) =>
    iconPending ? (
      <Skeleton className="size-10 rounded-[10px]" />
    ) : (
      <PackageIcon
        type={active}
        id={id}
        name={name}
        icon={
          active === "agent"
            ? agentLook.get(id)?.icon
            : (integrationById.get(id)?.manifest.icon ?? integrationIconOf.get(id))
        }
        color={agentLook.get(id)?.color}
      />
    );
  const librarySpaces = library?.spaces ?? [];
  // The current space leads (not the server's default-first order): it is the first space
  // column a reader sees before scrolling sideways.
  const spaces = [...librarySpaces].sort(
    (a, b) => Number(b.id === spaceId) - Number(a.id === spaceId),
  );
  // `/api/spaces` carries the grant of each space, the verdict a switch answers to.
  const { data: reachable } = useSpaces();
  const grantById = new Map((reachable ?? []).map((space) => [space.id, space] as const));
  const enterable = (reachable ?? []).filter(isSpaceEnterable).map((space) => space.id);
  const workingSpaceId = useCurrentSpaceId();
  const navigate = useNavigate();
  const location = useLocation();

  // An INTEGRATION's "active here" comes from `/api/integrations`: a system one is ON in a
  // space with no row (`resolveIntegrationActivations`), which the library cannot see.
  const placementOf = (item: LibraryPackageItem): CataloguePlacement => {
    const base = cataloguePlacement(item, spaceId);
    if (active !== "integration") return base;
    const activeHere = Boolean(integrationById.get(item.id)?.active);
    if (!activeHere || !spaceId || base.here === "active") return base;
    return { ...base, here: "active", activeIn: [...base.activeIn, spaceId] };
  };

  const ofKind: LibraryPackageItem[] = library?.packages[active] ?? [];
  // The read has an address of its own: reload lands on it, Back leaves it.
  // Looked up in the whole library, not the kind shown nor the rows the filters leave: a link
  // to a package (a share notification) opens its sheet whatever the list shows, a
  // filtered-out integration included. An id the library does not hold drops from the address.
  const preview = useUrlModalTarget(
    CATALOGUE_PACKAGE_PARAM,
    library ? CATALOGUE_KINDS.flatMap((kind) => library.packages[kind]) : undefined,
    { companions: SHEET_COMPANIONS },
  );
  // A package of another kind moves the address to its kind; the sheet renders only once the
  // address is its own (`previewed`).
  const sheetAddress = catalogueSheetAddress(active, preview.target?.type, location);
  useEffect(() => {
    if (sheetAddress !== null) navigate(sheetAddress, { replace: true, state: location.state });
  }, [sheetAddress, navigate, location.state]);
  const placementById = new Map(ofKind.map((item) => [item.id, placementOf(item)] as const));
  const spaceNameOf = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  const sources = list.values("source", INTEGRATION_SOURCES);
  // A source filter judges a row by its integration read: until it lands the list is loading, not empty.
  const listLoading =
    isLoading ||
    (active === "integration" &&
      sources.length > 0 &&
      (integrationsQuery.isLoading || (spanning && integrationsAcross.isLoading)));
  const all = ofKind.filter((item) => {
    if (active === "integration" && sources.length > 0) {
      const kind = sourceKindOf(item.id);
      if (!kind || !sources.includes(kind)) return false;
    }
    // Découvrir is the WHOLE catalogue, not the complement of the placed half: otherwise
    // agents and skills (placed by their home) would empty it.
    if (discovering) return true;
    const placement = placementById.get(item.id);
    return placement ? inPlacedTab(placement) : false;
  });
  const mayActivateIn = (pkg: LibraryPackageItem, targetSpaceId: string) =>
    activationGate(pkg, targetSpaceId, true).allowed;
  const rowOf = (item: Pick<CardItem, "id">) => ofKind.find((row) => row.id === item.id);
  /** A row joins a bulk activation only when there is something the reader may switch on here. */
  const canActivate = (item: CardItem) => {
    const row = rowOf(item);
    return (
      !!row &&
      !!spaceId &&
      placementById.get(item.id)?.here !== "active" &&
      mayActivateIn(row, spaceId)
    );
  };
  const writableOf = (item: Pick<CardItem, "id">) => rowOf(item)?.home_writable === true;
  const deedsOf = (item: Pick<CardItem, "id">) => {
    const row = rowOf(item);
    return row ? catalogueDeeds(row, spaceId) : undefined;
  };
  // Activations waiting on the missing-integrations question; a bulk activation queues several, asked one at a time.
  const [closures, setClosures] = useState<Closure[]>([]);
  const closure = closures[0];
  const nextClosure = () => setClosures((queue) => queue.slice(1));
  const [movingHome, setMovingHome] = useState<string | null>(null);
  const share = useUrlModal(SHARE_PARAM);
  const [removing, setRemoving] = useState<RemovalTarget | null>(null);
  const revokeFrom = (item: CardItem, targetSpaceId: string) =>
    setRemoving({
      packageId: item.id,
      name: item.displayName,
      target: targetSpaceId,
      targetLabel: spaceNameOf(targetSpaceId),
    });

  // The STATE filter is for the matrix only; `catalogueListAddress` drops the key when the view changes.
  const states: PlacementState[] = discovering
    ? []
    : list.values("state", ["active", "inactive"] as const);
  const statesIn = (placement: CataloguePlacement): PlacementState[] => {
    const out: PlacementState[] = [];
    if (placement.activeIn.length > 0) out.push("active");
    if (placement.inactiveIn.length > 0) out.push("inactive");
    return out;
  };
  const rows = all.filter((item) => {
    const placement = placementById.get(item.id);
    if (!placement) return false;
    if (states.length === 0) return true;
    return statesIn(placement).some((state) => states.includes(state));
  });
  const stateFilter: FilterSpec = {
    id: "state",
    label: t("providers.col.state"),
    values: states,
    options: [
      { value: "active", label: t("catalogue.filter.active") },
      { value: "inactive", label: t("catalogue.filter.inactive") },
    ],
    onChange: list.setValues("state"),
  };
  const sourceFilter: FilterSpec = {
    id: "source",
    label: t("integrations.col.source"),
    values: sources,
    options: INTEGRATION_SOURCES.map((source) => ({
      value: source,
      label: t(`integrations.source.${source}`),
    })),
    onChange: list.setValues("source"),
  };
  const offered: CardItem[] = rows.map((item) => {
    const look = agentLook.get(item.id);
    const row: CardItem = {
      ...toCardItem(item),
      ...(active === "agent" && { identity: { icon: look?.icon, color: look?.color } }),
      ...(active === "integration" && {
        logo:
          integrationById.get(item.id)?.manifest.icon ??
          integrationIconOf.get(item.id) ??
          undefined,
      }),
    };
    if (layout !== "cards") return row;
    const placement = placementById.get(item.id);
    const icon = tileOf(item.id, row.displayName);
    // Spaces where it already runs (ticked, so nothing vanishes after a click) or where this reader may add it.
    const addable = spaces
      // Drawn with its tile: the listing's row, which every space the library names is in.
      .flatMap((space) => {
        const listed = grantById.get(space.id);
        if (!listed) return [];
        const running = placement?.activeIn.includes(space.id) ?? false;
        return [
          {
            ...listed,
            active: running,
            // The « Par espace » switch's own verdict: the menu offers what the matrix offers.
            removable: running && activationGate(item, space.id, false).allowed,
          },
        ];
      })
      .filter((space) => space.active || mayActivateIn(item, space.id));
    // Only the placement in the space on screen: another space's share says nothing here.
    const sharer = (spaceId && placement?.sharedBy[spaceId]) || undefined;
    const sourceKind = active === "integration" ? sourceKindOf(item.id) : undefined;
    return {
      ...row,
      icon,
      status: (
        <CatalogueAddButton
          spaces={addable}
          workingSpaceId={spaceId}
          busy={activate.isPending}
          onAdd={(targetSpaceId) => void onSetActive(row, targetSpaceId, true)}
          onRemove={(targetSpaceId) => void onSetActive(row, targetSpaceId, false)}
        />
      ),
      meta: (
        <>
          <span className="truncate">
            {item.source === "system" ? t("catalogue.sourceSystem") : orgName}
          </span>
          {sourceKind && (
            <>
              <span aria-hidden>·</span>
              <IntegrationSourceLabel source={sourceKind} />
            </>
          )}
          {sharer && (
            <span className="bg-primary/10 text-primary shrink-0 truncate rounded px-1.5 text-[11px] leading-5 font-medium">
              {t("catalogue.sheet.sharedBy", { name: sharer })}
            </span>
          )}
        </>
      ),
    };
  });

  const activatable = offered.filter(canActivate).map((item) => item.id);
  const allSelected = activatable.length > 0 && activatable.every((id) => selected.has(id));
  const picked = offered.filter((item) => selected.has(item.id));
  const previewed = sheetAddress === null ? preview.target : undefined;
  // A system package ships one definition and answers no version: the sheet reads it as is.
  const pinnedVersion =
    previewed && previewed.source !== "system"
      ? new URLSearchParams(location.search).get(CATALOGUE_VERSION_PARAM) || undefined
      : undefined;
  const unpin = () => {
    const params = new URLSearchParams(location.search);
    params.delete(CATALOGUE_VERSION_PARAM);
    navigate(
      { pathname: location.pathname, search: searchOf(params), hash: location.hash },
      { replace: true, state: location.state },
    );
  };
  const previewedItem = previewed ? toCardItem(previewed) : undefined;
  const openPage = previewed
    ? catalogueOpenPage(previewed, placementOf(previewed), enterable, spaceId, workingSpaceId)
    : null;

  const { columns: nameColumns, menu: columnMenu } = useColumnVisibility(`catalogue-${active}`, [
    usePackageNameColumn(),
  ]);
  const selectColumn = useCatalogueSelectColumn({
    selected,
    allSelected,
    selectable: canActivate,
    onToggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onToggleAll: () => setSelected(allSelected ? new Set() : new Set(activatable)),
  });
  const originColumn = useCatalogueOriginColumn(orgName, (item) => {
    const home = placementById.get(item.id)?.homeSpaceId;
    // `null` when the caller does not reach the home: the server withholds the id (RBAC spec §6.9).
    return home ? spaceNameOf(home) : null;
  });
  // Every control that changes where a package runs lands here; the mutation reports success and failure.
  const setActive = (item: CardItem, targetSpaceId: string, next: boolean) =>
    activate.mutate({ spaceId: targetSpaceId, packageId: item.id, active: next });

  // Only an AGENT has a closure the target space must hold: its skills travel with it, its
  // integrations do not. The manifest is read at click time, from a space that holds the agent.
  const onSetActive = async (item: CardItem, targetSpaceId: string, next: boolean) => {
    if (!next || item.type !== "agent") return setActive(item, targetSpaceId, next);
    const row = library?.packages.agent.find((agent) => agent.id === item.id);
    const from = row
      ? detailSpace(cataloguePlacement(row, spaceId), librarySpaces, spaceId)
      : undefined;
    if (!from) return setActive(item, targetSpaceId, next);
    let declared: { id: string }[];
    try {
      const detail = await qc.fetchQuery({
        queryKey: packageKeys.detail("agents", orgId ?? "", from, item.id, null),
        queryFn: () => fetchPackageDetail("agent", item.id, undefined, from),
      });
      declared = detail.dependencies.integrations;
    } catch {
      // The question is a courtesy; the run gate is the authority.
      return setActive(item, targetSpaceId, next);
    }
    const missing = missingIntegrations(
      declared,
      library?.packages.integration ?? [],
      targetSpaceId,
      // A system INTEGRATION is not exempt like a system agent or skill: the target space's verdict alone.
      (row) => activationGate(row, targetSpaceId, true).allowed,
    );
    if (missing.length === 0) return setActive(item, targetSpaceId, next);
    setClosures((queue) => [...queue, { item, spaceId: targetSpaceId, missing }]);
  };

  /** The ticked rows, each through the same door as its own switch. */
  const activatePicked = () => {
    if (!spaceId) return;
    for (const item of picked) void onSetActive(item, spaceId, true);
    setSelected(new Set());
  };

  const spaceColumns = useCatalogueSpaceColumns({
    spaces,
    currentSpaceId: spaceId,
    placementOf: (item) => placementById.get(item.id),
    gateOf: (item, targetSpaceId, next) => {
      const row = rowOf(item);
      return row ? activationGate(row, targetSpaceId, next) : { allowed: false, refusal: null };
    },
    busy: activate.isPending,
    onSetActive: (item, targetSpaceId, next) => void onSetActive(item, targetSpaceId, next),
  });
  const sourceColumn = useCatalogueSourceColumn((item) => sourceKindOf(item.id));
  const actionsColumn = useCatalogueActionsColumn({
    isPending: activate.isPending,
    deedsOf,
    spaceNameOf,
    currentSpaceId: spaceId,
    onOpen: (item) => preview.open(item.id),
    onMoveHome: (item) => setMovingHome(item.id),
    onShare: (item) => share.open(item.id),
    onRevoke: revokeFrom,
  });

  // The two VIEWS are one set seen two ways, so they sit in the bar with search and
  // filters; the rail keeps the one axis that IS a partition: the kinds.
  const views: { id: CatalogueView; label: string }[] = [
    { id: "discover", label: t("catalogue.viewDiscover") },
    { id: "spaces", label: t("catalogue.viewSpaces") },
  ];
  const viewSwitcher = (
    <CollectionTabs
      value={view}
      label={t("catalogue.viewLabel")}
      hrefOf={(id) => catalogueListAddress(active, id, location.search)}
      options={views.map(({ id, label }) => ({ value: id, label }))}
    />
  );
  const kindRows = CATALOGUE_KINDS.map((type) => (
    <RailLink
      key={type}
      item={{
        to: catalogueListAddress(type, view, location.search),
        icon: PACKAGE_TYPE_ICON[type],
      }}
      label={t(TITLE_KEY[type])}
      count={library?.packages[type]?.length}
      active={type === active}
    />
  ));
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("common:nav.catalogue")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.kinds")}>
          <nav className="flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {kindRows}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  return (
    <PanelLayout
      title={t("common:nav.catalogue")}
      rail={rail}
      // Where the reader is, kept in place while the pane scrolls: the kind
      // they are browsing, or the package they opened, with the way back.
      contentHeader={(stuck) =>
        previewed ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 shrink-0 gap-1.5"
              onClick={preview.close}
            >
              <ArrowLeft />
              {t("catalogue.back")}
            </Button>
            {/* The package's name belongs to the page below; the band borrows
                it only once that page has scrolled past its own title. */}
            <span
              className={cn(
                "duration-fast truncate text-sm font-medium transition-opacity",
                stuck ? "opacity-100" : "opacity-0",
              )}
            >
              {previewed.name || previewed.id}
            </span>
          </div>
        ) : (
          <span
            className={cn(
              "duration-fast text-sm font-semibold transition-opacity",
              stuck ? "opacity-100" : "opacity-0",
            )}
          >
            {t(titleKey)}
          </span>
        )
      }
    >
      {previewed && previewedItem ? (
        <CataloguePreview
          item={previewed}
          type={active}
          icon={tileOf(previewed.id, previewed.name || previewed.id)}
          spaces={librarySpaces}
          placement={placementOf(previewed)}
          gateOf={(targetSpaceId, next) => activationGate(previewed, targetSpaceId, next)}
          integrations={library?.packages.integration ?? []}
          agents={library?.packages.agent ?? []}
          pinnedVersion={pinnedVersion}
          onUnpin={unpin}
          source={active === "integration" ? sourceKindOf(previewed.id) : undefined}
          actionsMenu={
            <PageActionsMenu>
              <CatalogueMenuItems
                item={previewedItem}
                deeds={catalogueDeeds(previewed, spaceId)}
                spaceNameOf={spaceNameOf}
                currentSpaceId={spaceId}
                // The page reads the package where it is placed: a space without it would 404.
                open={
                  openPage
                    ? {
                        label: t("catalogue.openFullPage"),
                        icon: ExternalLink,
                        onSelect: () => navigate(openPage),
                      }
                    : undefined
                }
                onMoveHome={(item) => setMovingHome(item.id)}
                onShare={(item) => share.open(item.id)}
                onRevoke={revokeFrom}
              />
            </PageActionsMenu>
          }
          busy={activate.isPending}
          onSetActive={(targetSpaceId, next) =>
            void onSetActive(previewedItem, targetSpaceId, next)
          }
        />
      ) : (
        <PackageCollection
          columnMenu={columnMenu}
          items={offered}
          // Icons wait on their own (`iconPending`): the rows never do.
          isLoading={listLoading}
          error={
            error instanceof Error
              ? error
              : active === "integration" && integrationsQuery.error instanceof Error
                ? integrationsQuery.error
                : null
          }
          holds={active}
          tableId={`catalogue-${active}`}
          entity={t(titleKey)}
          emptyMessage={t(discovering ? "catalogue.emptyDiscover" : "catalogue.emptyPlaced")}
          emptyHint={t(discovering ? "catalogue.emptyDiscoverHint" : "catalogue.emptyPlacedHint")}
          emptyIcon={PACKAGE_TYPE_ICON[active]}
          list={list}
          view={layout}
          header={<SettingsHeading className="mb-4" title={t(titleKey)} />}
          // The library says where a package is placed, not what uses it: an activity filter would match nothing.
          activityFilter={false}
          originLabels={{
            title: t("catalogue.origin"),
            local: t("catalogue.sourceOrg", { name: orgName }),
            system: t("catalogue.sourceSystem"),
          }}
          extraFilters={[
            ...(discovering ? [] : [stateFilter]),
            ...(active === "integration" ? [sourceFilter] : []),
          ]}
          // A package this space has not activated cannot be run from here.
          cardRun={false}
          cardPlaceholder={<PackageCardSkeleton meta="line" keywords={false} />}
          columns={[
            // No row to tick (« Tous les espaces », or all already on here): no « tout cocher » either.
            ...(activatable.length > 0 ? [selectColumn] : []),
            ...nameColumns,
            originColumn,
            ...(active === "integration" ? [sourceColumn] : []),
            ...spaceColumns,
            actionsColumn,
          ]}
          rowAction={(item) => preview.open(item.id)}
          actions={
            <>
              {viewSwitcher}
              {layout === "table" && picked.length > 0 ? (
                <PendingButton
                  type="button"
                  size="sm"
                  pending={activate.isPending}
                  disabled={!spaceId}
                  onClick={activatePicked}
                >
                  {t("catalogue.activateSelection", { count: picked.length })}
                </PendingButton>
              ) : null}
            </>
          }
        />
      )}
      {closure && (
        <ActivationClosureDialog
          packageName={closure.item.displayName}
          spaceName={spaceNameOf(closure.spaceId)}
          missing={closure.missing}
          isPending={activate.isPending}
          onClose={nextClosure}
          onAgentOnly={() => {
            setActive(closure.item, closure.spaceId, true);
            nextClosure();
          }}
          onActivateAll={() => {
            // Each is its own call: the API has no cascade, and one refusal must not take the others down.
            setActive(closure.item, closure.spaceId, true);
            for (const entry of closure.missing) {
              activate.mutate({ spaceId: closure.spaceId, packageId: entry.id, active: true });
            }
            nextClosure();
          }}
        />
      )}

      <RemoveFromSpaceConfirm removal={removing} onClose={() => setRemoving(null)} />
      {/* The dialogs mount only when their deed is the reader's; a URL names the shared package. */}
      {movingHome && deedsOf({ id: movingHome })?.moveHome && (
        <MoveHomeSpaceDialog
          onClose={() => setMovingHome(null)}
          packageId={movingHome}
          type={active}
          homeSpaceId={placementById.get(movingHome)?.homeSpaceId}
        />
      )}
      {share.value && deedsOf({ id: share.value })?.share && (
        <SharePackageDialog
          onClose={share.close}
          packageId={share.value}
          type={active}
          homeSpaceId={placementById.get(share.value)?.homeSpaceId}
          canPublish={writableOf({ id: share.value })}
        />
      )}
    </PanelLayout>
  );
}
