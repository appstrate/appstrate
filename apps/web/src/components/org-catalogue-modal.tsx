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
 */
import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Check, ExternalLink, Inbox, LibraryBig, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { MOVE_HOME_PARAM, MoveHomeSpaceDialog } from "./package-detail/move-home-space-dialog";
import { SHARE_PARAM, SharePackageDialog } from "./package-detail/share-package-dialog";
import { ActivationClosureDialog } from "./catalogue-activation-dialog";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { CATALOGUE_KINDS, catalogueHref, type CatalogueReading } from "../lib/catalogue-link";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { fetchPackageDetail, useAgents } from "../hooks/use-packages";
import { packageKeys } from "../lib/query-keys";
import { missingIntegrations, type MissingDependency } from "../lib/activation-closure";
import { mayConfigurePackage } from "../lib/package-permissions";
import { useCurrentOrgId } from "../hooks/use-org";
import { useRevokePackageShare } from "../hooks/use-package-shares";
import { useIntegrationsById } from "../hooks/use-integrations";
import { PackageIcon } from "./package-icon";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import {
  invalidateLibraries,
  useCatalogueLibrary,
  useSetPackageActive,
  type LibraryPackageItem,
} from "../hooks/use-library";
import { activationGate, catalogueDeeds, type ActivationGate } from "../lib/catalogue-gates";
import {
  cataloguePlacement,
  detailSpace,
  inPlacedTab,
  pendingShares,
  type CataloguePlacement,
  type PlacementState,
} from "../lib/catalogue-placement";
import { modalOpeningState, useModalParam, useModalTarget } from "../hooks/use-modal-param";
import { useListParams } from "../lib/list-params";
import {
  INTEGRATION_EXECUTIONS,
  integrationExecution,
  integrationProtocol,
  type IntegrationExecution,
} from "../lib/integration-collection";
import { CollectionTabs } from "./collection-tabs";
import type { CardItem } from "../lib/package-card-item";
import { CataloguePreview } from "./catalogue-preview";
import { CatalogueMenuItems } from "./catalogue-row";
import { CatalogueShared } from "./catalogue-shared";
import { CatalogueAddButton } from "./catalogue-add-button";
import { PageActionsMenu } from "./page-actions-menu";
import { PanelDialog } from "./panel-dialog";
import { PackageCollection } from "./package-collection";
import type { FilterSpec } from "./list-toolbar";
import {
  useCatalogueActionsColumn,
  useCatalogueProtocolColumn,
  useCatalogueOriginColumn,
  useCatalogueSpaceColumns,
  useCatalogueSelectColumn,
  type CatalogueRowState,
} from "./catalogue-columns";
import { RailLink } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";

const KIND: Record<PackageType, { icon: LucideIcon; titleKey: string }> = {
  agent: { icon: PACKAGE_TYPE_ICON.agent, titleKey: "packages.type.agents" },
  skill: { icon: PACKAGE_TYPE_ICON.skill, titleKey: "packages.type.skills" },
  "mcp-server": { icon: PACKAGE_TYPE_ICON["mcp-server"], titleKey: "packages.type.mcp-servers" },
  integration: { icon: PACKAGE_TYPE_ICON.integration, titleKey: "packages.type.integrations" },
};
const KINDS = CATALOGUE_KINDS.map((type) => ({ type, ...KIND[type] }));

/**
 * Columns the catalogue drops. `origin` is drawn again with each package's home
 * space under its provider, and `keywords` goes because the library carries none.
 */
const CATALOGUE_DROPS = ["state", "actions", "origin", "keywords"];

/** One activation waiting on the integration question. */
interface Closure {
  item: CardItem;
  spaceId: string;
  missing: MissingDependency[];
}

export function OrgCatalogueModal({
  reading,
  type: active,
  hrefOf,
  onClose,
}: {
  /** Both from the URL, so a link opens exactly one view. */
  reading: CatalogueReading;
  type: PackageType;
  /** The address of another reading or kind of the catalogue. */
  hrefOf: (reading: CatalogueReading, type: PackageType) => string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const spaceId = useCurrentSpaceId();
  const orgId = useCurrentOrgId();
  const { currentOrg } = useOrg();
  const { data: library, isLoading, error } = useCatalogueLibrary();
  const activate = useSetPackageActive();
  const list = useListParams(["state", "origin"]);
  // Découvrir is BROWSING (cards); Vos espaces is MANAGING (a table of per-space state). No toggle.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A tick belongs to one list: another reading or kind starts with none.
  const listKey = `${reading}/${active}`;
  const [selectedIn, setSelectedIn] = useState(listKey);
  if (selectedIn !== listKey) {
    setSelectedIn(listKey);
    setSelected(new Set());
  }
  const qc = useQueryClient();

  const discovering = reading === "discover";
  const view: "cards" | "table" = discovering ? "cards" : "table";
  const kind = KIND[active];
  const orgName = currentOrg?.name ?? "";

  // Integrations resolve their activation server-side; only their view pays for the request.
  const integrationsQuery = useIntegrationsById(
    (library?.packages.integration ?? []).map((item) => item.id),
    { enabled: active === "integration" },
  );
  const { data: integrations } = integrationsQuery;
  // The library carries no icon: agents and integrations get theirs from their own reads.
  const { data: agentsHere, isLoading: agentsHerePending } = useAgents();
  const agentLook = new Map((agentsHere ?? []).map((agent) => [agent.id, agent] as const));
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  const librarySpaces = library?.spaces ?? [];
  // The current space leads (not the server's default-first order): it is the column that
  // survives a narrow width (tier 2, in `useCatalogueSpaceColumns`).
  const spaces = [...librarySpaces].sort(
    (a, b) => Number(b.id === spaceId) - Number(a.id === spaceId),
  );
  // `/api/spaces` carries the grant of each space, the verdict a switch answers to.
  const { data: reachable } = useSpaces();
  const grantById = new Map((reachable ?? []).map((space) => [space.id, space] as const));
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

  const [execution, setExecution] = useState<IntegrationExecution>("remote");
  const ofKind: LibraryPackageItem[] = library?.packages[active] ?? [];
  // Looked up in the whole kind, not the filtered rows: a link to a package (a share
  // notification) opens its sheet whatever the list shows. An unknown id drops from the address.
  const preview = useModalTarget("package", library ? ofKind : undefined);
  const placementById = new Map(ofKind.map((item) => [item.id, placementOf(item)] as const));
  const spaceNameOf = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  const all = ofKind.filter((item) => {
    if (active === "integration") {
      const row = integrationById.get(item.id);
      if (row && integrationExecution(row.manifest.source.kind) !== execution) return false;
    }
    // Découvrir is the WHOLE catalogue, not the complement of the placed half: otherwise
    // agents and skills (placed by their home) would empty it.
    if (discovering) return true;
    const placement = placementById.get(item.id);
    return placement ? inPlacedTab(placement) : false;
  });
  const stateOf = (item: CardItem): CatalogueRowState => {
    const placement = placementById.get(item.id);
    if (!placement) return { activeIn: [], activeHere: false };
    return {
      activeIn: placement.activeIn.map(spaceNameOf),
      activeHere: placement.here === "active",
      placedHere: placement.here === "inactive",
      offeredHere: placement.here === "offered",
    };
  };
  /** The reader's verdict for one switch, in the direction it would go (`lib/catalogue-gates`). */
  const gateOf = (pkg: LibraryPackageItem, targetSpaceId: string, next: boolean): ActivationGate =>
    activationGate(pkg, targetSpaceId, next);
  const mayActivateIn = (pkg: LibraryPackageItem, targetSpaceId: string) =>
    gateOf(pkg, targetSpaceId, true).allowed;
  const rowOf = (item: Pick<CardItem, "id">) => ofKind.find((row) => row.id === item.id);
  /** A row joins a bulk activation only when there is something the reader may switch on here. */
  const canActivate = (item: CardItem) => {
    const row = rowOf(item);
    return !!row && !!spaceId && !stateOf(item).activeHere && mayActivateIn(row, spaceId);
  };
  const writableOf = (item: Pick<CardItem, "id">) => rowOf(item)?.home_writable === true;
  const deedsOf = (item: Pick<CardItem, "id">) => {
    const row = rowOf(item);
    return row ? catalogueDeeds(row) : undefined;
  };
  // Activations waiting on the missing-integrations question; a bulk activation queues several, asked one at a time.
  const [closures, setClosures] = useState<Closure[]>([]);
  const closure = closures[0];
  const nextClosure = () => setClosures((queue) => queue.slice(1));
  const moveHome = useModalParam(MOVE_HOME_PARAM);
  const share = useModalParam(SHARE_PARAM);
  const revoke = useRevokePackageShare();
  // Targets the SPACE id; a share to a person publishes their user id instead, so that
  // offer is withdrawn from the package's share dialog.
  const revokeFrom = (item: CardItem, targetSpaceId: string) =>
    revoke.mutate(
      {
        params: { path: { ...splitPackageRef(item.id), target: targetSpaceId } },
      },
      {
        onSuccess: () => {
          void invalidateLibraries(qc);
          toast.success(t("catalogue.revoked", { space: spaceNameOf(targetSpaceId) }));
        },
      },
    );

  // The STATE filter is for the matrix only; `pages/catalogue.tsx` drops the key when the reading changes.
  const states: PlacementState[] = discovering
    ? []
    : list.values("state", ["active", "inactive", "offered"] as const);
  const statesIn = (placement: CataloguePlacement): PlacementState[] => {
    const out: PlacementState[] = [];
    if (placement.activeIn.length > 0) out.push("active");
    if (placement.inactiveIn.length > 0) out.push("inactive");
    if (placement.offeredIn.length > 0) out.push("offered");
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
    label: t("catalogue.filter.state"),
    values: states,
    options: [
      { value: "active", label: t("catalogue.filter.active") },
      { value: "inactive", label: t("catalogue.filter.inactive") },
      { value: "offered", label: t("catalogue.filter.offered") },
    ],
    onChange: list.setValues("state"),
  };
  const offered: CardItem[] = rows.map((item) => {
    const look = agentLook.get(item.id);
    const row: CardItem = {
      id: item.id,
      displayName: item.name || item.id,
      description: item.description,
      type: active,
      source: item.source as CardItem["source"],
      ...(active === "agent" && { identity: { icon: look?.icon, color: look?.color } }),
      ...(active === "integration" && { logo: integrationById.get(item.id)?.manifest.icon }),
    };
    if (view !== "cards") return row;
    const placement = placementById.get(item.id);
    const activeHere = placement?.here === "active";
    const iconPending =
      (active === "agent" && agentsHerePending) ||
      (active === "integration" && integrationsQuery.isLoading);
    const icon = iconPending ? (
      <Skeleton className="size-10 rounded-[10px]" />
    ) : (
      <PackageIcon
        type={active}
        icon={active === "agent" ? look?.icon : integrationById.get(item.id)?.manifest.icon}
        color={look?.color}
      />
    );
    // Spaces where it already runs (ticked, so nothing vanishes after a click) or where this reader may add it.
    const addable = spaces
      .map((space) => ({
        id: space.id,
        name: space.name,
        active: placement?.activeIn.includes(space.id) ?? false,
        pending: placement?.offeredIn.includes(space.id) ?? false,
      }))
      .filter((space) => space.active || mayActivateIn(item, space.id));
    const sharer = placement ? Object.values(placement.offeredBy).find(Boolean) : undefined;
    const shared = (placement?.offeredIn.length ?? 0) > 0;
    return {
      ...row,
      icon,
      status: activeHere ? (
        <span className="bg-success/10 text-success flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium">
          <Check className="size-3.5" aria-hidden />
          {t("catalogue.activeHere")}
        </span>
      ) : (
        <CatalogueAddButton
          spaces={addable}
          currentSpaceId={spaceId}
          busy={activate.isPending}
          onAdd={(targetSpaceId) => void onSetActive(row, targetSpaceId, true)}
        />
      ),
      meta: (
        <>
          <span className="truncate">
            {item.source === "system" ? t("catalogue.sourceSystem") : orgName}
          </span>
          {shared && (
            <span className="bg-primary/10 text-primary shrink-0 truncate rounded px-1.5 text-[11px] leading-5 font-medium">
              {sharer
                ? t("catalogue.sheet.offeredBy", { name: sharer })
                : t("catalogue.offeredHere")}
            </span>
          )}
        </>
      ),
    };
  });

  const activatable = offered.filter(canActivate).map((item) => item.id);
  const allSelected = activatable.length > 0 && activatable.every((id) => selected.has(id));
  const picked = offered.filter((item) => selected.has(item.id));
  const previewed = preview.target;
  const previewedItem: CardItem | undefined = previewed
    ? {
        id: previewed.id,
        displayName: previewed.name || previewed.id,
        description: previewed.description,
        type: active,
        source: previewed.source as CardItem["source"],
      }
    : undefined;

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
      return row ? gateOf(row, targetSpaceId, next) : { allowed: false, refusal: null };
    },
    busy: activate.isPending,
    onSetActive: (item, targetSpaceId, next) => void onSetActive(item, targetSpaceId, next),
  });
  const protocolColumn = useCatalogueProtocolColumn((item) => {
    const row = integrationById.get(item.id);
    return row ? integrationProtocol(row.manifest.source.kind) : undefined;
  });
  const actionsColumn = useCatalogueActionsColumn({
    isPending: activate.isPending || revoke.isPending,
    deedsOf,
    spaceNameOf,
    onOpen: (item) => preview.open(item.id),
    onMoveHome: (item) => moveHome.open(item.id),
    onShare: (item) => share.open(item.id),
    onRevoke: revokeFrom,
  });

  // The two READINGS are one set seen two ways, so they sit in the bar with search and
  // filters; the rail keeps the one axis that IS a partition: the kinds.
  const readings: { id: CatalogueReading; label: string }[] = [
    { id: "discover", label: t("catalogue.readingDiscover") },
    { id: "placed", label: t("catalogue.readingPlaced") },
  ];
  const readingSwitcher = (
    <div
      role="tablist"
      aria-label={t("catalogue.readingSelector")}
      className="bg-sidebar-accent/40 flex h-8 shrink-0 gap-0.5 rounded-lg p-0.5"
    >
      {readings.map((option) => (
        <Link
          key={option.id}
          to={hrefOf(option.id, active)}
          role="tab"
          aria-selected={reading === option.id}
          className={cn(
            "focus-visible:ring-ring flex items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2",
            reading === option.id
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
  const kindRows = KINDS.map((entry) => (
    <RailLink
      key={entry.type}
      item={{
        to: hrefOf(reading === "shared" ? "discover" : reading, entry.type),
        icon: entry.icon,
      }}
      label={t(entry.titleKey)}
      count={library?.packages[entry.type]?.length}
      active={reading !== "shared" && entry.type === active}
    />
  ));
  // Shown while any share waits and while open, so the last activation leaves the reader on its empty state.
  const shares = pendingShares(Object.values(library?.packages ?? {}).flat());
  const showShared = shares.length > 0 || reading === "shared";
  const sharedRow = showShared ? (
    <RailLink
      item={{ to: hrefOf("shared", active), icon: Inbox }}
      label={t("catalogue.shared.title")}
      count={shares.length}
      active={reading === "shared"}
    />
  ) : null;

  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        {sharedRow && <div className="px-3 py-3">{sharedRow}</div>}
        <RailGroup title={t("catalogue.kinds")} separated={Boolean(sharedRow)}>
          <nav className="flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {kindRows}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  return (
    <PanelDialog
      title={t("catalogue.title")}
      rail={rail}
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
            {t(kind.titleKey)}
          </span>
        )
      }
      onClose={onClose}
    >
      {reading === "shared" ? (
        <CatalogueShared
          shares={shares}
          spaceNameOf={spaceNameOf}
          mayActivateIn={mayActivateIn}
          busy={activate.isPending}
          onActivate={(pkg, targetSpaceId) =>
            void onSetActive(
              {
                id: pkg.id,
                displayName: pkg.name || pkg.id,
                type: pkg.type,
                source: pkg.source as CardItem["source"],
              },
              targetSpaceId,
              true,
            )
          }
          // Opens in the package's own kind, pushed as the sheet's own opening so Back returns to this list.
          onOpen={(pkg) =>
            navigate(catalogueHref(pkg.type, { packageId: pkg.id }), {
              state: modalOpeningState(location.state, "package"),
            })
          }
        />
      ) : previewed && previewedItem ? (
        <CataloguePreview
          item={previewed}
          type={active}
          spaces={librarySpaces}
          placement={placementOf(previewed)}
          gateOf={(targetSpaceId, next) => gateOf(previewed, targetSpaceId, next)}
          mayConfigureIn={(targetSpaceId) =>
            mayConfigurePackage(grantById.get(targetSpaceId), active)
          }
          integrations={library?.packages.integration ?? []}
          agents={library?.packages.agent ?? []}
          protocol={
            active === "integration" && integrationById.get(previewed.id)
              ? integrationProtocol(integrationById.get(previewed.id)!.manifest.source.kind)
              : undefined
          }
          actionsMenu={
            <PageActionsMenu>
              <CatalogueMenuItems
                item={previewedItem}
                deeds={catalogueDeeds(previewed)}
                spaceNameOf={spaceNameOf}
                // The page lives in the current space: a package placed only elsewhere would 404.
                open={
                  previewed.source === "system" || placementOf(previewed).here !== null
                    ? {
                        label: t("catalogue.openFullPage"),
                        icon: ExternalLink,
                        onSelect: () => navigate(packageDetailPath(active, previewed.id)),
                      }
                    : undefined
                }
                onMoveHome={(item) => moveHome.open(item.id)}
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
          items={offered}
          isLoading={isLoading || (active === "integration" && integrationsQuery.isLoading)}
          error={
            error instanceof Error
              ? error
              : active === "integration" && integrationsQuery.error instanceof Error
                ? integrationsQuery.error
                : null
          }
          holds={active}
          tableId={`catalogue-${active}`}
          entity={t(kind.titleKey)}
          emptyMessage={t(discovering ? "catalogue.emptyDiscover" : "catalogue.emptyPlaced")}
          emptyHint={t(discovering ? "catalogue.emptyDiscoverHint" : "catalogue.emptyPlacedHint")}
          emptyIcon={kind.icon}
          list={list}
          view={view}
          header={
            <>
              <SettingsHeading className="mb-4" title={t(kind.titleKey)} />
            </>
          }
          tabs={
            active === "integration" ? (
              <CollectionTabs
                value={execution}
                label={t("integrations.execution.label")}
                onChange={(next) => {
                  setSelected(new Set());
                  setExecution(next);
                }}
                options={INTEGRATION_EXECUTIONS.map((value) => ({
                  value,
                  label: t(`integrations.execution.${value}`),
                }))}
              />
            ) : undefined
          }
          // The library says where a package is placed, not what uses it: an activity filter would match nothing.
          activityFilter={false}
          originLabels={{
            title: t("catalogue.filter.origin"),
            local: t("catalogue.sourceOrg", { name: orgName }),
            system: t("catalogue.sourceSystem"),
          }}
          extraFilters={discovering ? [] : [stateFilter]}
          // A package this space has not activated cannot be run from here.
          cardRun={false}
          // A tick is a table affordance; cards carry their own deed.
          leadingColumns={view === "table" ? [selectColumn] : []}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[
            originColumn,
            ...(active === "integration" && execution === "remote" ? [protocolColumn] : []),
            ...spaceColumns,
            actionsColumn,
          ]}
          rowAction={(item) => preview.open(item.id)}
          // "Not yet", not "to add": a package the reader may not add is in the first section too.
          cardSections={
            discovering && spaceId
              ? (cards) => [
                  {
                    key: "to-add",
                    title: t("catalogue.section.toAdd", { space: spaceNameOf(spaceId) }),
                    items: cards.filter((card) => placementById.get(card.id)?.here !== "active"),
                  },
                  {
                    key: "already",
                    title: t("catalogue.section.already", { space: spaceNameOf(spaceId) }),
                    items: cards.filter((card) => placementById.get(card.id)?.here === "active"),
                  },
                ]
              : undefined
          }
          actions={
            <>
              {readingSwitcher}
              {view === "table" && picked.length > 0 ? (
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

      {/* A URL names a package; the dialog mounts only when its deed is the reader's. */}
      {moveHome.value && deedsOf({ id: moveHome.value })?.moveHome && (
        <MoveHomeSpaceDialog
          onClose={moveHome.close}
          packageId={moveHome.value}
          type={active}
          homeSpaceId={placementById.get(moveHome.value)?.homeSpaceId}
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
    </PanelDialog>
  );
}
