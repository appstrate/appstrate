// SPDX-License-Identifier: Apache-2.0

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type FormFieldType =
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

export interface FormFieldProps {
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
  error?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  step?: number | "any";
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
  error,
  disabled,
  min,
  max,
  minLength,
  maxLength,
  pattern,
  step,
}: FormFieldProps) {
  const hintId = description ? `hint-${id}` : undefined;
  const errorId = error ? `error-${id}` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const renderInput = () => {
    if (enumValues) {
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            id={id}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className={cn(error && "border-destructive")}
          >
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
          minLength={minLength}
          maxLength={maxLength}
          rows={4}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(error && "border-destructive")}
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
          aria-invalid={error ? true : undefined}
          className={cn("h-10 w-20 cursor-pointer p-1", error && "border-destructive")}
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
        max={max}
        minLength={minLength}
        maxLength={maxLength}
        pattern={pattern}
        step={step}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(error && "border-destructive")}
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
