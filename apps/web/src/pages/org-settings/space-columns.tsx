// SPDX-License-Identifier: Apache-2.0

/**
 * The workspaces column set.
 *
 * Same reasoning as `member-columns.tsx`: a workspace row is a record — name,
 * what kind of space it is, when it was created, and what can be done to it —
 * so it belongs in a table where those are named once at the top rather than
 * in a card that reprints them per row.
 *
 * The kind column is what carries main's personal spaces (#1437): a member's
 * own space, and an ORPHANED one whose owner has left. The two acts an orphan
 * offers ride in the row's Actions menu rather than as buttons on a card,
 * because a row here carries one menu and no loose buttons.
 */

import { useTranslation } from "react-i18next";
import { FolderInput, Settings, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { DataColumn } from "../../components/data-table";
import { TableRowActions } from "../../components/table-row-actions";
import { formatDateField } from "../../lib/format-date";
import { spaceLabel } from "../../lib/space-label";

export interface ApplicationRow {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  personal: boolean;
  orphaned_at?: string | null;
  access?: string;
}

export function useSpaceColumns({
  defaultLabel,
  onOpen,
  onConvert,
  onSweep,
  actionsBusy,
}: {
  defaultLabel: string;
  onOpen: (spaceId: string) => void;
  /** Turn an orphaned personal space into a team space. Absent without the grant. */
  onConvert?: (spaceId: string) => void;
  /** Empty and delete an orphaned personal space. Absent without the grant. */
  onSweep?: (spaceId: string) => void;
  actionsBusy?: boolean;
}): DataColumn<ApplicationRow>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "workspace",
      header: t("applications.nameLabel"),
      width: "minmax(160px,1.6fr)",
      cell: (app) => (
        <span className="block truncate text-sm font-medium">{spaceLabel(app, t)}</span>
      ),
    },
    {
      id: "kind",
      header: t("applications.defaultColumn"),
      width: "minmax(120px,0.8fr)",
      tier: 2,
      cell: (app) =>
        app.orphaned_at ? (
          // The one state that asks the reader for a decision, so it is said
          // in words a hover does not hide: since when it has been orphaned is
          // in the created column's neighbour, not in a tooltip.
          <Badge variant="warning">{t("spaces.personal.orphanedBadge")}</Badge>
        ) : app.personal ? (
          <Badge variant="secondary">{t("spaces.personal.badge")}</Badge>
        ) : app.isDefault ? (
          <Badge variant="running">{defaultLabel}</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "created",
      header: t("applications.createdColumn"),
      width: "132px",
      align: "end",
      // Tier 2, not 3: the settings dialog tops out around 800px and never
      // crosses the 56rem threshold, so tier 3 there means never drawn.
      tier: 2,
      cell: (app) => (
        <span className="text-muted-foreground text-xs">
          {app.orphaned_at
            ? t("spaces.personal.orphanedSince", {
                date: formatDateField(app.orphaned_at, "date"),
              })
            : formatDateField(app.createdAt, "date")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (app) => {
        // An orphan cannot be entered — its owner is gone — so it offers the
        // two acts that resolve it instead of the gear every other row has.
        const orphaned = Boolean(app.orphaned_at);
        if (orphaned && (onConvert || onSweep)) {
          return (
            <TableRowActions menuLabel={t("spaces.rowActions", { name: spaceLabel(app, t) })}>
              {onConvert && (
                <DropdownMenuItem disabled={actionsBusy} onSelect={() => onConvert(app.id)}>
                  <FolderInput />
                  {t("spaces.personal.convert")}
                </DropdownMenuItem>
              )}
              {onConvert && onSweep && <DropdownMenuSeparator />}
              {onSweep && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={actionsBusy}
                  onSelect={() => onSweep(app.id)}
                >
                  <Trash2 />
                  {t("spaces.personal.sweep")}
                </DropdownMenuItem>
              )}
            </TableRowActions>
          );
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            // A `closed` space is listed so the caller knows it exists, not so
            // they can be dropped into it: pinning one 403s every space-scoped
            // request. Same rule as the org switcher.
            disabled={orphaned || (app.access !== undefined && app.access !== "member")}
            onClick={() => onOpen(app.id)}
            title={t("nav.appSettings", { ns: "common" })}
            aria-label={t("nav.appSettings", { ns: "common" })}
            data-testid={`application-settings-${app.id}`}
          >
            <Settings size={16} />
          </Button>
        );
      },
    },
  ];
}
