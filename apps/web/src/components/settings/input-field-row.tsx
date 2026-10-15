// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { SchemaWrapper } from "@appstrate/core/form";
import { LazySchemaForm as SchemaForm } from "../lazy-schema-form";
import type { useSchemaFormLabels } from "../../hooks/use-schema-form-labels";
import type { useUploadClient } from "../../hooks/use-upload";
import { subsetWrapper } from "../../lib/agent-input";

/**
 * One input as a settings row: its field, then under it what the value is
 * (left) and what can be done to it (right): a note is text, a control acts. The agent's Entrées (with
 * "Verrouiller") and a schedule's Entrées share it.
 */
export function InputFieldRow({
  fieldKey,
  wrapper,
  value,
  disabled,
  labels,
  upload,
  onValueChange,
  hint,
  control,
}: {
  fieldKey: string;
  wrapper: SchemaWrapper;
  value: unknown;
  disabled?: boolean;
  labels: ReturnType<typeof useSchemaFormLabels>;
  upload: ReturnType<typeof useUploadClient>;
  onValueChange: (next: unknown) => void;
  hint?: ReactNode;
  control?: ReactNode;
}) {
  const subset = subsetWrapper(wrapper, [fieldKey]);
  if (!subset) return null;
  // `required` is dropped exactly as the server drops it: an empty value here
  // means "not decided — ask at launch", not "invalid".
  const fieldSchema = { ...subset.schema };
  delete fieldSchema.required;
  const fieldWrapper: SchemaWrapper = { ...subset, schema: fieldSchema };

  return (
    <div className="space-y-1.5" data-testid={`input-setting-${fieldKey}`}>
      <SchemaForm
        wrapper={fieldWrapper}
        formData={value === undefined ? {} : { [fieldKey]: value }}
        upload={upload}
        labels={labels}
        disabled={disabled}
        onChange={(e) => onValueChange((e.formData as Record<string, unknown>)[fieldKey])}
      />
      <div className="flex items-center justify-between gap-3">
        {hint ? (
          <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">{hint}</p>
        ) : (
          <span />
        )}
        {control}
      </div>
    </div>
  );
}
