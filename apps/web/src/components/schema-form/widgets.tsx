// SPDX-License-Identifier: Apache-2.0

import type { WidgetProps } from "@rjsf/utils";
import Select from "react-select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select as ShadSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
export { FileWidget } from "./file-widget";

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
        onCheckedChange={(v) => onChange(Boolean(v))}
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

export function SelectWidget(props: WidgetProps) {
  const { id, value, onChange, required, disabled, options, placeholder } = props;
  const enumOptions =
    (options.enumOptions as { value: unknown; label: string }[] | undefined) ?? [];
  return (
    <ShadSelect
      value={value == null ? "" : String(value)}
      onValueChange={(v) => {
        const match = enumOptions.find((o) => String(o.value) === v);
        onChange(match ? match.value : v);
      }}
      disabled={disabled}
      required={required}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder ?? ""} />
      </SelectTrigger>
      <SelectContent>
        {enumOptions.map((o) => (
          <SelectItem key={String(o.value)} value={String(o.value)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadSelect>
  );
}

/** Array of enums → multi-select dropdown via react-select. */
export function MultiSelectWidget(props: WidgetProps) {
  const { id, value, onChange, disabled, options } = props;
  const enumOptions =
    (options.enumOptions as { value: unknown; label: string }[] | undefined) ?? [];

  const raw = Array.isArray(value) ? value : [];
  const selected = enumOptions.filter((o) => raw.some((v) => String(v) === String(o.value)));

  return (
    <Select
      inputId={id}
      isMulti
      isDisabled={disabled}
      options={enumOptions}
      value={selected}
      onChange={(selected) => onChange(selected.map((s) => s.value))}
      classNamePrefix="rjsf-ms"
      styles={{
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
      }}
    />
  );
}
