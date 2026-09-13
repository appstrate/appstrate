// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue: everything this space could activate and has not.
 *
 * ONE catalogue for every kind of package, not one per page. The rail on the
 * left picks the kind — and lists only the kinds this reader may actually
 * activate, so the panel says what it can do rather than showing four tabs of
 * which three refuse. The body is the list's own table, whole: same search,
 * same filters in the same place, same columns, same view toggle, plus a tick
 * per row and one action at the right end of the bar.
 *
 * Two things the panel is careful about:
 *
 * - **Where a package comes from is a TAB, not a filter** — but only where the
 *   distinction means something. A system agent, skill or MCP server is already
 *   available in every space, so for those three "Appstrate" would list nothing
 *   and the tabs are not drawn. A system INTEGRATION still has to be installed,
 *   which is why the integrations page had a second catalogue of its own. That
 *   is the tab pair, and it is the seam an Appstrate-wide registry would widen.
 * - **A row opens HERE, not on the package's page.** Its page would throw away
 *   the panel and the list, and its breadcrumb would claim the current space
 *   for a package that is not in it — and a package installed in three spaces
 *   has no single space to claim anyway. {@link CataloguePreview} answers what
 *   a catalogue is asked, and links to the full page for the rest.
 *
 * It reads `/api/library`, NOT each type's list route: that one answers with
 * the system packages plus what is installed in THIS space, which is precisely
 * what a catalogue must look past. The library is the only read that knows the
 * caller's other spaces — and it is scoped, so every row here is one the caller
 * may also read.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Boxes, Layers, LibraryBig, Plug, Wrench } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { Tabs } from "@appstrate/ui/components/tabs";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useLibrary, useTogglePackageInstall, type LibraryPackageItem } from "../hooks/use-library";
import { useModalParam } from "../hooks/use-modal-param";
import { usePermissions } from "../hooks/use-permissions";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
import { useLocalListParams } from "../lib/list-params";
import { usePackageViewStore } from "../stores/list-view-store";
import type { CardItem } from "../pages/package-list";
import { DetailTabsList, DetailTabsTrigger } from "./agent-detail/agent-local-tabs";
import { RailButton } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";
import { CataloguePreview } from "./catalogue-preview";
import { PanelDialog } from "./panel-dialog";
import { PackageCollection } from "./package-collection";
import { useCatalogueActivateColumn, useCatalogueSelectColumn } from "./package-catalogue-columns";
import { Spinner } from "./spinner";

const KINDS: Array<{ type: PackageType; icon: typeof Layers; titleKey: string }> = [
  { type: "agent", icon: Layers, titleKey: "packages.type.agents" },
  { type: "skill", icon: Wrench, titleKey: "packages.type.skills" },
  { type: "mcp-server", icon: Plug, titleKey: "packages.type.mcp-servers" },
  { type: "integration", icon: Boxes, titleKey: "packages.type.integrations" },
];

/** Nothing here is active in this space, so neither column can say anything. */
const CATALOGUE_DROPS = ["state", "actions"];

function isPackageType(value: string): value is PackageType {
  return KINDS.some((kind) => kind.type === value);
}

export function OrgCatalogueModal({
  type,
  onTypeChange,
  onClose,
}: {
  /** The kind on screen, straight from the URL — so a link opens the right one. */
  type: string;
  onTypeChange: (type: PackageType) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const { can } = usePermissions();
  const spaceId = useCurrentSpaceId();
  const { data: library, isLoading, error } = useLibrary();
  const activate = useTogglePackageInstall();
  const list = useLocalListParams();
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [origin, setOrigin] = useState<"org" | "appstrate">("org");
  // The read has an address of its own: reload lands on it, Back leaves it.
  const preview = useModalParam("package");

  const kinds = KINDS.filter((kind) => can(PACKAGE_PERMISSIONS[kind.type].install));
  const active =
    (isPackageType(type) && kinds.some((k) => k.type === type) ? type : kinds[0]?.type) ??
    // With no installable kind at all the panel would not have been opened.
    "agent";
  const kind = KINDS.find((k) => k.type === active)!;

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

  // A system agent, skill or MCP server is active everywhere: it has nothing to
  // activate, and nothing to put under an "Appstrate" tab either.
  const systemNeedsActivating = active === "integration";
  const available: LibraryPackageItem[] = (library?.packages[active] ?? [])
    .filter((item) => !(spaceId && item.installed_in.includes(spaceId)))
    .filter((item) => systemNeedsActivating || item.source !== "system");
  const shownHere = systemNeedsActivating
    ? available.filter((item) =>
        origin === "appstrate" ? item.source === "system" : item.source !== "system",
      )
    : available;

  const offered: CardItem[] = shownHere.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type: active,
    source: item.source as CardItem["source"],
    // What the table puts in its last column, a card carries itself.
    actions:
      view === "cards" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={activate.isPending}
          onClick={() => activateOne({ id: item.id, displayName: item.name || item.id })}
        >
          {t("catalogue.activate")}
        </Button>
      ) : undefined,
  }));

  const offeredIds = offered.map((item) => item.id);
  const allSelected = offeredIds.length > 0 && offeredIds.every((id) => selected.has(id));
  const picked = offered.filter((item) => selected.has(item.id));
  const reading = preview.value ? available.find((item) => item.id === preview.value) : undefined;

  const selectColumn = useCatalogueSelectColumn({
    selected,
    allSelected,
    onToggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onToggleAll: () => setSelected(allSelected ? new Set() : new Set(offeredIds)),
  });
  const activateColumn = useCatalogueActivateColumn({
    isActivating: activate.isPending,
    onActivate: activateOne,
  });

  const showKind = (next: PackageType) => {
    setSelected(new Set());
    setOrigin("org");
    list.reset();
    preview.close();
    onTypeChange(next);
  };

  const kindRows = kinds.map((entry) => (
    <RailButton
      key={entry.type}
      icon={entry.icon}
      label={t(entry.titleKey)}
      active={entry.type === active}
      onClick={() => showKind(entry.type)}
    />
  ));

  // Two panes do not survive 390px, so the rail's rows become a scrolling row
  // above the table — the panel must not lose its one selector.
  const mobileNav = (
    <nav aria-label={t("catalogue.kinds")} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {kinds.map((entry) => (
        <Button
          key={entry.type}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={entry.type === active}
          className="aria-pressed:bg-accent shrink-0 gap-2 px-3"
          onClick={() => showKind(entry.type)}
        >
          <entry.icon className="size-4 shrink-0" />
          {t(entry.titleKey)}
        </Button>
      ))}
    </nav>
  );

  // The settings rail, to the pixel: same header, same group heading, same rows.
  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("catalogue.title")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.kinds")}>
          <nav className="mt-1.5 flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {kindRows}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  // And the settings page heading, so the content pane reads the same way too.
  const header = (
    <>
      <SettingsHeading className="mb-4" title={t(kind.titleKey)} />
      {systemNeedsActivating && (
        <Tabs
          className="mb-4"
          value={origin}
          onValueChange={(next) => {
            setSelected(new Set());
            setOrigin(next as "org" | "appstrate");
          }}
        >
          <DetailTabsList aria-label={t("catalogue.originTabs")}>
            <DetailTabsTrigger value="org">{t("catalogue.originOrg")}</DetailTabsTrigger>
            <DetailTabsTrigger value="appstrate">
              {t("catalogue.originAppstrate")}
            </DetailTabsTrigger>
          </DetailTabsList>
        </Tabs>
      )}
    </>
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
          header={header}
          // The page's own bar, not a panel variant of it: same icon-only
          // filter and column buttons, in the same place, at the same size.
          placement="page"
          // The library says where a package is installed, not what runs or
          // uses it, so the second dimension would filter on nothing. Origin
          // is a tab here, so the bar keeps no filter of its own.
          activityFilter={false}
          originFilter={false}
          // A tick is a table affordance; in cards, each card carries its own
          // deed instead, which is why the bulk action follows the view.
          leadingColumns={view === "table" ? [selectColumn] : []}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[activateColumn]}
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
