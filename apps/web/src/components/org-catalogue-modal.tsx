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
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Boxes, Layers, LibraryBig, Wrench } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOrg } from "../hooks/use-org";
import { useAllIntegrations } from "../hooks/use-integrations";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
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
  useCatalogueActiveColumn,
  useCatalogueProtocolColumn,
  useCatalogueOriginColumn,
  useCatalogueStatusColumn,
  useCatalogueSelectColumn,
  type CatalogueRowState,
} from "./catalogue-columns";
import { ContextSelector } from "./settings/context-selector";
import { RailButton } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

export type CatalogueOrigin = "org" | "appstrate";

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
  origin,
  type,
  onSelect,
  onClose,
}: {
  /** Both straight from the URL, so a link opens exactly one view. */
  origin: string;
  type: string;
  onSelect: (origin: CatalogueOrigin, type: PackageType) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const allowed = useCatalogueKinds();
  const spaceId = useCurrentSpaceId();
  const { currentOrg } = useOrg();
  const { data: library, isLoading, error } = useLibrary();
  const activate = useTogglePackageInstall();
  const list = useLocalListParams();
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The read has an address of its own: reload lands on it, Back leaves it.
  const preview = useModalParam("package");

  const fromAppstrate = origin === "appstrate";
  const kinds = KINDS.filter((kind) => allowed.includes(kind.type));
  // What Appstrate ships, per kind — read off the library rather than assumed,
  // so a kind it ships nothing of simply is not offered there.
  const appstrateKinds = kinds.filter((kind) =>
    (library?.packages[kind.type] ?? []).some((item) => item.source === "system"),
  );
  const visibleKinds = fromAppstrate ? appstrateKinds : kinds;
  const active =
    (isPackageType(type) && visibleKinds.some((k) => k.type === type)
      ? type
      : visibleKinds[0]?.type) ??
    // With no installable kind at all the panel would not have been opened.
    "agent";
  const kind = KINDS.find((k) => k.type === active)!;
  const orgName = currentOrg?.name ?? "";
  const spaceName =
    library?.spaces.find((space) => space.id === spaceId)?.name ?? t("catalogue.thisSpace");

  // Integrations resolve their activation server-side, and only their view
  // pays for the request.
  const { data: integrations } = useAllIntegrations({ enabled: active === "integration" });
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  const spaces = library?.spaces ?? [];

  /** Installed here and elsewhere, for one integration, from both reads. */
  const integrationState = (id: string) => {
    const activeHere = Boolean(integrationById.get(id)?.active);
    const libraryRow = library?.packages.integration.find((row) => row.id === id);
    const activeIn = spaces
      .filter(
        (space) =>
          Boolean(libraryRow?.installed_in.includes(space.id)) ||
          (space.id === spaceId && activeHere),
      )
      .map((space) => space.name);
    return { activeHere, activeIn };
  };

  const ofKind = library?.packages[active] ?? [];
  const stateById = new Map<string, CatalogueRowState>(
    ofKind.map((item) => {
      if (active === "integration") {
        return [item.id, { ...integrationState(item.id), everywhere: false }] as const;
      }
      const everywhere = item.source === "system";
      const activeHere = Boolean(spaceId && item.installed_in.includes(spaceId));
      const activeIn = spaces
        .filter((space) => item.installed_in.includes(space.id))
        .map((space) => space.name);
      return [item.id, { activeIn, activeHere, everywhere }] as const;
    }),
  );
  // Appstrate lists everything it provides, installed or not. The organisation
  // lists what the org HAS: its own packages, plus what it installed from
  // Appstrate — which is why Gmail, installed here, belongs in both.
  // Integrations split by execution, as on their page: remote (API or hosted
  // MCP) or local (an MCP server run in the sandbox).
  const [execution, setExecution] = useState<IntegrationExecution>("remote");
  const all = ofKind.filter((item) => {
    if (active === "integration") {
      const row = integrationById.get(item.id);
      if (row && integrationExecution(row) !== execution) return false;
    }
    if (fromAppstrate) return item.source === "system";
    if (item.source !== "system") return true;
    const state = stateById.get(item.id);
    return Boolean(state && !state.everywhere && (state.activeHere || state.activeIn.length > 0));
  });
  const stateOf = (item: CardItem): CatalogueRowState =>
    stateById.get(item.id) ?? { activeIn: [], activeHere: false, everywhere: false };
  const canActivate = (item: CardItem) => canInstall(item, stateOf(item));

  // Now that the panel shows what is already on, "where does this run?" is the
  // dimension worth narrowing — not origin, which the rail decides, and not
  // activity, which the library cannot answer.
  const wheres = list.values("where", ["here", "elsewhere", "nowhere"] as const);
  const rows = all.filter((item) => {
    if (wheres.length === 0) return true;
    const state = stateById.get(item.id);
    if (!state) return false;
    const here = state.activeHere || state.everywhere;
    const elsewhere = state.everywhere || state.activeIn.some((name) => name !== spaceName);
    return (
      (wheres.includes("here") && here) ||
      (wheres.includes("elsewhere") && elsewhere) ||
      (wheres.includes("nowhere") && !here && !elsewhere)
    );
  });
  const whereFilter: FilterSpec = {
    id: "where",
    label: t("catalogue.filter.where"),
    values: wheres,
    options: [
      { value: "here", label: t("catalogue.filter.here", { space: spaceName }) },
      { value: "elsewhere", label: t("catalogue.filter.elsewhere") },
      { value: "nowhere", label: t("catalogue.filter.nowhere") },
    ],
    onChange: list.setValues("where"),
  };

  const activateOne = (item: { id: string; displayName: string }) => {
    if (!spaceId) return;
    const target = item;
    activate.mutate(
      { spaceId, packageId: target.id, installed: false },
      {
        onSuccess: () => {
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          toast.success(t("packages.installed", { name: target.displayName }));
        },
        onError: (err) => toast.error(getErrorMessage(err)),
      },
    );
  };

  const offered: CardItem[] = rows.map((item) => {
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
              state={state}
              spaceName={spaceName}
              isActivating={activate.isPending}
              onActivate={activateOne}
              onOpen={(item) => preview.open(item.id)}
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
  const originColumn = useCatalogueOriginColumn(orgName);
  const statusColumn = useCatalogueStatusColumn(stateOf);
  const activeColumn = useCatalogueActiveColumn(stateOf);
  const protocolColumn = useCatalogueProtocolColumn((item) => {
    const row = integrationById.get(item.id);
    return row ? integrationProtocol(row) : undefined;
  });
  const actionsColumn = useCatalogueActionsColumn({
    spaceName,
    isActivating: activate.isPending,
    stateOf,
    onActivate: activateOne,
    onOpen: (item) => preview.open(item.id),
  });

  const show = (nextOrigin: CatalogueOrigin, nextType: PackageType) => {
    setSelected(new Set());
    list.reset();
    preview.close();
    onSelect(nextOrigin, nextType);
  };

  // One group, never two: the kinds are the same four words under either
  // origin, and a rail that lists them twice makes the reader compare two
  // identical lists to find the difference. The origin is a SELECTOR at the
  // head of the group, exactly where the settings rail puts the organisation
  // and the workspace it is showing.
  const originOptions = [
    // The name, then what it is: "Tractr (organisation)", "Appstrate (système)".
    // The label is what keeps an org that happens to be called something odd
    // from reading like a second vendor.
    { id: "org", name: t("catalogue.sourceOrg", { name: orgName }) },
    ...(appstrateKinds.length > 0 ? [{ id: "appstrate", name: t("catalogue.sourceSystem") }] : []),
  ];
  const selector = (
    <ContextSelector
      value={fromAppstrate ? "appstrate" : "org"}
      label={t("catalogue.originSelector")}
      options={originOptions}
      onValueChange={(next) => {
        const nextOrigin = next as CatalogueOrigin;
        const entries = nextOrigin === "appstrate" ? appstrateKinds : kinds;
        show(
          nextOrigin,
          entries.some((k) => k.type === active) ? active : (entries[0]?.type ?? active),
        );
      }}
    />
  );
  const kindRows = visibleKinds.map((entry) => (
    <RailButton
      key={entry.type}
      icon={entry.icon}
      label={t(entry.titleKey)}
      active={entry.type === active}
      onClick={() => show(fromAppstrate ? "appstrate" : "org", entry.type)}
    />
  ));

  // The settings rail, to the pixel: same header, same titled group, same
  // selector at its head, same rows.
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.origin")}>
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
            onClick={() => show(fromAppstrate ? "appstrate" : "org", entry.type)}
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
          emptyMessage={t("catalogue.empty")}
          emptyHint={t("catalogue.emptyHint")}
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
          // The library says where a package is installed, not what runs or
          // uses it, so the second dimension would filter on nothing. Origin
          // is the rail here, so the bar keeps no filter of its own.
          activityFilter={false}
          originFilter={false}
          extraFilters={[whereFilter]}
          // A package this space has not activated cannot be run from here.
          cardRun={false}
          // A tick is a table affordance; in cards, each card carries its own
          // deed instead, which is why the bulk action follows the view.
          leadingColumns={view === "table" ? [selectColumn] : []}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[
            ...(fromAppstrate ? [] : [originColumn]),
            ...(active === "integration" && execution === "remote" ? [protocolColumn] : []),
            statusColumn,
            activeColumn,
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
    </PanelDialog>
  );
}
