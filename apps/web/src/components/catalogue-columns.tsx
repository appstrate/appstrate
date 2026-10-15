// SPDX-License-Identifier: Apache-2.0

/**
 * The columns the catalogue adds to the package table: the origin and one switch
 * per space (where a package is active). There is no organization-level install,
 * so every activation has to say WHERE.
 */
import { useTranslation } from "react-i18next";
import { Switch } from "@appstrate/ui/components/switch";
import { placementIn, type CataloguePlacement } from "../lib/catalogue-placement";
import { ACTIVATION_REFUSAL_KEY, type ActivationGate } from "../lib/catalogue-gates";
import type { DataColumn } from "./data-table";
import { CellEmpty, CellText } from "./table-cells";
import { MetaBadge } from "./status-badge";
import type { CardItem } from "../lib/package-card-item";
import type { IntegrationProtocol } from "../lib/integration-collection";

/**
 * The one origin column of every package table: the provider, with the home space
 * (which governs the draft) under it. A column each would cost the tier-3 budget a
 * whole track (`column-tiers.test.tsx`). A system package has no home space.
 */
export function useCatalogueOriginColumn<
  T extends { source?: string | null; autoInstalled?: boolean } = CardItem,
>(orgName: string, homeNameOf?: (item: T) => string | null): DataColumn<T> {
  const { t } = useTranslation(["settings", "agents"]);
  return {
    id: "origin",
    header: t("catalogue.origin"),
    width: 128,
    tier: 3,
    cell: (item) => {
      const home = item.source === "system" ? null : homeNameOf?.(item);
      return (
        // `items-start` sizes each child to its content, so a long name would never meet
        // the track's edge and `truncate` would not engage: cap them at the column.
        <span className="flex min-w-0 flex-col items-start [&>*]:max-w-full">
          <CellText>{item.source === "system" ? t("catalogue.sourceSystem") : orgName}</CellText>
          {item.autoInstalled && <MetaBadge label={t("agents:list.badgeAutoInstalled")} />}
          {home && (
            <span
              className="text-muted-foreground/70 truncate text-[0.68rem]"
              title={t("packages.homeSpace", { space: home })}
            >
              {home}
            </span>
          )}
        </span>
      );
    },
  };
}

/** API or MCP, for a remote integration — a local one is always MCP. */
export function useCatalogueProtocolColumn<T = CardItem>(
  protocolOf: (item: T) => IntegrationProtocol | undefined,
): DataColumn<T> {
  const { t } = useTranslation("settings");
  return {
    id: "protocol",
    header: t("catalogue.column.protocol"),
    width: 88,
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
 * One column per space the caller reaches; each cell says, and changes, this package's
 * state THERE. The switch IS the deed: activating in a space where it is not placed shares
 * and switches it on in one transaction. The verdict is the TARGET space's (`activationGate`).
 * "Offered" and "switched off" are written beside the switch, which alone reads the same
 * placed or not (only a placed one keeps its settings).
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
  currentSpaceId: string | null;
  placementOf: (item: CardItem) => CataloguePlacement | undefined;
  gateOf: (item: CardItem, spaceId: string, next: boolean) => ActivationGate;
  busy: boolean;
  onSetActive: (item: CardItem, spaceId: string, next: boolean) => void;
}): DataColumn<CardItem>[] {
  const { t } = useTranslation("settings");

  return spaces.map((space, index) => ({
    id: `space:${space.id}`,
    header: space.name,
    // The catalogue spans every space, so the one the app acts in (launches, runs) has to be SAID.
    headerNode:
      space.id === currentSpaceId ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{space.name}</span>
          <span className="bg-primary/15 text-primary rounded px-1 text-[10px] leading-4 font-medium">
            {t("catalogue.here")}
          </span>
        </span>
      ) : undefined,
    control: true,
    // The pinned first column also carries the "ici" pill.
    width: index === 0 ? 140 : 104,
    elastic: true,
    cell: (item) => {
      const placement = placementOf(item);
      if (!placement) return <CellEmpty />;
      const state = placementIn(placement, space.id);
      const gate = gateOf(item, space.id, state !== "active");
      return (
        // `relative z-10`: sit above the row link's overlay or the row swallows the click (see `data-table.tsx`).
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
            // One word: who shared it is on the sheet.
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
