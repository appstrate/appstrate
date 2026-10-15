// SPDX-License-Identifier: Apache-2.0

import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type RjsfForm from "@rjsf/core";
import { Lock } from "lucide-react";
import type { SchemaWrapper } from "@appstrate/core/form";
import { AdvancedSection } from "./advanced-section";
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { useUploadClient } from "../hooks/use-upload";
import {
  partitionInputFields,
  resolvedInputDefaults,
  type AgentInputSettings,
} from "@appstrate/core/input-resolution";
import { formatInputValue, hasInputFields, subsetWrapper } from "../lib/agent-input";

/** For a caller whose own `<form>` submits the values: it asks first whether they are valid. */
export interface AgentInputFormHandle {
  /** Validates every rendered field, showing the errors, and unfolds Avancé when one is there. */
  validate: () => boolean;
}

interface AgentInputFormProps {
  /** The agent's single parameter schema (AFPS wrapper). */
  wrapper: SchemaWrapper | undefined;
  /** Stored values + locks for this space — the platform layers. */
  settings: AgentInputSettings;
  /** Current caller-editable values (locked fields are never part of this). */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  ref?: Ref<AgentInputFormHandle>;
}

/**
 * The launch-time input form, in the platform's three display states.
 *
 * | state | source | rendering |
 * |---|---|---|
 * | locked | `locked_fields` | read-only value, not submitted |
 * | pre-filled | author `default` or a stored value | folded into "Avancé", collapsed |
 * | prompted | nothing decides it yet | asked at the top level |
 *
 * A locked field is DISPLAYED, never hidden (the run will use that value), as a value
 * with a lock rather than a greyed-out input: "imposed" and "disabled" must not look alike.
 */
export function AgentInputForm({ wrapper, settings, value, onChange, ref }: AgentInputFormProps) {
  const { t } = useTranslation(["agents"]);
  const labels = useSchemaFormLabels();
  const upload = useUploadClient();
  const promptedRef = useRef<RjsfForm>(null);
  const advancedRef = useRef<RjsfForm>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const partition = useMemo(() => partitionInputFields(wrapper, settings), [wrapper, settings]);
  const promptedWrapper = useMemo(
    () => subsetWrapper(wrapper, partition.prompted),
    [wrapper, partition.prompted],
  );
  const advancedWrapper = useMemo(
    () => subsetWrapper(wrapper, partition.prefilled),
    [wrapper, partition.prefilled],
  );
  const lockedValues = useMemo(() => resolvedInputDefaults(wrapper, settings), [wrapper, settings]);

  const mergedWith = (keys: string[], formData: Record<string, unknown>) => {
    const next = { ...value };
    for (const key of keys) delete next[key];
    return { ...next, ...formData };
  };

  useImperativeHandle(ref, () => ({
    validate: () => {
      // The advanced fields are collapsed, so a validation error there would be
      // invisible: check them first and unfold on failure.
      const advancedValid = advancedRef.current?.validateForm() ?? true;
      if (!advancedValid) setAdvancedOpen(true);
      return (promptedRef.current?.validateForm() ?? true) && advancedValid;
    },
  }));

  if (!hasInputFields(wrapper)) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="agent-input-form">
      {partition.locked.length > 0 && (
        <div
          className="border-border bg-muted/40 flex flex-col gap-2 rounded-md border p-3"
          data-testid="locked-input-fields"
        >
          <div className="text-foreground flex items-center gap-1.5 text-xs font-medium">
            <Lock className="size-3.5" aria-hidden />
            {t("input.lockedTitle")}
          </div>
          <p className="text-muted-foreground text-xs">{t("input.lockedHint")}</p>
          <dl className="flex flex-col gap-1.5">
            {partition.locked.map((key) => (
              <div
                key={key}
                className="flex items-baseline justify-between gap-3"
                data-testid={`locked-input-${key}`}
              >
                <dt className="text-muted-foreground text-xs">
                  {fieldTitle(wrapper, key)}
                  <span className="sr-only"> — {t("input.lockedBadge")}</span>
                </dt>
                <dd className="text-foreground truncate font-mono text-xs">
                  {formatInputValue(lockedValues[key])}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {promptedWrapper && (
        <div data-testid="prompted-input-fields">
          <SchemaForm
            ref={promptedRef}
            wrapper={promptedWrapper}
            formData={pick(value, partition.prompted)}
            upload={upload}
            labels={labels}
            tagName="div"
            onChange={(e) =>
              onChange(mergedWith(partition.prompted, e.formData as Record<string, unknown>))
            }
          />
        </div>
      )}

      {advancedWrapper && (
        <AdvancedSection
          title={t("input.advancedTitle")}
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          triggerTestId="advanced-input-toggle"
          contentTestId="advanced-input-fields"
          contentClassName="space-y-2"
        >
          <p className="text-muted-foreground text-xs">{t("input.advancedHint")}</p>
          <SchemaForm
            ref={advancedRef}
            wrapper={advancedWrapper}
            formData={pick(value, partition.prefilled)}
            upload={upload}
            labels={labels}
            tagName="div"
            onChange={(e) =>
              onChange(mergedWith(partition.prefilled, e.formData as Record<string, unknown>))
            }
          />
        </AdvancedSection>
      )}
    </div>
  );
}

function pick(values: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (values[key] !== undefined) out[key] = values[key];
  return out;
}

function fieldTitle(wrapper: SchemaWrapper | undefined, key: string): string {
  return wrapper?.schema?.properties?.[key]?.title || key;
}
