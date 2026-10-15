// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Custom RJSF widgets. The single select is a searchable combobox, the multi-select a checkbox list.

import { deepEquals, type WidgetProps } from "@rjsf/utils";
import { cn } from "../cn.ts";
import { Checkbox } from "../components/checkbox.tsx";
import { Combobox } from "../components/combobox.tsx";
import { Label } from "../components/label.tsx";
import { Textarea } from "../components/textarea.tsx";
import type { SchemaFormContext } from "./context.ts";
export { FileWidget } from "./file-widget.tsx";

interface EnumOption {
  value: unknown;
  label: string;
}

export function TextareaWidget(props: WidgetProps) {
  const { id, value, onChange, required, readonly, disabled, placeholder, rawErrors } = props;
  return (
    <Textarea
      id={id}
      value={(value as string | undefined) ?? ""}
      required={required}
      readOnly={readonly}
      disabled={disabled}
      placeholder={placeholder}
      rows={5}
      className={cn(rawErrors && rawErrors.length > 0 && "border-destructive")}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    />
  );
}

export function CheckboxWidget(props: WidgetProps) {
  const { id, value, onChange, required, disabled, label } = props;
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={Boolean(value)}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
      {label && (
        <Label htmlFor={id} className="cursor-pointer font-normal">
          {label}
          {required && " *"}
        </Label>
      )}
    </div>
  );
}

/** The select's "no match" sentence, from the form's labels (translated by the app). */
function noOptionsText(props: WidgetProps): string {
  const labels = ((props.registry?.formContext ?? {}) as SchemaFormContext).labels;
  return labels?.noOptions ?? "No options";
}

/** Primitives compare by text ("1" matches 1); objects deeply, since jsonb reorders keys. */
function sameOptionValue(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") return deepEquals(a, b);
  return String(a) === String(b);
}

/** An enum value is any JSON, the combobox's key a string: the option's position stands in. */
function comboboxOptions(enumOptions: EnumOption[]) {
  return enumOptions.map((option, index) => ({
    value: String(index),
    label: option.label,
    keywords: [option.label],
  }));
}

export function SelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, options, placeholder } = props;
  const enumOptions = (options.enumOptions as EnumOption[] | undefined) ?? [];
  const selected = enumOptions.findIndex((o) => sameOptionValue(o.value, value));

  return (
    <Combobox
      id={id}
      disabled={disabled}
      clearable
      options={comboboxOptions(enumOptions)}
      value={selected === -1 ? "" : String(selected)}
      placeholder={placeholder ?? ""}
      onValueChange={(key) => onChange(key === "" ? undefined : enumOptions[Number(key)]!.value)}
      searchPlaceholder=""
      emptyText={noOptionsText(props)}
    />
  );
}

/** Array of enums → one checkbox per option. */
export function MultiSelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, options } = props;
  const enumOptions = (options.enumOptions as EnumOption[] | undefined) ?? [];
  const raw = Array.isArray(value) ? value : [];
  const isPicked = (option: EnumOption) => raw.some((v) => sameOptionValue(v, option.value));

  return (
    <div id={id} className="flex flex-col gap-2">
      {enumOptions.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Checkbox
            id={`${id}-${index}`}
            checked={isPicked(option)}
            disabled={disabled}
            onCheckedChange={(on) =>
              onChange(
                enumOptions
                  .filter((o, i) => (i === index ? on === true : isPicked(o)))
                  .map((o) => o.value),
              )
            }
          />
          <Label htmlFor={`${id}-${index}`} className="cursor-pointer font-normal">
            {option.label}
          </Label>
        </div>
      ))}
    </div>
  );
}
