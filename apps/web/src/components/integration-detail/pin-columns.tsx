// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Switch } from "@appstrate/ui/components/switch";
import type { DataColumn } from "../data-table";
import { rowActionsColumn } from "../row-actions-column";
import { TableRowActions } from "../table-row-actions";
import { CellText } from "../table-cells";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import type { IntegrationConnection, IntegrationPin } from "@appstrate/shared-types";
import { connectionOptionLabel, unavailableConnectionIds } from "../../lib/connection-set";
import { additionsRefusal, ADDITIONS_REFUSAL_KEYS } from "../../lib/admin-pin-payload";

export function usePinColumns({
  agentName,
  pinnable,
  connections,
  isDeleting,
  onDelete,
  enforcedDefault,
  isToggling,
  onToggleAdditions,
}: {
  agentName: (pin: IntegrationPin) => string;
  /** The connections shared into this space: the ones a pin can name. */
  pinnable: IntegrationConnection[];
  /** Undefined while loading: an unknown connection is then not yet "unavailable". */
  connections: IntegrationConnection[] | undefined;
  /** Only the row being deleted shows the spinner. */
  isDeleting: (pin: IntegrationPin) => boolean;
  onDelete: (pin: IntegrationPin) => void;
  /** The space enforces a default for this integration: no pin may open to additions. */
  enforcedDefault: boolean;
  /** Only the row being rewritten waits. */
  isToggling: (pin: IntegrationPin) => boolean;
  /** Asks to rewrite the pin with the flag flipped, its imposed set as stored. */
  onToggleAdditions: (pin: IntegrationPin) => void;
}): DataColumn<IntegrationPin>[] {
  const { t } = useTranslation(["settings", "agents"]);

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
          return <CellText>{t("agents:detail.integrationMemberPicker.none")}</CellText>;
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
      id: "additions",
      header: t("integration.admin.pinManagement.colAdditions"),
      control: true,
      width: 120,
      cell: (pin) => {
        // Until the connections load, a stored member cannot be told unavailable: the switch waits.
        const unavailableIds = connections
          ? unavailableConnectionIds(
              pin.connection_ids,
              pinnable.map((c) => c.id),
            )
          : [];
        // A pin of an agent not active in the space cannot be rewritten (the server answers 404).
        const refusal = additionsRefusal(pin, {
          enforcedDefault,
          unavailableIds,
          agentInactive: !pin.agent_active,
        });
        return (
          // `relative z-10`: sit above the row link's overlay or the row swallows the click (see `data-table.tsx`).
          <span className="relative z-10 flex min-w-0 items-center gap-1.5">
            <DisabledReasonTooltip reason={refusal ? t(ADDITIONS_REFUSAL_KEYS[refusal]) : null}>
              <Switch
                checked={pin.allow_additional_connections}
                disabled={refusal !== null || connections === undefined || isToggling(pin)}
                aria-label={t("integration.admin.pinManagement.allowAdditionsFor", {
                  agent: agentName(pin),
                })}
                onCheckedChange={() => onToggleAdditions(pin)}
                data-testid={`pin-additions-${pin.agent_package_id}`}
              />
            </DisabledReasonTooltip>
            <span className="text-muted-foreground text-[0.7rem]">
              {t(
                pin.allow_additional_connections
                  ? "integration.admin.pinManagement.additionsOpen"
                  : "integration.admin.pinManagement.additionsClosed",
              )}
            </span>
          </span>
        );
      },
    },
    rowActionsColumn((pin: IntegrationPin) => (
      <TableRowActions
        menuLabel={t("integration.admin.pinManagement.rowActions", { agent: agentName(pin) })}
        isPending={isDeleting(pin)}
        actions={[
          {
            id: "delete",
            label: t("integration.admin.pinManagement.delete"),
            icon: Trash2,
            onSelect: () => onDelete(pin),
            destructive: true,
          },
        ]}
      />
    )),
  ];
}
