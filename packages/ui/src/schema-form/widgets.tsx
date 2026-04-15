// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Custom RJSF widgets — framework-agnostic (no shadcn/radix deps).
// Single- and multi-selects both use react-select so we get a rich,
// consistent dropdown in every Appstrate surface.

import type { WidgetProps } from "@rjsf/utils";
import Select, { type StylesConfig } from "react-select";
import { cn } from "./cn.ts";
import { LABEL_CLASS } from "./primitives.tsx";
export { FileWidget } from "./file-widget.tsx";

interface EnumOption {
  value: unknown;
  label: string;
}

// react-select custom styles mapped onto Appstrate's CSS variables so the
// dropdown picks up the current theme (dark/light) via CSS tokens.
const selectStyles: StylesConfig<EnumOption> = {
  control: (base) => ({
    ...base,
    backgroundColor: "transparent",
    borderColor: "var(--border)",
    minHeight: "2.25rem",
  }),
  menu: (base) => ({ ...base, backgroundColor: "var(--popover)" }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? "var(--accent)" : "transparent",
    color: "inherit",
  }),
  multiValue: (base) => ({ ...base, backgroundColor: "var(--secondary)" }),
  input: (base) => ({ ...base, color: "inherit" }),
  singleValue: (base) => ({ ...base, color: "inherit" }),
  placeholder: (base) => ({ ...base, color: "var(--muted-foreground)" }),
};

export function TextareaWidget(props: WidgetProps) {
  const { id, value, onChange, required, readonly, disabled, placeholder, rawErrors } = props;
  return (
    <textarea
      id={id}
      value={(value as string | undefined) ?? ""}
      required={required}
      readOnly={readonly}
      disabled={disabled}
      placeholder={placeholder}
      rows={5}
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[60px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        rawErrors && rawErrors.length > 0 && "border-destructive",
      )}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    />
  );
}

export function CheckboxWidget(props: WidgetProps) {
  const { id, value, onChange, required, disabled, label } = props;
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={id}
        checked={Boolean(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="border-primary text-primary focus-visible:ring-ring h-4 w-4 shrink-0 rounded-sm border shadow focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      />
      {label && (
        <label htmlFor={id} className={cn(LABEL_CLASS, "cursor-pointer font-normal")}>
          {label}
          {required && " *"}
        </label>
      )}
    </div>
  );
}

export function SelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, options, placeholder } = props;
  const enumOptions = (options.enumOptions as EnumOption[] | undefined) ?? [];

  const selected = enumOptions.find((o) => String(o.value) === String(value)) ?? null;

  return (
    <Select<EnumOption, false>
      inputId={id}
      isDisabled={disabled}
      isClearable
      options={enumOptions}
      value={selected}
      placeholder={placeholder ?? ""}
      onChange={(opt) => onChange(opt ? opt.value : undefined)}
      classNamePrefix="rjsf-select"
      styles={selectStyles}
    />
  );
}

/** Array of enums → multi-select dropdown via react-select. */
export function MultiSelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, options } = props;
  const enumOptions = (options.enumOptions as EnumOption[] | undefined) ?? [];

  const raw = Array.isArray(value) ? value : [];
  const selected = enumOptions.filter((o) => raw.some((v) => String(v) === String(o.value)));

  return (
    <Select<EnumOption, true>
      inputId={id}
      isMulti
      isDisabled={disabled}
      options={enumOptions}
      value={selected}
      onChange={(sel) => onChange(sel.map((s) => s.value))}
      classNamePrefix="rjsf-ms"
      styles={selectStyles as StylesConfig<EnumOption, true>}
    />
  );
}
