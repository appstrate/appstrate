// SPDX-License-Identifier: Apache-2.0

import { FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { OptionSelect } from "@appstrate/ui/components/select";
import { Textarea } from "@appstrate/ui/components/textarea";

type FormFieldType =
  | "text"
  | "number"
  | "textarea"
  | "email"
  | "url"
  | "date"
  | "datetime-local"
  | "time"
  | "color"
  | "password";

interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  type?: FormFieldType;
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

    if (type === "color") {
      return (
        <Input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          required={required}
          className="h-10 w-20 cursor-pointer p-1"
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

  return (
    <FormItem id={id} label={required ? `${label} *` : label} hint={description}>
      {renderInput()}
    </FormItem>
  );
}
