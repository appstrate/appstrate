// SPDX-License-Identifier: Apache-2.0

/**
 * The three columns the catalogue adds to the package table: the tick, where a
 * package is already active, and the deed.
 *
 * "Where it is already active" is the column this screen cannot do without.
 * There is no organisation-level install in this product — a package is in the
 * org's catalogue, and then it is switched on space by space — so "activate"
 * with nothing beside it never said WHERE. Now the row says where it already
 * runs, and the button names the space it would add.
 */
import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Switch } from "@appstrate/ui/components/switch";
import type { PackageType } from "@appstrate/core/validation";
import { maySetPackageActive, type SpaceGrant } from "../lib/package-permissions";
import type { CataloguePlacement } from "../lib/catalogue-placement";
import type { DataColumn } from "./data-table";
import { CatalogueRowMenu } from "./catalogue-row";
import type { CardItem } from "../pages/package-list";
import type { IntegrationProtocol } from "../lib/integration-collection";

/** What the catalogue knows about one row beyond the package itself. */
export interface CatalogueRowState {
  /** Names of the spaces this caller can see where the package is active. */
  activeIn: string[];
  /** Active in the space on screen: there is nothing left to do here. */
  activeHere: boolean;
  /** Placed here and switched off: its per-space settings are kept. */
  placedHere?: boolean;
  /** Offered here and switched on by nobody — a placement whose state is `none`. */
  offeredHere?: boolean;
  /**
   * Available in every space without being switched on at all — what a system
   * agent, skill or MCP server is. An integration is not: it has a real switch.
   */
  everywhere: boolean;
}

export function useCatalogueSelectColumn({
  selected,
  allSelected,
  selectable,
  onToggle,
  onToggleAll,
}: {
  selected: ReadonlySet<string>;
  allSelected: boolean;
  /** A row with nothing to activate cannot be part of a bulk activation. */
  selectable: (item: CardItem) => boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}): DataColumn<CardItem> {
  const { t } = useTranslation("settings");

  return {
    id: "select",
    header: t("catalogue.selectColumn"),
    headerNode: (
      <Checkbox
        checked={allSelected}
        onCheckedChange={onToggleAll}
        aria-label={t("catalogue.selectAll")}
      />
    ),
    width: "36px",
    // Tier two, so the deed can hold tier one. This table SCROLLS rather than
    // dropping columns (`columnMode="scroll"`), so the tier decides the width
    // the narrow table must reserve before it scrolls, not what is hidden: the
    // first thing in view should be what the row IS and whether it can be
    // switched on, with bulk selection a scroll away rather than the reverse.
    tier: 2,
    control: true,
    cell: (item) =>
      selectable(item) ? (
        // Raised above the row's link overlay, or ticking would open the package.
        <span className="relative z-10 flex">
          <Checkbox
            checked={selected.has(item.id)}
            onCheckedChange={() => onToggle(item.id)}
            aria-label={t("catalogue.selectOne", { name: item.displayName })}
          />
        </span>
      ) : null,
  };
}

/**
 * Where the package comes FROM, in two words on one line: who provides it, and
 * which space governs its draft.
 *
 * They are different facts — Tractr provides it, the space "Default" decides
 * who may edit it — and a column each would cost the tier-3 budget a whole
 * track (`column-tiers.test.tsx` measures it). So the home rides under the
 * provider, the way Claude's connector list puts "Personnalisé" beside "Web"
 * rather than in a column of its own.
 *
 * A system package has no home space: it is readable everywhere by being what
 * it is, and there is nothing to name under it.
 */
export function useCatalogueOriginColumn(
  orgName: string,
  homeNameOf?: (item: CardItem) => string | null,
  /** Readable in every space without being switched on: said once, here. */
  everywhereOf?: (item: CardItem) => boolean,
): DataColumn<CardItem> {
  const { t } = useTranslation("settings");
  return {
    id: "origin",
    header: t("catalogue.origin"),
    width: "128px",
    tier: 3,
    cell: (item) => {
      const home = item.source === "system" ? null : homeNameOf?.(item);
      const everywhere = everywhereOf?.(item) ?? false;
      return (
        <span className="flex min-w-0 flex-col">
          <span className="text-muted-foreground truncate text-xs">
            {item.source === "system" ? t("catalogue.sourceSystem") : orgName}
          </span>
          {everywhere && (
            // Said once under the provider rather than repeated in every space
            // column, where "Partout · Partout · Partout" read as a puzzle.
            <span
              className="text-muted-foreground/70 truncate text-[0.68rem]"
              title={t("catalogue.everywhereHint")}
            >
              {t("catalogue.everywhere")}
            </span>
          )}
          {home && (
            <span
              className="text-muted-foreground/70 truncate text-[0.68rem]"
              title={t("catalogue.homeSpaceHint", { space: home })}
            >
              {home}
            </span>
          )}
        </span>
      );
    },
  };
}

/**
 * The row's deeds, behind the table's standard "…" menu rather than a button
 * in every row: installing is one deed among the preview's, the bulk action is
 * the tick, and a column of identical buttons read as the table's content.
 */
export function useCatalogueActionsColumn({
  isPending,
  placementOf,
  writableOf,
  shareableOf,
  sharedSpacesOf,
  onOpen,
  onMoveHome,
  onShare,
  onRevoke,
}: {
  isPending: boolean;
  placementOf: (item: CardItem) => CataloguePlacement | undefined;
  writableOf: (item: CardItem) => boolean;
  shareableOf: (item: CardItem) => boolean;
  sharedSpacesOf: (item: CardItem) => { id: string; name: string }[];
  onOpen: (item: CardItem) => void;
  onMoveHome: (item: CardItem) => void;
  onShare: (item: CardItem) => void;
  onRevoke: (item: CardItem, spaceId: string) => void;
}): DataColumn<CardItem> {
  return {
    id: "actions",
    header: "",
    width: "48px",
    align: "end",
    control: true,
    cell: (item) => (
      <CatalogueRowMenu
        item={item}
        // A system package has no home to move and no audience to offer: it is
        // readable everywhere by being what it is.
        homeWritable={writableOf(item) && !placementOf(item)?.everywhere}
        homeShareable={shareableOf(item) && !placementOf(item)?.everywhere}
        sharedSpaces={sharedSpacesOf(item)}
        isPending={isPending}
        onOpen={onOpen}
        onMoveHome={onMoveHome}
        onShare={onShare}
        onRevoke={onRevoke}
      />
    ),
  };
}

/** API or MCP, for a remote integration — a local one is always MCP. */
export function useCatalogueProtocolColumn(
  protocolOf: (item: CardItem) => IntegrationProtocol | undefined,
): DataColumn<CardItem> {
  const { t } = useTranslation("settings");
  return {
    id: "protocol",
    header: t("catalogue.column.protocol"),
    width: "88px",
    tier: 2,
    cell: (item) => {
      const protocol = protocolOf(item);
      return (
        <span className="text-muted-foreground text-xs">
          {protocol ? t(`integrations.protocol.${protocol}`) : "—"}
        </span>
      );
    },
  };
}

/**
 * One column per space the caller reaches, each cell saying — and changing —
 * this package's state THERE.
 *
 * It replaces the pair of columns that came before it ("Statut", then "Actif
 * dans"), which between them could not name the space they spoke about: the
 * first reasoned on the current space and never wrote its name, the second
 * listed the others. With three states and several spaces, a row needs the
 * same word in the same place for every space, which is a column each.
 *
 * The switch IS the deed, not a report of it: activating a package in a space
 * it is not placed in shares it there and switches it on in one transaction,
 * which is the door the API already opens. The verdict is the TARGET space's,
 * never the one on screen — owning a personal space authorizes activating in
 * it even where the preset held there grants nothing (RBAC spec §3.6).
 *
 * "Offered" is written beside the switch rather than in place of it: it is the
 * one state that asks the reader for a decision, and hiding the control that
 * takes it behind a word would make the row a dead end.
 */
export function useCatalogueSpaceColumns({
  spaces,
  currentSpaceId,
  type,
  placementOf,
  busy,
  onSetActive,
}: {
  spaces: readonly { id: string; name: string; grant?: SpaceGrant }[];
  /** The space the app is standing in — named, because the catalogue spans them all. */
  currentSpaceId: string | null;
  type: PackageType;
  placementOf: (item: CardItem) => CataloguePlacement | undefined;
  busy: boolean;
  onSetActive: (item: CardItem, spaceId: string, next: boolean) => void;
}): DataColumn<CardItem>[] {
  const { t } = useTranslation("settings");

  return spaces.map((space, index) => ({
    id: `space:${space.id}`,
    header: space.name,
    // The catalogue reads every space at once, so which one the rest of the
    // app is acting in has to be SAID: it is where a launch, a run and a
    // connection land, and nothing else on this screen says it.
    headerNode:
      space.id === currentSpaceId ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{space.name}</span>
          <span className="bg-primary/15 text-primary rounded px-1 text-[10px] leading-4 font-medium">
            {t("catalogue.here")}
          </span>
        </span>
      ) : undefined,
    // Controls, not content: the row's link is placed elsewhere, and the
    // switches below are raised over the overlay it stretches across the row.
    control: true,
    // The pinned first column carries the space name AND the "ici" pill, so it
    // asks for more room than the ones that carry a name alone.
    width: index === 0 ? "minmax(140px,1fr)" : "minmax(104px,1fr)",
    // The first space holds tier two, beside the name; the others wait for the
    // width the way any further column does. A caller with ONE space therefore
    // keeps the table it had, with the space named instead of implied.
    tier: index === 0 ? 2 : 3,
    cell: (item) => {
      const placement = placementOf(item);
      if (!placement) return <span className="text-muted-foreground/50">—</span>;
      // A system agent, skill or MCP server is readable in every space without
      // a row of its own: there is no switch to offer.
      // The origin column says "Partout" once for this row; a switch would be
      // a control with nothing to change.
      if (placement.everywhere) return <span className="text-muted-foreground/50">—</span>;
      const state = placement.activeIn.includes(space.id)
        ? "active"
        : placement.offeredIn.includes(space.id)
          ? "offered"
          : placement.inactiveIn.includes(space.id)
            ? "inactive"
            : null;
      const mayWrite = maySetPackageActive(space.grant, type, state !== "active");
      return (
        // `relative z-10`: the row link paints an overlay over every cell, and
        // anything that answers to the pointer has to sit above it or the row
        // swallows the click (see `data-table.tsx`).
        <span className="relative z-10 flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Switch
            checked={state === "active"}
            disabled={busy || !mayWrite}
            aria-label={t("catalogue.spaceSwitch", {
              package: item.displayName,
              space: space.name,
            })}
            title={mayWrite ? undefined : t("library.cannotActivate", { ns: "common" })}
            onCheckedChange={(next) => onSetActive(item, space.id, next === true)}
          />
          {state === "offered" && (
            // Two short lines rather than one that truncates: in a 104px column
            // "Proposé par Julie" lost the name, which is the part that matters.
            <span className="text-muted-foreground flex min-w-0 flex-col text-[0.7rem] leading-tight">
              <span>{t("catalogue.offeredHere")}</span>
              {/* Who made the offer, when somebody did: a decision reads
                  differently coming from a colleague than from nowhere. */}
              {placement.offeredBy[space.id] && (
                <span className="truncate">
                  {t("catalogue.offeredByShort", { name: placement.offeredBy[space.id] })}
                </span>
              )}
            </span>
          )}
        </span>
      );
    },
  }));
}
