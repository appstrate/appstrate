// SPDX-License-Identifier: Apache-2.0

import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type RjsfForm from "@rjsf/core";
import { ChevronDown, Lock } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import type { SchemaWrapper } from "@appstrate/core/form";
import { LazySchemaForm as SchemaForm } from "./lazy-schema-form";
import { useSchemaFormLabels } from "../hooks/use-schema-form-labels";
import { useUploadClient } from "../hooks/use-upload";
import {
  formatInputValue,
  hasInputFields,
  partitionInputFields,
  resolvedInputDefaults,
  subsetWrapper,
  type AgentInputSettings,
} from "../lib/agent-input";

/** Imperative surface for a caller whose submit button lives outside the form. */
export interface AgentInputFormHandle {
  /** Validate every rendered field and, when valid, call `onSubmit`. */
  submit: () => void;
}

export interface AgentInputFormProps {
  /** The agent's single parameter schema (AFPS wrapper). */
  wrapper: SchemaWrapper | undefined;
  /** Stored values + locks for this application — the platform layers. */
  settings: AgentInputSettings;
  /** Current caller-editable values (locked fields are never part of this). */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Fired by {@link AgentInputFormHandle.submit} once the fields validate. */
  onSubmit?: (input: Record<string, unknown>) => void;
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
 * A locked field is DISPLAYED, never hidden: the run will use that value, and
 * a launcher that silently omits it hides half of what is about to execute.
 * It renders as a value with a lock, not as a greyed-out input — "imposed" and
 * "temporarily disabled" must not look the same.
 *
 * Shared by the run modal, the run-with-options modal and the schedule editor,
 * which all feed the same `input` field of the same API.
 */
export function AgentInputForm({
  wrapper,
  settings,
  value,
  onChange,
  onSubmit,
  ref,
}: AgentInputFormProps) {
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

  const replaceSubset = (keys: string[], formData: Record<string, unknown>) => {
    const next = { ...value };
    for (const key of keys) delete next[key];
    onChange({ ...next, ...formData });
  };

  const mergedWith = (keys: string[], formData: Record<string, unknown>) => {
    const next = { ...value };
    for (const key of keys) delete next[key];
    return { ...next, ...formData };
  };

  useImperativeHandle(ref, () => ({
    submit: () => {
      // The advanced fields are collapsed, so a validation error there would be
      // invisible: check them first and unfold on failure.
      if (advancedRef.current && !advancedRef.current.validateForm()) {
        setAdvancedOpen(true);
        return;
      }
      // RJSF re-validates on submit and calls `onSubmit` with the clean data.
      if (promptedRef.current) {
        promptedRef.current.submit();
        return;
      }
      onSubmit?.(value);
    },
  }));

  if (!hasInputFields(wrapper)) return null;

  return (
    <div className="space-y-3" data-testid="agent-input-form">
      {partition.locked.length > 0 && (
        <div
          className="border-border bg-muted/40 space-y-2 rounded-md border p-3"
          data-testid="locked-input-fields"
        >
          <div className="text-foreground flex items-center gap-1.5 text-xs font-medium">
            <Lock className="size-3.5" aria-hidden />
            {t("input.lockedTitle")}
          </div>
          <p className="text-muted-foreground text-xs">{t("input.lockedHint")}</p>
          <dl className="space-y-1.5">
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
            onChange={(e) =>
              replaceSubset(partition.prompted, e.formData as Record<string, unknown>)
            }
            onSubmit={(e) =>
              onSubmit?.(mergedWith(partition.prompted, e.formData as Record<string, unknown>))
            }
          />
        </div>
      )}

      {advancedWrapper && (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
              data-testid="advanced-input-toggle"
            >
              <span>{t("input.advancedTitle")}</span>
              <ChevronDown
                className={cn(
                  "text-muted-foreground size-4 transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-3" data-testid="advanced-input-fields">
            <p className="text-muted-foreground text-xs">{t("input.advancedHint")}</p>
            <SchemaForm
              ref={advancedRef}
              wrapper={advancedWrapper}
              formData={pick(value, partition.prefilled)}
              upload={upload}
              labels={labels}
              onChange={(e) =>
                replaceSubset(partition.prefilled, e.formData as Record<string, unknown>)
              }
            />
          </CollapsibleContent>
        </Collapsible>
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
