// SPDX-License-Identifier: Apache-2.0

/**
 * The three columns the catalogue adds to the package table: the tick, where a
 * package is already active, and the deed.
 *
 * "Where it is already active" is the column this screen cannot do without.
 * There is no organization-level install in this product — a package is in the
 * org's catalogue, and then it is switched on space by space — so "activate"
 * with nothing beside it would never say WHERE. The row says where it already
 * runs, and the button names the space it would add.
 */
import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Switch } from "@appstrate/ui/components/switch";
import { placementIn, type CataloguePlacement } from "../lib/catalogue-placement";
import {
  ACTIVATION_REFUSAL_KEY,
  type ActivationGate,
  type CatalogueDeeds,
} from "../lib/catalogue-gates";
import type { DataColumn } from "./data-table";
import { CatalogueRowMenu } from "./catalogue-row";
import { rowActionsColumn } from "./row-actions-column";
import { CellEmpty, CellText } from "./table-cells";
import { MetaBadge } from "./status-badge";
import type { CardItem } from "../lib/package-card-item";
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
    // This table SCROLLS rather than dropping columns (`columnMode="scroll"`),
    // and the tick is held at its start with the name beside it.
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
 * which space governs its draft. The one origin column of every package table:
 * the lists, the integrations, the catalogue.
 *
 * They are different facts — Acme provides it, the space "Default" decides
 * who may edit it — and a column each would cost the tier-3 budget a whole
 * track (`column-tiers.test.tsx` measures it). So the home rides under the
 * provider, the way Claude's connector list puts "Personnalisé" beside "Web"
 * rather than in a column of its own.
 *
 * A system package has no home space: it is shipped into every space rather
 * than living in one, so there is nothing to name under it.
 */
export function useCatalogueOriginColumn<
  T extends { source?: string | null; autoInstalled?: boolean } = CardItem,
>(orgName: string, homeNameOf?: (item: T) => string | null): DataColumn<T> {
  const { t } = useTranslation(["settings", "agents"]);
  return {
    id: "origin",
    header: t("catalogue.origin"),
    width: "128px",
    tier: 3,
    cell: (item) => {
      const home = item.source === "system" ? null : homeNameOf?.(item);
      return (
        <span className="flex min-w-0 flex-col items-start">
          <CellText>{item.source === "system" ? t("catalogue.sourceSystem") : orgName}</CellText>
          {item.autoInstalled && <MetaBadge label={t("agents:list.badgeAutoInstalled")} />}
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

const NO_DEEDS: CatalogueDeeds = { moveHome: false, share: false, revokeFrom: [] };

/**
 * The row's deeds, behind the table's standard "…" menu rather than a button
 * in every row: installing is one deed among the preview's, the bulk action is
 * the tick, and a column of identical buttons read as the table's content.
 */
export function useCatalogueActionsColumn({
  isPending,
  deedsOf,
  spaceNameOf,
  onOpen,
  onMoveHome,
  onShare,
  onRevoke,
}: {
  isPending: boolean;
  /** `undefined` for a row the library does not carry: its menu only opens it. */
  deedsOf: (item: CardItem) => CatalogueDeeds | undefined;
  spaceNameOf: (spaceId: string) => string;
  onOpen: (item: CardItem) => void;
  onMoveHome: (item: CardItem) => void;
  onShare: (item: CardItem) => void;
  onRevoke: (item: CardItem, spaceId: string) => void;
}): DataColumn<CardItem> {
  return rowActionsColumn((item) => (
    <CatalogueRowMenu
      item={item}
      // A system package has no home to move and no audience to offer: the
      // server answers `false` for both, so the menu offers neither.
      deeds={deedsOf(item) ?? NO_DEEDS}
      spaceNameOf={spaceNameOf}
      isPending={isPending}
      onOpen={onOpen}
      onMoveHome={onMoveHome}
      onShare={onShare}
      onRevoke={onRevoke}
    />
  ));
}

/** API or MCP, for a remote integration — a local one is always MCP. */
export function useCatalogueProtocolColumn<T = CardItem>(
  protocolOf: (item: T) => IntegrationProtocol | undefined,
): DataColumn<T> {
  const { t } = useTranslation("settings");
  return {
    id: "protocol",
    header: t("catalogue.column.protocol"),
    width: "88px",
    tier: 2,
    cell: (item) => {
      const protocol = protocolOf(item);
      return protocol ? (
        <CellText>{t(`integrations.protocol.${protocol}`)}</CellText>
      ) : (
        <CellEmpty />
      );
    },
  };
}

/**
 * One column per space the caller reaches, each cell saying — and changing —
 * this package's state THERE.
 *
 * Not a pair such as "Statut" and "Actif dans", which between them cannot name
 * the space they speak about: the first reasons on the current space without
 * writing its name, the second lists the others. With three states and
 * several spaces, a row needs the same word in the same place for every space,
 * which is a column each.
 *
 * The switch IS the deed, not a report of it: activating a package in a space
 * it is not placed in shares it there and switches it on in one transaction,
 * which is the door the API already opens. The verdict is the TARGET space's
 * (`activationGate`), never the one on screen, and a refused switch says which
 * half is missing.
 *
 * "Offered" is written beside the switch rather than in place of it: it is the
 * one state that asks the reader for a decision, and hiding the control that
 * takes it behind a word would make the row a dead end; its switch says what
 * switching it on consents to. "Switched off" is
 * written too: an off switch alone reads the same placed or not, and only the
 * placed one keeps its settings.
 */
export function useCatalogueSpaceColumns({
  spaces,
  currentSpaceId,
  placementOf,
  gateOf,
  busy,
  onSetActive,
}: {
  spaces: readonly { id: string; name: string }[];
  /** The space the app is standing in — named, because the catalogue spans them all. */
  currentSpaceId: string | null;
  placementOf: (item: CardItem) => CataloguePlacement | undefined;
  /** The reader's verdict for this switch, in the direction it would go. */
  gateOf: (item: CardItem, spaceId: string, next: boolean) => ActivationGate;
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
    cell: (item) => {
      const placement = placementOf(item);
      if (!placement) return <CellEmpty />;
      const state = placementIn(placement, space.id);
      const gate = gateOf(item, space.id, state !== "active");
      return (
        // `relative z-10`: the row link paints an overlay over every cell, and
        // anything that answers to the pointer has to sit above it or the row
        // swallows the click (see `data-table.tsx`).
        <span className="relative z-10 flex min-w-0 items-center gap-1.5 overflow-hidden">
          <Switch
            checked={state === "active"}
            disabled={busy || !gate.allowed}
            aria-label={t("catalogue.spaceSwitch", {
              package: item.displayName,
              space: space.name,
            })}
            title={
              gate.refusal
                ? t(ACTIVATION_REFUSAL_KEY[gate.refusal], { ns: "common" })
                : state === "offered"
                  ? t("catalogue.sheet.offerCredentials")
                  : undefined
            }
            onCheckedChange={(next) => onSetActive(item, space.id, next === true)}
          />
          {state === "offered" && (
            // One word, not "Partagé par Alice" on two lines: who shared it is
            // on the sheet and in "Partages en attente", where the decision is
            // taken; here the cell only has to tell shared-and-off from off.
            <span className="text-primary text-[0.7rem] font-medium">
              {t("catalogue.offeredHere")}
            </span>
          )}
          {state === "inactive" && (
            <span className="text-muted-foreground text-[0.7rem]">
              {t("catalogue.filter.inactive")}
            </span>
          )}
        </span>
      );
    },
  }));
}
