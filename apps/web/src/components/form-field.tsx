// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps, ReactNode } from "react";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { OptionSelect } from "@/components/app-ui/option-select";
import { Textarea } from "@appstrate/ui/components/textarea";

interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  type?: ComponentProps<typeof Input>["type"] | "textarea";
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  description?: string;
  enumValues?: string[];
  /** Display label of an enum option; the raw value when omitted. */
  enumLabel?: (value: string) => string;
  disabled?: boolean;
  min?: number;
  /** Shown beside the label (e.g. a discovery provenance badge). */
  badge?: ReactNode;
}

export function FormField({
  id,
  label,
  required,
  type = "text",
  value,
  onChange,
  onBlur,
  placeholder,
  description,
  enumValues,
  enumLabel,
  disabled,
  min,
  badge,
}: FormFieldProps) {
  const renderInput = () => {
    if (enumValues) {
      return (
        <OptionSelect
          value={value}
          onValueChange={onChange}
          options={enumValues.map((opt) => ({
            value: opt,
            label: enumLabel ? enumLabel(opt) : opt,
          }))}
        />
      );
    }

    if (type === "textarea") {
      return (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          rows={4}
        />
      );
    }

    return (
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        min={min}
      />
    );
  };

  const text = required ? `${label} *` : label;
  return (
    <FormItem
      id={id}
      label={
        badge ? (
          <span className="inline-flex items-center gap-2">
            {text}
            {badge}
          </span>
        ) : (
          text
        )
      }
      hint={description}
    >
      {renderInput()}
    </FormItem>
  );
}
