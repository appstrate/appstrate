// SPDX-License-Identifier: Apache-2.0

import Select from "react-select";
import type { StylesConfig, MultiValue } from "react-select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface Option {
  value: string;
  label: string;
}

interface MultiSelectFieldProps {
  id: string;
  label: string;
  required?: boolean;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
  description?: string;
  error?: string;
}

const selectStyles: StylesConfig<Option, true> = {
  control: (base, state) => ({
    ...base,
    background: "var(--color-background)",
    borderColor: state.isFocused ? "var(--color-ring)" : "var(--color-input)",
    borderRadius: "calc(var(--radius) - 2px)",
    minHeight: "36px",
    fontSize: "0.875rem",
    boxShadow: "none",
    "&:hover": { borderColor: "var(--color-ring)" },
  }),
  menu: (base) => ({
    ...base,
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: "calc(var(--radius) - 2px)",
    zIndex: 50,
  }),
  option: (base, state) => ({
    ...base,
    background: state.isFocused ? "var(--color-accent)" : "transparent",
    color: "var(--color-popover-foreground)",
    fontSize: "0.875rem",
    cursor: "pointer",
    "&:active": { background: "var(--color-accent)" },
  }),
  multiValue: (base) => ({
    ...base,
    background: "var(--color-secondary)",
    borderRadius: "calc(var(--radius) - 4px)",
  }),
  multiValueLabel: (base) => ({
    ...base,
    color: "var(--color-secondary-foreground)",
    fontSize: "0.75rem",
    padding: "1px 4px",
  }),
  multiValueRemove: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--color-destructive)",
      color: "var(--color-destructive-foreground)",
    },
  }),
  placeholder: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
  }),
  input: (base) => ({
    ...base,
    color: "var(--color-foreground)",
  }),
  indicatorSeparator: () => ({ display: "none" }),
  dropdownIndicator: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    padding: "4px",
  }),
  clearIndicator: (base) => ({
    ...base,
    color: "var(--color-muted-foreground)",
    padding: "4px",
    cursor: "pointer",
  }),
};

export function MultiSelectField({
  id,
  label: fieldLabel,
  required,
  options,
  value,
  onChange,
  description,
  error,
}: MultiSelectFieldProps) {
  const selectOptions: Option[] = options.map((o) => ({ value: o, label: o }));
  const selectedOptions = selectOptions.filter((o) => value.includes(o.value));

  const handleChange = (selected: MultiValue<Option>) => {
    onChange(selected.map((o) => o.value));
  };

  const hintId = description ? `hint-${id}` : undefined;
  const errorId = error ? `error-${id}` : undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {fieldLabel}
        {required ? " *" : ""}
      </Label>
      <Select<Option, true>
        inputId={id}
        isMulti
        options={selectOptions}
        value={selectedOptions}
        onChange={handleChange}
        styles={selectStyles}
        classNames={{
          control: () => cn(error && "!border-destructive"),
        }}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
      />
      {description && (
        <p id={hintId} className="text-muted-foreground text-sm">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
