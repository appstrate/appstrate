// SPDX-License-Identifier: Apache-2.0

import { Label } from "@appstrate/ui/components/label";
import { Input } from "@appstrate/ui/components/input";
import { Textarea } from "@appstrate/ui/components/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

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
  disabled,
  min,
}: FormFieldProps) {
  const describedBy = description ? `hint-${id}` : undefined;

  const renderInput = () => {
    if (enumValues) {
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={id} aria-describedby={describedBy}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    if (type === "textarea") {
      return (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          rows={4}
          aria-describedby={describedBy}
        />
      );
    }

    if (type === "color") {
      return (
        <Input
          id={id}
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          required={required}
          aria-describedby={describedBy}
          className="h-10 w-20 cursor-pointer p-1"
        />
      );
    }

    return (
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        min={min}
        aria-describedby={describedBy}
      />
    );
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </Label>
      {renderInput()}
      {description && (
        <p id={describedBy} className="text-muted-foreground text-sm">
          {description}
        </p>
      )}
    </div>
  );
}
