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
import { Boxes, Layers, LibraryBig, Plug, Wrench } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useAllIntegrations } from "../hooks/use-integrations";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import { useModalParam } from "../hooks/use-modal-param";
import { useCatalogueKinds } from "../hooks/use-catalogue-kinds";
import { useLocalListParams } from "../lib/list-params";
import { usePackageViewStore } from "../stores/list-view-store";
import type { CardItem } from "../pages/package-list";
import { CataloguePreview } from "./catalogue-preview";
import { PanelDialog } from "./panel-dialog";
import { PackageCollection } from "./package-collection";
import {
  useCatalogueActivateColumn,
  useCatalogueActiveColumn,
  useCatalogueSelectColumn,
  type CatalogueRowState,
} from "./catalogue-columns";
import { RailButton } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";
import { Spinner } from "./spinner";

export type CatalogueOrigin = "org" | "appstrate";

const KINDS: Array<{ type: PackageType; icon: typeof Layers; titleKey: string }> = [
  { type: "agent", icon: Layers, titleKey: "packages.type.agents" },
  { type: "skill", icon: Wrench, titleKey: "packages.type.skills" },
  { type: "mcp-server", icon: Plug, titleKey: "packages.type.mcp-servers" },
  { type: "integration", icon: Boxes, titleKey: "packages.type.integrations" },
];

/**
 * Columns the catalogue drops. `source` goes because the rail now says it, and
 * saying it twice costs the width the "active in" column needs.
 */
const CATALOGUE_DROPS = ["state", "actions", "source"];

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
  const spaceName =
    library?.spaces.find((space) => space.id === spaceId)?.name ?? t("catalogue.thisSpace");

  // Only the integrations view needs the resolved activation, and only it pays
  // for the request.
  const { data: integrations } = useAllIntegrations({ enabled: active === "integration" });
  const activeHereById = new Map(
    (integrations ?? []).map((row) => [row.id, Boolean(row.active)] as const),
  );

  const rows = (library?.packages[active] ?? []).filter((item) =>
    fromAppstrate ? item.source === "system" : item.source !== "system",
  );

  const stateById = new Map<string, CatalogueRowState>(
    rows.map((item) => {
      const everywhere = active !== "integration" && item.source === "system";
      const activeHere =
        active === "integration"
          ? (activeHereById.get(item.id) ?? false)
          : Boolean(spaceId && item.installed_in.includes(spaceId));
      const activeIn = (library?.spaces ?? [])
        .filter(
          (space) => item.installed_in.includes(space.id) || (space.id === spaceId && activeHere),
        )
        .map((space) => space.name);
      return [item.id, { activeIn, activeHere, everywhere }] as const;
    }),
  );
  const stateOf = (item: CardItem): CatalogueRowState =>
    stateById.get(item.id) ?? { activeIn: [], activeHere: false, everywhere: false };
  const canActivate = (item: CardItem) => {
    const state = stateOf(item);
    return !state.everywhere && !state.activeHere;
  };

  const activateOne = (item: { id: string; displayName: string }) => {
    if (!spaceId) return;
    activate.mutate(
      { spaceId, packageId: item.id, installed: false },
      {
        onSuccess: () => {
          setSelected((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          });
          toast.success(t("packages.installed", { name: item.displayName }));
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
    // What the table puts in its last column, a card carries itself.
    return view === "cards" && canActivate(row)
      ? {
          ...row,
          actions: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={activate.isPending}
              onClick={() => activateOne(row)}
            >
              {t("catalogue.activate")}
            </Button>
          ),
        }
      : row;
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
  const activeColumn = useCatalogueActiveColumn(stateOf);
  const activateColumn = useCatalogueActivateColumn({
    spaceName,
    isActivating: activate.isPending,
    stateOf,
    onActivate: activateOne,
  });

  const show = (nextOrigin: CatalogueOrigin, nextType: PackageType) => {
    setSelected(new Set());
    list.reset();
    preview.close();
    onSelect(nextOrigin, nextType);
  };

  const groupRows = (groupOrigin: CatalogueOrigin, entries: typeof KINDS) =>
    entries.map((entry) => (
      <RailButton
        key={`${groupOrigin}-${entry.type}`}
        icon={entry.icon}
        label={t(entry.titleKey)}
        active={groupOrigin === (fromAppstrate ? "appstrate" : "org") && entry.type === active}
        onClick={() => show(groupOrigin, entry.type)}
      />
    ));

  // The settings rail, to the pixel: same header, same group headings, same
  // rows — and the same shape, one titled group per scope.
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.originOrg")}>
          <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={t("catalogue.originOrg")}>
            {groupRows("org", kinds)}
          </nav>
        </RailGroup>
        {appstrateKinds.length > 0 && (
          <RailGroup title={t("catalogue.originAppstrate")} separated>
            <nav
              className="mt-1.5 flex flex-col gap-0.5"
              aria-label={t("catalogue.originAppstrate")}
            >
              {groupRows("appstrate", appstrateKinds)}
            </nav>
          </RailGroup>
        )}
      </div>
    </div>
  );

  const mobileNav = (
    <nav aria-label={t("catalogue.kinds")} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {[
        ...kinds.map((entry) => ["org", entry] as const),
        ...appstrateKinds.map((entry) => ["appstrate", entry] as const),
      ].map(([groupOrigin, entry]) => (
        <Button
          key={`${groupOrigin}-${entry.type}`}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={groupOrigin === origin && entry.type === active}
          className="aria-pressed:bg-accent shrink-0 gap-2 px-3"
          onClick={() => show(groupOrigin, entry.type)}
        >
          <entry.icon className="size-4 shrink-0" />
          {groupOrigin === "appstrate"
            ? t("catalogue.appstrateKind", { kind: t(entry.titleKey) })
            : t(entry.titleKey)}
        </Button>
      ))}
    </nav>
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
          // The page's own bar, not a panel variant of it: same icon-only
          // filter and column buttons, in the same place, at the same size.
          placement="page"
          // The library says where a package is installed, not what runs or
          // uses it, so the second dimension would filter on nothing. Origin
          // is the rail here, so the bar keeps no filter of its own.
          activityFilter={false}
          originFilter={false}
          // A tick is a table affordance; in cards, each card carries its own
          // deed instead, which is why the bulk action follows the view.
          leadingColumns={view === "table" ? [selectColumn] : []}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[activeColumn, activateColumn]}
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
