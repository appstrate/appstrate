// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import type { IntegrationConnection } from "../../hooks/use-integrations";
import { connectionOptionLabel, toggleCapped } from "../../lib/connection-set";

const NONE: readonly string[] = [];

/**
 * The set of connections an admin imposes for one integration (an agent's pin, the space default):
 * the connections shared into the space as a plain list of boxes, capped at
 * `MAX_CONNECTIONS_PER_INTEGRATION`. A stored member no longer shared (`unavailableIds`) is listed
 * as « Connexion indisponible »: ticked (it is in `value`) it can be unticked, never ticked again.
 */
export function ConnectionCheckboxList({
  idPrefix,
  connections,
  unavailableIds = NONE,
  value,
  onChange,
  disabled = false,
  "aria-labelledby": labelledBy,
}: {
  /** Each box's id and test id read `<idPrefix>-<connection id>`. */
  idPrefix: string;
  /** The connections shared into the space, in the server's order. */
  connections: readonly IntegrationConnection[];
  unavailableIds?: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
}) {
  const { t } = useTranslation("settings");
  const atCap = value.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  const rows = [
    ...connections.map((c) => ({
      id: c.id,
      label: connectionOptionLabel(c),
      // Owner and variables tell same-named connections apart.
      description: Object.values(c.variables ?? {}).join(" · ") || undefined,
      unavailable: false,
    })),
    ...unavailableIds.map((id) => ({
      id,
      label: t("integration.admin.unavailableConnection"),
      description: undefined,
      unavailable: true,
    })),
  ];
  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-col gap-3">
      {rows.map((row) => {
        const checked = value.includes(row.id);
        return (
          <CheckboxField
            key={row.id}
            id={`${idPrefix}-${row.id}`}
            data-testid={`${idPrefix}-${row.id}`}
            label={row.unavailable ? <span className="text-warning">{row.label}</span> : row.label}
            description={row.description}
            checked={checked}
            disabled={disabled || (!checked && (atCap || row.unavailable))}
            onCheckedChange={() => onChange(toggleCapped([...value], row.id))}
          />
        );
      })}
      {atCap && rows.some((row) => !value.includes(row.id)) && (
        <p className="text-muted-foreground text-xs">
          {t("integration.admin.connectionList.maxReached", {
            max: MAX_CONNECTIONS_PER_INTEGRATION,
          })}
        </p>
      )}
    </div>
  );
}
