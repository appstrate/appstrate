// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { connectionOptionLabel, toggleCapped } from "../../lib/connection-set";
import type { IntegrationConnection } from "../../hooks/use-integrations";

/**
 * Checkbox set capped at {@link MAX_CONNECTIONS_PER_INTEGRATION}. `unavailableIds` are stored
 * members no longer offered: listed unticked, so the next write visibly drops them.
 */
export function ConnectionSetChecklist({
  connections,
  value,
  onChange,
  idPrefix,
  labelledBy,
  unavailableIds,
  disabled = false,
}: {
  connections: IntegrationConnection[];
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
  labelledBy: string;
  unavailableIds?: string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="flex flex-col gap-2"
      data-testid={`${idPrefix}s`}
    >
      {connections.map((c) => {
        const id = `${idPrefix}-${c.id}`;
        const isChecked = value.includes(c.id);
        return (
          <div key={c.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={isChecked}
              disabled={disabled || (!isChecked && value.length >= MAX_CONNECTIONS_PER_INTEGRATION)}
              onCheckedChange={() => onChange(toggleCapped(value, c.id))}
              data-testid={id}
            />
            <label htmlFor={id} className="min-w-0 truncate">
              {connectionOptionLabel(c)}
            </label>
          </div>
        );
      })}
      {unavailableIds?.map((id) => (
        <div
          key={id}
          className="flex items-center gap-2 text-sm"
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
