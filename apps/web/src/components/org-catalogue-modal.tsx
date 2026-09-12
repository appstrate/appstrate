// SPDX-License-Identifier: Apache-2.0

/**
 * The organisation's catalogue: what it owns that is not active in this space.
 *
 * ONE catalogue for every kind of package, not one per page. The rail on the
 * left picks the kind — and lists only the kinds this reader may actually
 * activate, so the panel says what it can do rather than showing four tabs of
 * which three refuse. The body is the list's own table, whole: same search,
 * same filters, same columns, same view toggle, plus a tick per row and one
 * action at the right end of the bar, where a list's actions always are.
 *
 * It reads `/api/library`, NOT each type's list route: that one answers with
 * the system packages plus what is installed in THIS space, which is precisely
 * what a catalogue must look past. The library is the only read that knows the
 * caller's other spaces — and it is scoped, so every row here is a package the
 * caller may also open, which is why the row is a link like everywhere else.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Boxes, Layers, LibraryBig, Plug, Wrench } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import { usePermissions } from "../hooks/use-permissions";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
import { useLocalListParams } from "../lib/list-params";
import { usePackageViewStore } from "../stores/list-view-store";
import type { CardItem } from "../pages/package-list";
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

  const kinds = KINDS.filter((kind) => can(PACKAGE_PERMISSIONS[kind.type].install));
  const active =
    (isPackageType(type) && kinds.some((k) => k.type === type) ? type : kinds[0]?.type) ??
    // With no installable kind at all the panel would not have been opened.
    "agent";
  const kind = KINDS.find((k) => k.type === active)!;

  const activateOne = (item: CardItem) => {
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
  // activate. An integration does, which is why its system rows stay.
  const systemIsEverywhere = active !== "integration";
  const offered: CardItem[] = (library?.packages[active] ?? [])
    .filter((item) => !(spaceId && item.installed_in.includes(spaceId)))
    .filter((item) => !(systemIsEverywhere && item.source === "system"))
    .map((item) => ({
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
            onClick={() =>
              activateOne({ id: item.id, displayName: item.name || item.id, type: active })
            }
          >
            {t("catalogue.activate")}
          </Button>
        ) : undefined,
    }));

  const offeredIds = offered.map((item) => item.id);
  const allSelected = offeredIds.length > 0 && offeredIds.every((id) => selected.has(id));
  const picked = offered.filter((item) => selected.has(item.id));

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

  const kindButtons = (className: string) =>
    kinds.map((entry) => (
      <Button
        key={entry.type}
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={entry.type === active}
        className={className}
        onClick={() => {
          setSelected(new Set());
          list.reset();
          onTypeChange(entry.type);
        }}
      >
        <entry.icon className="size-4 shrink-0" />
        {t(entry.titleKey)}
      </Button>
    ));

  // Two panes do not survive 390px, so the rail becomes a scrolling row of the
  // same buttons above the table — the panel must not lose its one selector.
  const mobileNav = (
    <div>
      <h2 className="text-lg font-semibold">{t("catalogue.title")}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{t("catalogue.intro")}</p>
      <nav
        aria-label={t("catalogue.kinds")}
        className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {kindButtons("aria-pressed:bg-accent shrink-0 gap-2 px-3")}
      </nav>
    </div>
  );

  const rail = (
    <div className="flex min-h-full flex-col p-5">
      <div className="flex items-center gap-2">
        <LibraryBig className="text-muted-foreground size-5 shrink-0" />
        <h2 className="font-semibold">{t("catalogue.title")}</h2>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">{t("catalogue.intro")}</p>
      <nav aria-label={t("catalogue.kinds")} className="mt-5 space-y-1">
        {kindButtons("aria-pressed:bg-accent w-full justify-start gap-2 px-3")}
      </nav>
    </div>
  );

  return (
    <PanelDialog
      title={t("catalogue.title")}
      rail={rail}
      mobileNav={mobileNav}
      reserveCloseArea
      onClose={onClose}
    >
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
        placement="panel"
        // The library says where a package is installed, not what runs or uses
        // it, so the second dimension would filter on nothing.
        activityFilter={false}
        // A tick is a table affordance; in cards, each card carries its own
        // deed instead, which is why the bulk action follows the view.
        leadingColumns={view === "table" ? [selectColumn] : []}
        dropColumns={CATALOGUE_DROPS}
        trailingColumns={[activateColumn]}
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
    </PanelDialog>
  );
}
