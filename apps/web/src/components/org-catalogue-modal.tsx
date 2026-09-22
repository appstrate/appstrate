// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue: what this space could be given, and what it already has.
 *
 * The rail carries the two questions in order, the way the settings rail
 * carries organisation then workspace:
 *
 * - **Where it comes from.** "Organisation" is what this org owns — imported,
 *   built, forked. "Appstrate" is what ships with the instance: a system
 *   package lives as ONE row with no `org_id`, loaded at boot from the `.afps`
 *   archives in the image (`services/system-packages.ts`), so every org sees
 *   the same ones. There is no remote registry to poll, and nothing to
 *   "install into the organisation" first.
 * - **Which kind**, under each.
 *
 * And the table says where each package is ALREADY active, because this
 * product has exactly two levels — in the org's catalogue, then switched on
 * space by space — and no third one. A catalogue that hid what is already
 * active could not answer "activate where?", which is the only question its
 * button raises. Two of those states are not a row anyone can act on:
 *
 * - A system agent, skill or MCP server is readable in every space without
 *   being switched on at all (`listOrgItems` unions `source = 'system'` with
 *   what is installed), so it says "always available" and offers no button.
 * - A system INTEGRATION is different: it has a real switch, and when the
 *   deployment lists it in `SYSTEM_INTEGRATIONS` it is ON in a space that has
 *   no `space_packages` row at all (`resolveIntegrationActivations`). The
 *   library cannot see that — it reports row presence — so the integrations
 *   view reads `/api/integrations`, which resolves it, and only that answer is
 *   trusted for "active here".
 *
 * A row opens HERE, not on the package's page: that page would throw away the
 * panel and the list, and its breadcrumb would claim the current space for a
 * package that is not in it.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Boxes, Layers, LibraryBig, Wrench } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { MoveHomeSpaceDialog } from "./package-detail/move-home-space-dialog";
import { SharePackageDialog } from "./package-detail/share-package-dialog";
import { ActivationClosureDialog } from "./catalogue-activation-dialog";
import { splitPackageRef } from "../lib/package-paths";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { fetchPackageDetail } from "../hooks/use-packages";
import { packageKeys } from "../lib/query-keys";
import { missingIntegrations, type MissingDependency } from "../lib/activation-closure";
import { maySetPackageActive } from "../lib/package-permissions";
import { useCurrentOrgId } from "../hooks/use-org";
import { useRevokePackageShare } from "../hooks/use-package-shares";
import { useAllIntegrations } from "../hooks/use-integrations";
import { useLibrary, useSetPackageActive, type LibraryPackageItem } from "../hooks/use-library";
import {
  cataloguePlacement,
  inPlacedTab,
  type CataloguePlacement,
  type PlacementState,
} from "../lib/catalogue-placement";
import { useModalParam } from "../hooks/use-modal-param";
import { useCatalogueKinds } from "../hooks/use-catalogue-kinds";
import { useLocalListParams } from "../lib/list-params";
import { canInstall } from "../lib/catalogue-install";
import {
  INTEGRATION_EXECUTIONS,
  integrationExecution,
  integrationProtocol,
  type IntegrationExecution,
} from "../lib/integration-collection";
import { CollectionTabs } from "./collection-tabs";
import { usePackageViewStore } from "../stores/list-view-store";
import type { CardItem } from "../pages/package-list";
import { CataloguePreview } from "./catalogue-preview";
import { CatalogueRowMenu, CatalogueStatusBadge } from "./catalogue-row";
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
import { ContextSelector } from "./settings/context-selector";
import { RailButton } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

/**
 * The catalogue's first axis: what is already PLACED in a space this caller
 * reaches, and what is not.
 *
 * It used to be provenance (the org's packages versus Appstrate's), which
 * answered a question nobody asks first: a reader wants to know what they
 * already have before knowing who made it. Provenance is a filter now.
 *
 * The old spellings (`org`, `appstrate`) still resolve — they are in links,
 * in the navigation and in bookmarks — and land on the placed tab.
 */
export type CatalogueScope = "placed" | "discover";

function catalogueScope(raw: string): CatalogueScope {
  return raw === "discover" ? "discover" : "placed";
}

const KINDS: Array<{ type: PackageType; icon: typeof Layers; titleKey: string }> = [
  { type: "agent", icon: Layers, titleKey: "packages.type.agents" },
  { type: "skill", icon: Wrench, titleKey: "packages.type.skills" },
  // No local MCP servers: a server is the engine of a local integration, never
  // installed on its own — the integration is what this panel installs.
  { type: "integration", icon: Boxes, titleKey: "packages.type.integrations" },
];

/**
 * Columns the catalogue drops. `source` gives way to the catalogue's own origin
 * column, which names the provider instead of badging only one side, and
 * `keywords` goes because the library carries none: it was a column of dashes.
 */
const CATALOGUE_DROPS = ["state", "actions", "source", "keywords"];

function isPackageType(value: string): value is PackageType {
  return KINDS.some((kind) => kind.type === value);
}

export function OrgCatalogueModal({
  scope: rawScope,
  type,
  onSelect,
  onClose,
}: {
  /** Both straight from the URL, so a link opens exactly one view. */
  scope: string;
  type: string;
  onSelect: (scope: CatalogueScope, type: PackageType) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const allowed = useCatalogueKinds();
  const spaceId = useCurrentSpaceId();
  const orgId = useCurrentOrgId();
  const { currentOrg } = useOrg();
  const { data: library, isLoading, error } = useLibrary();
  const activate = useSetPackageActive();
  const list = useLocalListParams();
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The read has an address of its own: reload lands on it, Back leaves it.
  const preview = useModalParam("package");
  const qc = useQueryClient();

  const scope = catalogueScope(rawScope);
  const discovering = scope === "discover";
  const visibleKinds = KINDS.filter((kind) => allowed.includes(kind.type));
  const active =
    (isPackageType(type) && visibleKinds.some((k) => k.type === type)
      ? type
      : visibleKinds[0]?.type) ??
    // With no installable kind at all the panel would not have been opened.
    "agent";
  const kind = KINDS.find((k) => k.type === active)!;
  const orgName = currentOrg?.name ?? "";

  // Integrations resolve their activation server-side, and only their view
  // pays for the request.
  const { data: integrations } = useAllIntegrations({ enabled: active === "integration" });
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  const spaces = library?.spaces ?? [];
  // The library names the spaces this caller reaches; `/api/spaces` carries the
  // grant in each, which is the verdict a switch in that column answers to.
  const { data: reachable } = useSpaces();
  const grantById = new Map((reachable ?? []).map((space) => [space.id, space] as const));
  /**
   * The spaces the reader narrowed to, from the URL.
   *
   * In the URL rather than in the bar's local state for two reasons: a link can
   * open the catalogue already narrowed (a package page's "Parcourir le
   * catalogue" opens on the space you were in), and moving from Agents to
   * Skills keeps it, because switching kinds keeps the query.
   *
   * Narrowing shows the space in a chip, so the context is written on the
   * screen and removed in one click — the difference between this and the
   * implicit "ici" the catalogue used to have.
   */
  const routerLocation = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const knownSpaceIds = spaces.map((space) => space.id);
  const chosenSpaces = (searchParams.get("space") ?? "")
    .split(",")
    .filter((id) => knownSpaceIds.includes(id));
  const visibleSpaces =
    chosenSpaces.length > 0 ? spaces.filter((space) => chosenSpaces.includes(space.id)) : spaces;
  const setChosenSpaces = (next: string[]) =>
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next.length > 0) out.set("space", next.join(","));
        else out.delete("space");
        return out;
      },
      // The overlay's background travels in the state; dropping it would
      // close the catalogue under the reader's hand.
      { replace: true, state: routerLocation.state },
    );
  const spaceColumnsInput = visibleSpaces.map((space) => ({
    id: space.id,
    name: space.name,
    grant: grantById.get(space.id),
  }));

  /**
   * One row's placement, for every kind but the integrations.
   *
   * An INTEGRATION resolves its activation server-side: a system one is ON in a
   * space that has no row at all (`resolveIntegrationActivations`), which the
   * library cannot see because it reports rows. So that kind reads
   * `/api/integrations` for "active here" and the library for the rest.
   */
  const placementOf = (item: LibraryPackageItem): CataloguePlacement => {
    const base = cataloguePlacement(item, spaceId, {
      // A system agent, skill or MCP server is readable in every space without
      // being switched on; a system integration has a real switch.
      everywhere: item.source === "system" && active !== "integration",
    });
    if (active !== "integration") return base;
    const activeHere = Boolean(integrationById.get(item.id)?.active);
    if (!activeHere || !spaceId || base.here === "active") return base;
    return { ...base, here: "active", activeIn: [...base.activeIn, spaceId] };
  };

  // Integrations split by execution, as on their page: remote (API or hosted
  // MCP) or local (an MCP server run in the sandbox).
  const [execution, setExecution] = useState<IntegrationExecution>("remote");
  const ofKind = (library?.packages[active] ?? []) as LibraryPackageItem[];
  const placementById = new Map(ofKind.map((item) => [item.id, placementOf(item)] as const));
  const spaceNameOf = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  // The two halves of the first axis: what is already placed in a space this
  // caller reaches, and what could still be placed there.
  const all = ofKind.filter((item) => {
    if (active === "integration") {
      const row = integrationById.get(item.id);
      if (row && integrationExecution(row) !== execution) return false;
    }
    const placement = placementById.get(item.id);
    return placement ? inPlacedTab(placement) !== discovering : false;
  });
  const stateOf = (item: CardItem): CatalogueRowState => {
    const placement = placementById.get(item.id);
    if (!placement) return { activeIn: [], activeHere: false, everywhere: false };
    return {
      activeIn: placement.activeIn.map(spaceNameOf),
      activeHere: placement.here === "active",
      placedHere: placement.here === "inactive",
      offeredHere: placement.here === "offered",
      everywhere: placement.everywhere,
    };
  };
  const canActivate = (item: CardItem) => canInstall(item, stateOf(item));
  const rowOf = (item: CardItem) => ofKind.find((row) => row.id === item.id);
  const writableOf = (item: CardItem) => rowOf(item)?.home_writable === true;
  const shareableOf = (item: CardItem) => rowOf(item)?.home_shareable === true;
  // Every space the package reaches through an OFFER: each one can be withdrawn,
  // and withdrawing takes the activation it backs with it.
  const sharedSpacesOf = (item: CardItem) =>
    (rowOf(item)?.placements ?? [])
      .filter((placement) => placement.via === "shared")
      .map((placement) => ({ id: placement.space_id, name: spaceNameOf(placement.space_id) }));
  /**
   * An activation waiting on a question: switching an agent on in a space its
   * integrations do not run gives an agent that cannot start, and nothing said
   * so. The switch asks before writing, and only when there is something to
   * ask — every other activation stays one click.
   */
  const [closure, setClosure] = useState<{
    item: CardItem;
    spaceId: string;
    missing: MissingDependency[];
  } | null>(null);
  const [moveHome, setMoveHome] = useState<CardItem | null>(null);
  const [sharing, setSharing] = useState<CardItem | null>(null);
  const revoke = useRevokePackageShare();
  /**
   * Withdraw the offer that places this package in that space.
   *
   * The target is the SPACE id, which is how `GET …/shares` publishes a space
   * target; a share to a person publishes their user id instead, and the
   * personal space it resolved to is never on the wire. So this withdraws the
   * offers the matrix can show, and a person's own offer is withdrawn from the
   * package's share dialog.
   */
  const revokeFrom = (item: CardItem, targetSpaceId: string) =>
    revoke.mutate(
      {
        params: { path: { ...splitPackageRef(item.id), target: targetSpaceId } },
      },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
          toast.success(t("catalogue.revoked", { space: spaceNameOf(targetSpaceId) }));
        },
        onError: (err: unknown) => toast.error(getErrorMessage(err)),
      },
    );

  // The dimension worth narrowing is the STATE a row is in, which is what the
  // placement model made expressible: a package can be here and off, or here
  // and offered to nobody's answer yet. "Where does it run" was the closest
  // this screen could say before, and it could not tell those two apart.
  const states = list.values("state", ["active", "inactive", "offered"] as const);
  const visibleIds = visibleSpaces.map((space) => space.id);
  /** Its states across the spaces on screen: the columns are the question. */
  const statesIn = (placement: CataloguePlacement): PlacementState[] => {
    // A system package is readable everywhere without a row: it is active in
    // every sense the reader cares about.
    if (placement.everywhere) return ["active"];
    const out: PlacementState[] = [];
    if (placement.activeIn.some((id) => visibleIds.includes(id))) out.push("active");
    if (placement.inactiveIn.some((id) => visibleIds.includes(id))) out.push("inactive");
    if (placement.offeredIn.some((id) => visibleIds.includes(id))) out.push("offered");
    return out;
  };
  const rows = all.filter((item) => {
    const placement = placementById.get(item.id);
    if (!placement) return false;
    // Narrowed to some spaces, the placed half shows what is placed IN them —
    // "what is in this space" is the question a narrowed view asks. Découvrir
    // is untouched: its rows are placed nowhere, by definition.
    if (!discovering && chosenSpaces.length > 0 && statesIn(placement).length === 0) return false;
    if (states.length === 0) return true;
    return statesIn(placement).some((state) => states.includes(state));
  });
  // Offered only when there is a choice to make: with one space, the only
  // column is already that space.
  const spaceFilter: FilterSpec | null =
    spaces.length > 1
      ? {
          id: "space",
          label: t("catalogue.filter.space"),
          values: chosenSpaces,
          options: spaces.map((space) => ({ value: space.id, label: space.name })),
          onChange: setChosenSpaces,
        }
      : null;
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
  // Provenance: an attribute of the package, not the question a reader asks
  // first — which is why it stopped being the rail's axis.
  const origins = list.values("origin", ["org", "system"] as const);
  const shown = rows.filter(
    (item) => origins.length === 0 || origins.includes(item.source === "system" ? "system" : "org"),
  );
  const originFilter: FilterSpec = {
    id: "origin",
    label: t("catalogue.filter.origin"),
    values: origins,
    options: [
      { value: "org", label: t("catalogue.sourceOrg", { name: orgName }) },
      { value: "system", label: t("catalogue.sourceSystem") },
    ],
    onChange: list.setValues("origin"),
  };

  const activateOne = (item: { id: string; displayName: string }) => {
    if (!spaceId) return;
    const target = item;
    activate.mutate(
      { spaceId, packageId: target.id, active: true },
      {
        onSuccess: () => {
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          toast.success(t("packages.installed", { name: target.displayName }));
        },
        onError: (err: unknown) => toast.error(getErrorMessage(err)),
      },
    );
  };

  const offered: CardItem[] = shown.map((item) => {
    const row: CardItem = {
      id: item.id,
      displayName: item.name || item.id,
      description: item.description,
      type: active,
      source: item.source as CardItem["source"],
    };
    if (view !== "cards") return row;
    // What the table puts in its last two columns, a card carries in a footer
    // it ALWAYS has: same line, same height, whatever the row's state — a card
    // that grows a footer only when it can be activated made every grid a
    // ragged one.
    const state = stateOf(row);
    return {
      ...row,
      actions: (
        <>
          <span className="text-muted-foreground truncate text-xs">
            {state.everywhere
              ? t("catalogue.allSpaces")
              : state.activeIn.length > 0
                ? state.activeIn.join(" · ")
                : t("catalogue.activeNowhere")}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <CatalogueStatusBadge state={state} />
            <CatalogueRowMenu
              item={row}
              homeWritable={writableOf(row) && !state.everywhere}
              homeShareable={shareableOf(row) && !state.everywhere}
              sharedSpaces={sharedSpacesOf(row)}
              isPending={activate.isPending || revoke.isPending}
              onOpen={(item) => preview.open(item.id)}
              onMoveHome={setMoveHome}
              onShare={setSharing}
              onRevoke={revokeFrom}
            />
          </span>
        </>
      ),
    };
  });

  const activatable = offered.filter(canActivate).map((item) => item.id);
  const allSelected = activatable.length > 0 && activatable.every((id) => selected.has(id));
  const picked = offered.filter((item) => selected.has(item.id));
  const reading = preview.value ? rows.find((item) => item.id === preview.value) : undefined;

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
    // `null` when the caller does not reach the home: the server withholds the
    // id rather than naming a space they cannot enter (RBAC spec §6.9).
    return home ? spaceNameOf(home) : null;
  });
  const setActive = (item: CardItem, targetSpaceId: string, next: boolean) =>
    activate.mutate(
      { spaceId: targetSpaceId, packageId: item.id, active: next },
      { onError: (err: unknown) => toast.error(getErrorMessage(err)) },
    );

  /**
   * Switching a package on, with the one question worth asking first.
   *
   * Only an AGENT has a closure the target space has to hold: its skills travel
   * with it (judged from its home), its integrations do not. The manifest is
   * read at the moment of the click rather than held open for every row —
   * turning a switch on is rare, and holding a detail per row is not.
   */
  const onSetActive = async (item: CardItem, targetSpaceId: string, next: boolean) => {
    if (!next || active !== "agent") return setActive(item, targetSpaceId, next);
    let declared: { id: string }[];
    try {
      const detail = await qc.fetchQuery({
        queryKey: packageKeys.detail("agents", orgId ?? "", spaceId ?? "", item.id, null),
        queryFn: () => fetchPackageDetail("agent", item.id),
      });
      declared = detail.dependencies.integrations;
    } catch {
      // The question is a courtesy; the run gate is the authority. A read that
      // fails must not stop the deed the caller asked for.
      return setActive(item, targetSpaceId, next);
    }
    const missing = missingIntegrations(
      declared,
      library?.packages.integration ?? [],
      targetSpaceId,
      // A system INTEGRATION is not exempt the way a system agent or skill is:
      // it has a real switch, and a space that has not turned it on does not
      // run it (`resolveIntegrationActivations`). The verdict is the target
      // space's alone.
      () => maySetPackageActive(grantById.get(targetSpaceId), "integration", true),
    );
    if (missing.length === 0) return setActive(item, targetSpaceId, next);
    setClosure({ item, spaceId: targetSpaceId, missing });
  };

  const spaceColumns = useCatalogueSpaceColumns({
    spaces: spaceColumnsInput,
    type: active,
    placementOf: (item) => placementById.get(item.id),
    busy: activate.isPending,
    onSetActive: (item, targetSpaceId, next) => void onSetActive(item, targetSpaceId, next),
  });
  const protocolColumn = useCatalogueProtocolColumn((item) => {
    const row = integrationById.get(item.id);
    return row ? integrationProtocol(row) : undefined;
  });
  const actionsColumn = useCatalogueActionsColumn({
    isPending: activate.isPending || revoke.isPending,
    placementOf: (item) => placementById.get(item.id),
    writableOf,
    shareableOf,
    sharedSpacesOf,
    onOpen: (item) => preview.open(item.id),
    onMoveHome: setMoveHome,
    onShare: setSharing,
    onRevoke: revokeFrom,
  });

  const show = (nextScope: CatalogueScope, nextType: PackageType) => {
    setSelected(new Set());
    list.reset();
    preview.close();
    onSelect(nextScope, nextType);
  };

  // One group, never two: the kinds are the same four words under either half
  // of the axis, and a rail that lists them twice makes the reader compare two
  // identical lists to find the difference. The scope is a SELECTOR at the head
  // of the group, exactly where the settings rail puts the organisation and the
  // workspace it is showing.
  //
  // What it selects is POSSESSION: what is already placed in a space you reach,
  // or what you could still place there. Provenance moved to the filters — it
  // describes a package, it is not the question a reader opens with.
  const scopeOptions = [
    { id: "placed", name: t("catalogue.scopePlaced") },
    { id: "discover", name: t("catalogue.scopeDiscover") },
  ];
  const selector = (
    <ContextSelector
      value={scope}
      label={t("catalogue.scopeSelector")}
      options={scopeOptions}
      onValueChange={(next) => show(catalogueScope(next), active)}
    />
  );
  const kindRows = visibleKinds.map((entry) => (
    <RailButton
      key={entry.type}
      icon={entry.icon}
      label={t(entry.titleKey)}
      active={entry.type === active}
      onClick={() => show(scope, entry.type)}
    />
  ));

  // The settings rail, to the pixel: same header, same titled group, same
  // selector at its head, same rows.
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.scopeSelector")}>
          {selector}
          <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {kindRows}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  const mobileNav = (
    <div>
      {selector}
      <nav
        aria-label={t("catalogue.kinds")}
        className="-mx-1 mt-2 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {visibleKinds.map((entry) => (
          <Button
            key={entry.type}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={entry.type === active}
            className="aria-pressed:bg-accent shrink-0 gap-2 px-3"
            onClick={() => show(scope, entry.type)}
          >
            <entry.icon className="size-4 shrink-0" />
            {t(entry.titleKey)}
          </Button>
        ))}
      </nav>
    </div>
  );

  return (
    <PanelDialog
      title={t("catalogue.title")}
      rail={rail}
      mobileNav={mobileNav}
      contentScrollArea
      closeLabel={t("btn.close", { ns: "common" })}
      reserveCloseArea
      onClose={onClose}
    >
      {reading ? (
        <CataloguePreview
          item={reading}
          type={active}
          spaces={library?.spaces ?? []}
          isActivating={activate.isPending}
          canActivate={canActivate({
            id: reading.id,
            displayName: reading.name,
            type: active,
          })}
          onActivate={() =>
            activateOne({ id: reading.id, displayName: reading.name || reading.id })
          }
          onBack={preview.close}
        />
      ) : (
        <PackageCollection
          items={offered}
          isLoading={isLoading}
          error={error instanceof Error ? error : null}
          holds={active}
          entity={t(kind.titleKey)}
          emptyMessage={t(discovering ? "catalogue.emptyDiscover" : "catalogue.emptyPlaced")}
          emptyHint={t(discovering ? "catalogue.emptyDiscoverHint" : "catalogue.emptyPlacedHint")}
          emptyIcon={kind.icon}
          list={list}
          view={view}
          onViewChange={setView}
          header={<SettingsHeading className="mb-4" title={t(kind.titleKey)} />}
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
          // The page's own bar, not a panel variant of it: same icon-only
          // filter and column buttons, in the same place, at the same size.
          placement="page"
          // The library says where a package is placed, not what runs or uses
          // it, so the activity dimension would filter on nothing. Provenance
          // is one of this bar's own filters now, in the shape every other
          // filter here has, rather than the collection's built-in one.
          activityFilter={false}
          originFilter={false}
          extraFilters={[
            ...(spaceFilter ? [spaceFilter] : []),
            ...(discovering ? [] : [stateFilter]),
            originFilter,
          ]}
          // A package this space has not activated cannot be run from here.
          cardRun={false}
          // A tick is a table affordance; in cards, each card carries its own
          // deed instead, which is why the bulk action follows the view.
          leadingColumns={view === "table" ? [selectColumn] : []}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[
            originColumn,
            ...(active === "integration" && execution === "remote" ? [protocolColumn] : []),
            ...spaceColumns,
            actionsColumn,
          ]}
          rowAction={(item) => preview.open(item.id)}
          actions={
            view === "table" && picked.length > 0 ? (
              <Button
                type="button"
                size="sm"
                disabled={activate.isPending || !spaceId}
                onClick={() => picked.forEach(activateOne)}
              >
                {activate.isPending && <Spinner />}
                {t("catalogue.activateSelection", { count: picked.length })}
              </Button>
            ) : undefined
          }
        />
      )}
      {/* The two deeds that act on the package itself rather than on one of
          its placements. They are the dialogs the package's own page mounts,
          so the gesture reads the same from either surface. */}
      {closure && (
        <ActivationClosureDialog
          packageName={closure.item.displayName}
          spaceName={spaceNameOf(closure.spaceId)}
          missing={closure.missing}
          isPending={activate.isPending}
          onClose={() => setClosure(null)}
          onAgentOnly={() => {
            setActive(closure.item, closure.spaceId, true);
            setClosure(null);
          }}
          onActivateAll={() => {
            // The agent AND what its run needs, in the order a reader would do
            // it by hand. Each is its own call: the API has no cascade, and one
            // refusal must not take the others down.
            setActive(closure.item, closure.spaceId, true);
            for (const entry of closure.missing) {
              activate.mutate(
                { spaceId: closure.spaceId, packageId: entry.id, active: true },
                { onError: (err: unknown) => toast.error(getErrorMessage(err)) },
              );
            }
            setClosure(null);
          }}
        />
      )}

      {moveHome && (
        <MoveHomeSpaceDialog
          open
          onClose={() => setMoveHome(null)}
          packageId={moveHome.id}
          type={active}
          homeSpaceId={placementById.get(moveHome.id)?.homeSpaceId}
        />
      )}
      {sharing && (
        <SharePackageDialog
          open
          onClose={() => setSharing(null)}
          packageId={sharing.id}
          type={active}
          homeSpaceId={placementById.get(sharing.id)?.homeSpaceId}
          canPublish={writableOf(sharing)}
        />
      )}
    </PanelDialog>
  );
}
