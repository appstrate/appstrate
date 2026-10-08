// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { connectionOptionLabel, toggleCapped } from "../../lib/connection-set";
import { ConnectionVariablesLine } from "../integration-connect/connection-variables-line";
import type { IntegrationConnection } from "../../hooks/use-integrations";

/**
 * Checkbox set capped at {@link MAX_CONNECTIONS_PER_INTEGRATION}. `unavailableIds` are stored
 * members no longer offered: listed unticked, so a save visibly drops them.
 */
export function ConnectionSetChecklist({
  connections,
  value,
  onChange,
  idPrefix,
  unavailableIds,
}: {
  connections: IntegrationConnection[];
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
  unavailableIds?: string[];
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col gap-1" data-testid={`${idPrefix}s`}>
      {connections.map((c) => {
        const id = `${idPrefix}-${c.id}`;
        const isChecked = value.includes(c.id);
        return (
          <div key={c.id} className="flex items-center gap-2 text-xs">
            <Checkbox
              id={id}
              checked={isChecked}
              disabled={!isChecked && value.length >= MAX_CONNECTIONS_PER_INTEGRATION}
              onCheckedChange={() => onChange(toggleCapped(value, c.id))}
              data-testid={id}
            />
            <label htmlFor={id} className="min-w-0">
              {connectionOptionLabel(c)}
              <ConnectionVariablesLine variables={c.variables} />
            </label>
          </div>
        );
      })}
      {unavailableIds?.map((id) => (
        <div
          key={id}
          className="flex items-center gap-2 text-xs"
          data-testid={`${idPrefix}-unavailable-${id}`}
        >
          <Checkbox checked={false} disabled aria-hidden />
          <span className="text-muted-foreground line-through">
            {t("integration.admin.unavailableConnection")}
          </span>
        </div>
      ))}
    </div>
  );
}
