// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule's inputs, one row per field of the agent's input schema: the form of the new-schedule
 * modal and of a schedule's Entrées. A field the agent locks is the agent's value at every fire;
 * the agent's own value is said only where this schedule replaces it.
 */

import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authorDefaults, getOrderedKeys } from "@appstrate/core/form";
import { InputFieldRow } from "./settings/input-field-row";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import type { useScheduleFormDeps } from "../hooks/use-schedules";
import { useUploadClient } from "../hooks/use-upload";
import { formatInputValue, hasInputFields } from "../lib/agent-input";

export function ScheduleInputFields({
  deps,
  values,
  onChange,
}: {
  deps: NonNullable<ReturnType<typeof useScheduleFormDeps>["deps"]>;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();
  const wrapper = deps.inputWrapper;

  if (deps.hasFileInputs) {
    return <p className="text-muted-foreground text-sm">{t("schedule.fileInputBlocked")}</p>;
  }
  if (!hasInputFields(wrapper)) {
    return <p className="text-muted-foreground text-sm">{t("detail.emptyConfig")}</p>;
  }
  const defaults = authorDefaults(wrapper.schema);
  return (
    <div className="flex flex-col gap-4">
      {getOrderedKeys(wrapper.schema, wrapper.property_order).map((key) => {
        const locked = wrapper.locked_fields.includes(key);
        const agentValue = wrapper.values[key] ?? defaults[key];
        return (
          <InputFieldRow
            key={key}
            fieldKey={key}
            wrapper={wrapper}
            value={locked ? agentValue : values[key]}
            disabled={locked}
            labels={labels}
            upload={upload}
            onValueChange={(next) => {
              const out = { ...values };
              if (next === undefined) delete out[key];
              else out[key] = next;
              onChange(out);
            }}
            hint={
              locked ? (
                <>
                  <Lock className="size-3.5" aria-hidden />
                  {t("schedule.settings.lockedByAgent")}
                </>
              ) : agentValue !== undefined &&
                JSON.stringify(values[key]) !== JSON.stringify(agentValue) ? (
                t("schedule.settings.agentValue", { value: formatInputValue(agentValue) })
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
