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
 * - A SYSTEM package is placed in every space by construction, and with no
 *   `space_packages` row of its own the deployment's default decides: on for a
 *   system agent, skill or MCP server, on for an integration the deployment
 *   offers (`isActiveHere`, `services/package-activation.ts`). It is not
 *   switch-less — an explicit row outvotes that default, which is the sticky
 *   opt-out `deactivatePackage` writes — so its switch is drawn like any
 *   other, on by default.
 * - A system INTEGRATION is the one kind the library cannot answer for: the
 *   offered set is a boot-time env constant, so the integrations view reads
 *   `/api/integrations`, which resolves it, and only that answer is trusted
 *   for "active here".
 *
 * A row opens HERE, not on the package's page: that page would throw away the
 * panel and the list, and its breadcrumb would claim the current space for a
 * package that is not in it.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowLeft,
  Boxes,
  Check,
  ExternalLink,
  Inbox,
  Layers,
  LibraryBig,
  Wrench,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { MoveHomeSpaceDialog } from "./package-detail/move-home-space-dialog";
import { SharePackageDialog } from "./package-detail/share-package-dialog";
import { ActivationClosureDialog } from "./catalogue-activation-dialog";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { catalogueHref } from "../lib/catalogue-link";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { fetchPackageDetail } from "../hooks/use-packages";
import { packageKeys } from "../lib/query-keys";
import { missingIntegrations, type MissingDependency } from "../lib/activation-closure";
import { mayConfigurePackage, maySetPackageActive } from "../lib/package-permissions";
import { useCurrentOrgId } from "../hooks/use-org";
import { useRevokePackageShare } from "../hooks/use-package-shares";
import { useAllIntegrations } from "../hooks/use-integrations";
import { useAgents } from "../hooks/use-packages";
import { AgentIdentityTile } from "./agent-identity";
import { IntegrationIcon } from "./integration-icon";
import {
  useCatalogueLibrary,
  useSetPackageActive,
  type LibraryPackageItem,
} from "../hooks/use-library";
import {
  cataloguePlacement,
  inPlacedTab,
  pendingShares,
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
import type { CardItem } from "../pages/package-list";
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
import { RailButton } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

/**
 * The catalogue's two READINGS of one set: `discover` browses every package in
 * cards, `placed` manages what the reader's spaces hold, space by space.
 *
 * The URL still says `placed` for the second, which is what it shows.
 *
 * It used to be provenance (the org's packages versus Appstrate's), which
 * answered a question nobody asks first: a reader wants to know what they
 * already have before knowing who made it. Provenance is a filter now.
 *
 * The old spellings (`org`, `appstrate`) still resolve — they are in links,
 * in the navigation and in bookmarks — and land on the placed tab.
 */
export type CatalogueScope = "placed" | "discover" | "shared";

function catalogueScope(raw: string): CatalogueScope {
  if (raw === "discover" || raw === "shared") return raw;
  return "placed";
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
  const { data: library, isLoading, error } = useCatalogueLibrary();
  const activate = useSetPackageActive();
  const list = useLocalListParams();
  // Each half has the form its job needs, and the reader does not choose it.
  // Découvrir is BROWSING — a name, what it does, where it comes from — which
  // is what a card carries and a table row crushes. Vos espaces is MANAGING —
  // the state in each space, compared down a column — which only a table can
  // lay out. A toggle would offer each half the other's wrong shape.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The read has an address of its own: reload lands on it, Back leaves it.
  const preview = useModalParam("package");
  const qc = useQueryClient();

  const scope = catalogueScope(rawScope);
  const discovering = scope === "discover";
  const view: "cards" | "table" = discovering ? "cards" : "table";
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
  // The library carries no icon. The agents this space runs do (their index
  // reads the manifest), and so do integrations (`/api/integrations`); any
  // other package gets its kind's tile, the way the package page draws one.
  const { data: agentsHere } = useAgents();
  const agentLook = new Map((agentsHere ?? []).map((agent) => [agent.id, agent] as const));
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  const librarySpaces = library?.spaces ?? [];
  /**
   * The space the app is standing in leads, always.
   *
   * The server orders spaces with the organization's default first, so a
   * reader working in Production opened on Default: the first column they read
   * was not theirs. Theirs is the anchor — it is where a launch, a run and a
   * connection land — so it heads the table, it is the column that survives a
   * narrow width (tier 2, in `useCatalogueSpaceColumns`), and no filter moves
   * it.
   */
  const spaces = [...librarySpaces].sort(
    (a, b) => Number(b.id === spaceId) - Number(a.id === spaceId),
  );
  // The library names the spaces this caller reaches; `/api/spaces` carries the
  // grant in each, which is the verdict a switch in that column answers to.
  const { data: reachable } = useSpaces();
  const grantById = new Map((reachable ?? []).map((space) => [space.id, space] as const));
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Every space the reader reaches is a column, theirs first. Narrowing to one
  // used to be a mode and a filter of its own; hiding a column is what the
  // column menu is for, and "what does my space run" is Découvrir's question.
  const spaceColumnsInput = spaces.map((space) => ({
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
    const base = cataloguePlacement(item, spaceId);
    if (active !== "integration") return base;
    const activeHere = Boolean(integrationById.get(item.id)?.active);
    if (!activeHere || !spaceId || base.here === "active") return base;
    return { ...base, here: "active", activeIn: [...base.activeIn, spaceId] };
  };

  // Integrations split by execution, as on their page: remote (API or hosted
  // MCP) or local (an MCP server run in the sandbox).
  const [execution, setExecution] = useState<IntegrationExecution>("remote");
  const ofKind: LibraryPackageItem[] = library?.packages[active] ?? [];
  const placementById = new Map(ofKind.map((item) => [item.id, placementOf(item)] as const));
  const spaceNameOf = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  // The two halves of the first axis: what is already placed in a space this
  // caller reaches, and what could still be placed there.
  const all = ofKind.filter((item) => {
    if (active === "integration") {
      const row = integrationById.get(item.id);
      if (row && integrationExecution(row) !== execution) return false;
    }
    // Découvrir is the WHOLE catalogue, the way a store keeps showing what you
    // already own with a tick beside it. It used to hold the complement of the
    // other half, so a package left it the moment it was placed — and for
    // agents and skills that emptied it, since an organisation's own packages
    // are placed by their home. Espaces stays the matrix of what is placed.
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
  const canActivate = (item: CardItem) => canInstall(item, stateOf(item));
  /**
   * May this reader switch the package ON in that space?
   *
   * Two verdicts, and the card used to ask only the first: the activation
   * right in the target space, and — when the package is not placed there
   * yet — the SHARE right in its home, since the route shares it before it
   * activates it (`routes/spaces.ts`). Without the second, a member saw an
   * "Ajouter" the server refused.
   */
  const mayActivateIn = (pkg: LibraryPackageItem, targetSpaceId: string) =>
    maySetPackageActive(grantById.get(targetSpaceId), pkg.type, true) &&
    (pkg.placements.some((placement) => placement.space_id === targetSpaceId) ||
      pkg.home_shareable === true);
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
      },
    );

  /**
   * The STATE filter — Par espace only.
   *
   * The matrix compares spaces, so its states are the placement's: active,
   * switched off, shared and waiting, anywhere on screen. Découvrir has none:
   * its two sections already say here / not here, and a share waiting has its
   * own entry at the head of the rail. `pages/catalogue.tsx` drops the key when
   * the reading changes, so it never lingers on the way to Découvrir.
   */
  const STATE_VALUES = ["active", "inactive", "offered"] as const;
  const states = discovering
    ? []
    : (searchParams.get("state") ?? "")
        .split(",")
        .filter((value) => (STATE_VALUES as readonly string[]).includes(value));
  const setStates = (next: string[]) =>
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        if (next.length > 0) out.set("state", next.join(","));
        else out.delete("state");
        return out;
      },
      // The overlay's background travels in the state; dropping it would
      // close the catalogue under the reader's hand.
      { replace: true, state: routerLocation.state },
    );
  /** Its states across every space: the columns are the question. */
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
    onChange: setStates,
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

  const activateOne = (item: { id: string }) => {
    if (!spaceId) return;
    activate.mutate(
      { spaceId, packageId: item.id, active: true },
      {
        // The mutation says it worked; the row only leaves the selection.
        onSuccess: () =>
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          }),
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
    // A card carries a footer it ALWAYS has: same line, same height. It says
    // where the package comes from, and then answers the one question a
    // browsing reader asks — does the space I am in already run this? A tick
    // when it does, the deed when it does not. The finer question ("and in my
    // other spaces?") is the matrix, one tab away.
    const placement = placementById.get(item.id);
    const activeHere = placement?.here === "active";
    const look = agentLook.get(item.id);
    const icon =
      active === "agent" ? (
        <AgentIdentityTile
          agentId={item.id}
          icon={look?.icon}
          color={look?.color}
          className="size-10 rounded-[10px]"
        />
      ) : active === "integration" ? (
        <IntegrationIcon src={integrationById.get(item.id)?.manifest.icon} />
      ) : (
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-[10px]">
          <Wrench className="size-5" aria-hidden />
        </span>
      );
    // The spaces the add menu shows: where it already runs (ticked, so the
    // picture is whole and nothing vanishes after a click) and where this
    // reader could still add it (`mayActivateIn`). Their own space comes
    // first, as everywhere; a space where a share waits says so.
    const addable = spaces
      .map((space) => ({
        id: space.id,
        name: space.name,
        active: placement?.activeIn.includes(space.id) ?? false,
        pending: placement?.offeredIn.includes(space.id) ?? false,
      }))
      .filter((space) => space.active || mayActivateIn(item, space.id));
    // A share waiting on one of the reader's spaces is said on the card too:
    // browsing must not be the one reading where a decision stays invisible.
    const sharer = placement ? Object.values(placement.offeredBy).find(Boolean) : undefined;
    const shared = (placement?.offeredIn.length ?? 0) > 0;
    return {
      ...row,
      icon,
      // The state leads, top right, where a store puts its "+" or its tick:
      // it is the one thing a browsing reader looks for on every card.
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
  const reading = preview.value ? rows.find((item) => item.id === preview.value) : undefined;
  const readingItem: CardItem | undefined = reading
    ? {
        id: reading.id,
        displayName: reading.name || reading.id,
        description: reading.description,
        type: active,
        source: reading.source as CardItem["source"],
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
    // `null` when the caller does not reach the home: the server withholds the
    // id rather than naming a space they cannot enter (RBAC spec §6.9).
    return home ? spaceNameOf(home) : null;
  });
  /**
   * Every switch, menu item and button that changes where a package runs
   * lands here. What it did, and why it failed, are said by the mutation
   * itself (`useSetPackageActive`), once for every surface.
   */
  const setActive = (item: CardItem, targetSpaceId: string, next: boolean) =>
    activate.mutate({ spaceId: targetSpaceId, packageId: item.id, active: next });

  /**
   * Switching a package on, with the one question worth asking first.
   *
   * Only an AGENT has a closure the target space has to hold: its skills travel
   * with it (judged from its home), its integrations do not. The manifest is
   * read at the moment of the click rather than held open for every row —
   * turning a switch on is rare, and holding a detail per row is not.
   */
  const onSetActive = async (item: CardItem, targetSpaceId: string, next: boolean) => {
    if (!next || item.type !== "agent") return setActive(item, targetSpaceId, next);
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
    currentSpaceId: spaceId,
    type: active,
    placementOf: (item) => placementById.get(item.id),
    shareableOf,
    busy: activate.isPending,
    onSetActive: (item, targetSpaceId, next) => void onSetActive(item, targetSpaceId, next),
  });
  const protocolColumn = useCatalogueProtocolColumn((item) => {
    const row = integrationById.get(item.id);
    return row ? integrationProtocol(row) : undefined;
  });
  const actionsColumn = useCatalogueActionsColumn({
    isPending: activate.isPending || revoke.isPending,
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

  /**
   * The two READINGS of one catalogue, in the bar's corner rather than the
   * rail's head.
   *
   * They used to be the rail's first axis, which made them read as two places
   * holding different things. They are one set seen two ways — browsing in
   * cards, managing in a matrix — so they sit with the other ways of seeing
   * the list (search, filters, columns), and the rail is left with the one
   * axis that IS a partition: the kinds.
   */
  const readings: { id: CatalogueScope; label: string }[] = [
    { id: "discover", label: t("catalogue.scopeDiscover") },
    { id: "placed", label: t("catalogue.scopePlaced") },
  ];
  const readingSwitcher = (
    <div
      role="tablist"
      aria-label={t("catalogue.scopeSelector")}
      className="bg-sidebar-accent/40 flex h-8 shrink-0 gap-0.5 rounded-lg p-0.5"
    >
      {readings.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={scope === option.id}
          onClick={() => show(option.id, active)}
          className={cn(
            "focus-visible:ring-ring flex items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2",
            scope === option.id
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  const kindRows = visibleKinds.map((entry) => (
    <RailButton
      key={entry.type}
      icon={entry.icon}
      label={t(entry.titleKey)}
      count={library?.packages[entry.type]?.length}
      active={scope !== "shared" && entry.type === active}
      onClick={() => show(scope === "shared" ? "discover" : scope, entry.type)}
    />
  ));
  // Every share waiting, across kinds: the list a decision is taken from when
  // there is more than one. Shown while any waits, and while it is open, so
  // the last activation leaves the reader on its empty state, not elsewhere.
  const shares = pendingShares(Object.values(library?.packages ?? {}).flat());
  const showShared = shares.length > 0 || scope === "shared";
  const sharedRow = showShared ? (
    <RailButton
      icon={Inbox}
      label={t("catalogue.shared.title")}
      count={shares.length}
      active={scope === "shared"}
      onClick={() => show("shared", active)}
    />
  ) : null;

  // The settings rail, to the pixel: same header, same titled group, same rows.
  // The two readings left it for the bar; the kinds are its only axis.
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        {/* The decisions waiting come first, alone and untitled — a group
            heading over one transient row is noise — and a rule sets them
            apart from the kinds, the way settings separates its scopes. */}
        {sharedRow && <div className="px-3 py-3">{sharedRow}</div>}
        <RailGroup title={t("catalogue.kinds")} separated={Boolean(sharedRow)}>
          <nav className="flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {kindRows}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  const mobileNav = (
    <div>
      <nav aria-label={t("catalogue.kinds")} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {showShared && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={scope === "shared"}
            className="aria-pressed:bg-accent shrink-0 gap-2 px-3"
            onClick={() => show("shared", active)}
          >
            <Inbox className="size-4 shrink-0" />
            {t("catalogue.shared.title")}
          </Button>
        )}
        {visibleKinds.map((entry) => (
          <Button
            key={entry.type}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={scope !== "shared" && entry.type === active}
            className="aria-pressed:bg-accent shrink-0 gap-2 px-3"
            onClick={() => show(scope === "shared" ? "discover" : scope, entry.type)}
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
      // Where the reader is, kept in place while the pane scrolls: the kind
      // they are browsing, or the package they opened, with the way back.
      contentHeader={(stuck) =>
        reading ? (
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
              {reading.name || reading.id}
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
      {scope === "shared" ? (
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
          // The sheet belongs to the package's own kind, so it opens there;
          // Back returns to that kind's list.
          onOpen={(pkg) => navigate(catalogueHref(pkg.type, { packageId: pkg.id }))}
        />
      ) : reading ? (
        <CataloguePreview
          item={reading}
          type={active}
          spaces={library?.spaces ?? []}
          placement={placementOf(reading)}
          grantOf={(targetSpaceId, next) =>
            next
              ? mayActivateIn(reading, targetSpaceId)
              : maySetPackageActive(grantById.get(targetSpaceId), active, false)
          }
          mayConfigureIn={(targetSpaceId) =>
            mayConfigurePackage(grantById.get(targetSpaceId), active)
          }
          integrations={library?.packages.integration ?? []}
          agents={library?.packages.agent ?? []}
          protocol={
            active === "integration" && integrationById.get(reading.id)
              ? integrationProtocol(integrationById.get(reading.id)!)
              : undefined
          }
          actionsMenu={
            <PageActionsMenu>
              <CatalogueMenuItems
                item={readingItem!}
                homeWritable={writableOf(readingItem!)}
                homeShareable={shareableOf(readingItem!)}
                sharedSpaces={sharedSpacesOf(readingItem!)}
                open={{
                  label: t("catalogue.openFullPage"),
                  icon: ExternalLink,
                  onSelect: () => navigate(packageDetailPath(active, reading.id)),
                }}
                onMoveHome={setMoveHome}
                onShare={setSharing}
                onRevoke={revokeFrom}
              />
            </PageActionsMenu>
          }
          busy={activate.isPending}
          onSetActive={(targetSpaceId, next) =>
            void onSetActive(
              { id: reading.id, displayName: reading.name || reading.id, type: active },
              targetSpaceId,
              next,
            )
          }
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
          // The space and the state live in the URL, so the bar's own reset
          // could not see them: "Réinitialiser" left both chips standing.
          onResetFilters={() => setStates([])}
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
          // The page's own bar, not a panel variant of it: same icon-only
          // filter and column buttons, in the same place, at the same size.
          placement="page"
          // The library says where a package is placed, not what runs or uses
          // it, so the activity dimension would filter on nothing. Provenance
          // is one of this bar's own filters now, in the shape every other
          // filter here has, rather than the collection's built-in one.
          activityFilter={false}
          originFilter={false}
          extraFilters={discovering ? [originFilter] : [stateFilter, originFilter]}
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
          // Découvrir shows the whole catalogue; its two sections say what the
          // tick meant all along — what the space the reader is in does not run
          // yet, first, then what it already runs — and name that space. "Not
          // yet", not "to add": a package the reader may not add is there too.
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
                <Button
                  type="button"
                  size="sm"
                  disabled={activate.isPending || !spaceId}
                  onClick={() => picked.forEach(activateOne)}
                >
                  {activate.isPending && <Spinner />}
                  {t("catalogue.activateSelection", { count: picked.length })}
                </Button>
              ) : null}
            </>
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
              activate.mutate({ spaceId: closure.spaceId, packageId: entry.id, active: true });
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
