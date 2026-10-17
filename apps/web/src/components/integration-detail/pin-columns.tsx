// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import type { DataColumn } from "../data-table";
import { rowActionsColumn } from "../row-actions-column";
import { TableRowActions } from "../table-row-actions";
import { CellText } from "../table-cells";
import type { IntegrationConnection, IntegrationPin } from "@appstrate/shared-types";
import { connectionOptionLabel } from "../../lib/connection-set";
import { PIN_MODE_KEYS, pinMode } from "../../lib/admin-pin-payload";

/** The pins table: read-only cells, every change through the row's « … » menu. */
export function usePinColumns({
  agentName,
  pinnable,
  connections,
  isDeleting,
  onEdit,
  onDelete,
}: {
  agentName: (pin: IntegrationPin) => string;
  /** The connections shared into this space: the ones a pin can name. */
  pinnable: IntegrationConnection[];
  /** Undefined while loading: an unknown connection is then not yet "unavailable". */
  connections: IntegrationConnection[] | undefined;
  /** Only the row being deleted shows the spinner. */
  isDeleting: (pin: IntegrationPin) => boolean;
  /** Undefined while the connections load: the form needs them to tell an unavailable one. */
  onEdit: ((pin: IntegrationPin) => void) | undefined;
  /** Asks to delete: the caller confirms first. */
  onDelete: (pin: IntegrationPin) => void;
}): DataColumn<IntegrationPin>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "agent",
      header: t("integration.admin.pinManagement.colAgent"),
      width: 120,
      elastic: true,
      cell: (pin) => (
        <CellText strong title={agentName(pin)}>
          {agentName(pin)}
        </CellText>
      ),
    },
    {
      id: "connections",
      header: t("integration.admin.pinManagement.colConnections"),
      width: 140,
      elastic: true,
      cell: (pin) => {
        if (pin.connection_ids.length === 0) {
          return <CellText>{t("integration.admin.pinManagement.noConnection")}</CellText>;
        }
        // An unknown connection is not yet "unavailable" while they load.
        const entries = pin.connection_ids.flatMap((id) => {
          const connection = pinnable.find((c) => c.id === id);
          if (connection) return [{ id, label: connectionOptionLabel(connection), missing: false }];
          if (connections === undefined) return [];
          return [{ id, label: t("integration.admin.unavailableConnection"), missing: true }];
        });
        return (
          <CellText title={entries.map((e) => e.label).join(" · ")}>
            {entries.map((entry, i) => (
              <span key={entry.id}>
                {i > 0 && " · "}
                {/* No longer shared or deleted: every run of this agent is refused. */}
                {entry.missing ? <span className="text-warning">{entry.label}</span> : entry.label}
              </span>
            ))}
          </CellText>
        );
      },
    },
    {
      id: "mode",
      header: t("integration.admin.pinManagement.colMode"),
      width: 200,
      elastic: true,
      cell: (pin) => <CellText>{t(PIN_MODE_KEYS[pinMode(pin)])}</CellText>,
    },
    rowActionsColumn((pin: IntegrationPin) => (
      <TableRowActions
        menuLabel={t("integration.admin.pinManagement.rowActions", { agent: agentName(pin) })}
        isPending={isDeleting(pin)}
        actions={[
          {
            id: "edit",
            label: t("btn.edit", { ns: "common" }),
            icon: Pencil,
            onSelect: onEdit ? () => onEdit(pin) : undefined,
            disabled: onEdit === undefined,
            testId: `pin-edit-${pin.agent_package_id}`,
          },
          {
            id: "delete",
            label: t("btn.delete", { ns: "common" }),
            icon: Trash2,
            onSelect: () => onDelete(pin),
            destructive: true,
            testId: `pin-delete-${pin.agent_package_id}`,
          },
        ]}
      />
    )),
  ];
}
