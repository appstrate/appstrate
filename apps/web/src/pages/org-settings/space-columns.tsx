// SPDX-License-Identifier: Apache-2.0

/**
 * The workspaces column set.
 *
 * Same reasoning as `member-columns.tsx`: a workspace row is a record — name,
 * what kind of space it is and who reaches it, when it was created, and what
 * can be done to it — so it belongs in a table where those are named once at
 * the top rather than in a card that reprints them per row.
 *
 * The kind column is what carries the personal spaces: a member's own space,
 * and an ORPHANED one whose owner has left. The two acts an orphan
 * offers ride in the row's Actions menu rather than as buttons on a card,
 * because a row here carries one menu and no loose buttons.
 */

import { useTranslation } from "react-i18next";
import { FolderInput, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { components } from "../../api/client";
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { rowActionsColumn } from "../../components/row-actions-column";
import { CellText } from "../../components/table-cells";
import { formatDateField } from "../../lib/format-date";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { spaceLabel } from "../../lib/space-label";
import { spaceTile } from "../../lib/identity-tile-props";
import { isSpaceEnterable } from "../../hooks/use-current-space";
import { useViewer } from "../../hooks/use-auth";

export interface SpaceRow {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  personal: boolean;
  icon: string | null;
  color: string | null;
  visibility: components["schemas"]["SpaceObject"]["visibility"];
  orphaned_at?: string | null;
  access: string;
}

export function useSpaceColumns({
  defaultLabel,
  onConvert,
  onSweep,
  actionsBusy,
}: {
  defaultLabel: string;
  /** Turn an orphaned personal space into a team space. Absent without the grant. */
  onConvert?: (spaceId: string) => void;
  /** Empty and delete an orphaned personal space. Absent without the grant. */
  onSweep?: (spaceId: string) => void;
  actionsBusy?: boolean;
}): DataColumn<SpaceRow>[] {
  const { t } = useTranslation(["settings", "common"]);
  const viewer = useViewer();

  return [
    {
      id: "workspace",
      header: t("spaces.nameLabel"),
      width: 160,
      elastic: true,
      cell: (space) => (
        <span className="flex min-w-0 items-center gap-3">
          <IdentityTile {...spaceTile(space, viewer)} className="size-7 rounded-md" />
          <CellText
            strong
            // A `closed` space is listed so the caller knows it exists, not so they
            // can be dropped into it (pinning one 403s every space-scoped request,
            // same rule as the org switcher): its row is static and says why.
            title={isSpaceEnterable(space) ? spaceLabel(space, t) : t("spaces.requestAccess")}
          >
            {spaceLabel(space, t)}
          </CellText>
        </span>
      ),
    },
    {
      id: "kind",
      header: t("spaces.visibilityLabel"),
      width: 150,
      elastic: true,
      tier: 2,
      cell: (space) =>
        space.orphaned_at ? (
          // The one state that asks the reader for a decision, so it is said
          // in words a hover does not hide: since when it has been orphaned is
          // in the created column's neighbour, not in a tooltip.
          <Badge variant="warning">{t("spaces.personal.orphanedBadge")}</Badge>
        ) : space.personal ? (
          <Badge variant="secondary">{t("spaces.personal.badge")}</Badge>
        ) : (
          <span className="flex flex-wrap gap-1">
            <Badge variant="secondary">{t(`spaces.visibility.${space.visibility}`)}</Badge>
            {space.isDefault && <Badge variant="running">{defaultLabel}</Badge>}
          </span>
        ),
    },
    {
      id: "created",
      header: t("spaces.createdAtLabel"),
      width: 132,
      align: "end",
      // Tier 2, not 3: the settings dialog tops out around 800px and never
      // crosses the 56rem threshold, so tier 3 there means never drawn.
      tier: 2,
      cell: (space) => (
        <span className="text-muted-foreground text-xs">
          {space.orphaned_at
            ? t("spaces.personal.orphanedSince", {
                date: formatDateField(space.orphaned_at, "date"),
              })
            : formatDateField(space.createdAt, "date")}
        </span>
      ),
    },
    rowActionsColumn((space: SpaceRow) => {
      // An orphan cannot be entered — its owner is gone — so it offers the
      // two acts that resolve it. Every other row has no menu: a click on it
      // opens its settings, which is its one deed.
      const orphaned = Boolean(space.orphaned_at);
      return (
        <TableRowActions
          menuLabel={t("providers.moreActions", { name: spaceLabel(space, t) })}
          actions={[
            {
              id: "convert",
              label: t("spaces.personal.convert"),
              icon: FolderInput,
              onSelect: () => onConvert?.(space.id),
              disabled: actionsBusy,
              hidden: !orphaned || !onConvert,
            },
            {
              id: "sweep",
              label: t("spaces.personal.sweep"),
              icon: Trash2,
              onSelect: () => onSweep?.(space.id),
              disabled: actionsBusy,
              destructive: true,
              hidden: !orphaned || !onSweep,
            },
          ]}
        />
      );
    }),
  ];
}
