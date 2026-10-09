// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { connectionOptionLabel, toggleCapped, type ConnectionSet } from "../../lib/connection-set";
import { ConnectionVariablesLine } from "../integration-connect/connection-variables-line";
import { NoConnectionLabel } from "../integration-connect/no-connection-label";
import type { IntegrationConnection } from "../../hooks/use-integrations";

interface ChecklistOption {
  id: string;
  label: ReactNode;
  /** Refuses a tick; a ticked one can still be unticked. */
  disabled?: boolean;
}

/** An org-wide connection's option label: owner and variables tell same-named rows apart. */
export function ConnectionOptionLabel({ connection }: { connection: IntegrationConnection }) {
  return (
    <>
      {connectionOptionLabel(connection)}
      <ConnectionVariablesLine variables={connection.variables} />
    </>
  );
}

/**
 * Checkbox set capped at {@link MAX_CONNECTIONS_PER_INTEGRATION}. Unticking the last box gives
 * `null` (no choice at this layer); `[]` comes only from the `allowNone` box. `unavailableIds` are
 * stored members no longer offered: listed unticked, so a save visibly drops them.
 */
export function ConnectionSetChecklist({
  options,
  value,
  onChange,
  idPrefix,
  unavailableIds,
  allowNone = false,
  noneHint,
}: {
  options: readonly ChecklistOption[];
  value: ConnectionSet;
  onChange: (next: ConnectionSet) => void;
  idPrefix: string;
  unavailableIds?: string[];
  allowNone?: boolean;
  /** Overrides the default "runs without this integration" hint of the none box. */
  noneHint?: string;
}) {
  const { t } = useTranslation(["settings", "agents"]);
  const picked = value ?? [];
  const atCap = picked.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  const noneId = `${idPrefix}-none`;
  return (
    <div className="flex flex-col gap-1" data-testid={`${idPrefix}s`}>
      {options.map((o) => {
        const id = `${idPrefix}-${o.id}`;
        const isChecked = picked.includes(o.id);
        return (
          <div key={o.id} className="flex items-center gap-2 text-xs">
            <Checkbox
              id={id}
              checked={isChecked}
              disabled={!isChecked && (atCap || o.disabled === true)}
              onCheckedChange={() => {
                const next = toggleCapped(picked, o.id);
                onChange(next.length > 0 ? next : null);
              }}
              data-testid={id}
            />
            <label htmlFor={id} className="min-w-0">
              {o.label}
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
      {atCap && options.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("agents:detail.integrationMemberPicker.maxReached", {
            max: MAX_CONNECTIONS_PER_INTEGRATION,
          })}
        </p>
      )}
      {allowNone && (
        <div className="flex items-center gap-2 text-xs">
          <Checkbox
            id={noneId}
            checked={value?.length === 0}
            onCheckedChange={(checked) => onChange(checked === true ? [] : null)}
            data-testid={noneId}
          />
          <label htmlFor={noneId} className="min-w-0">
            <NoConnectionLabel hint={noneHint} />
          </label>
        </div>
      )}
    </div>
  );
}
