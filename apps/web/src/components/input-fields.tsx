// SPDX-License-Identifier: Apache-2.0

import { FormField, type FormFieldType } from "./form-field";
import { FileField } from "./file-field";
import { JsonFieldEditor } from "./json-field-editor";
import { MultiSelectField } from "./multi-select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { schemaToFields, toHtmlInputType, type SchemaWrapper } from "@appstrate/core/form";

interface InputFieldsProps {
  schema: SchemaWrapper;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  fileValues?: Record<string, File[]>;
  onFileChange?: (key: string, files: File[]) => void;
  idPrefix?: string;
  errors?: Record<string, string>;
}

export function InputFields({
  schema,
  values,
  onChange,
  fileValues,
  onFileChange,
  idPrefix = "input",
  errors,
}: InputFieldsProps) {
  const fields = schemaToFields(schema);

  return (
    <>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const error = errors?.[field.key];

        if (field.type === "file" || field.type === "file-multiple") {
          return (
            <FileField
              key={field.key}
              label={field.label}
              required={field.required}
              accept={field.fileConstraints?.accept}
              maxSize={field.fileConstraints?.maxSize}
              multiple={field.type === "file-multiple"}
              maxFiles={field.fileConstraints?.maxFiles}
              files={fileValues?.[field.key] ?? []}
              onChange={(files) => onFileChange?.(field.key, files)}
              description={field.description}
            />
          );
        }

        if (field.type === "boolean") {
          return (
            <div key={field.key} className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={Boolean(values[field.key])}
                  onCheckedChange={(checked) => onChange(field.key, Boolean(checked))}
                />
                <Label htmlFor={id} className="cursor-pointer">
                  {field.label}
                  {field.required ? " *" : ""}
                </Label>
              </div>
              {field.description && (
                <p className="text-muted-foreground text-sm">{field.description}</p>
              )}
              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>
          );
        }

        if (field.type === "json") {
          return (
            <JsonFieldEditor
              key={field.key}
              id={id}
              label={field.label}
              required={field.required}
              value={String(values[field.key] ?? "")}
              onChange={(v) => onChange(field.key, v)}
              description={field.description}
              error={error}
            />
          );
        }

        if (field.type === "multiselect" && field.multiselectOptions) {
          const currentValue = Array.isArray(values[field.key])
            ? (values[field.key] as string[])
            : [];
          return (
            <MultiSelectField
              key={field.key}
              id={id}
              label={field.label}
              required={field.required}
              options={field.multiselectOptions}
              value={currentValue}
              onChange={(v) => onChange(field.key, v)}
              description={field.description}
              error={error}
            />
          );
        }

        // text, textarea, number, integer, enum, and format-based fields → FormField
        const formType = toHtmlInputType(field) as FormFieldType;
        const v = field.validation;

        return (
          <FormField
            key={field.key}
            id={id}
            label={field.label}
            required={field.required}
            type={formType}
            value={String(values[field.key] ?? "")}
            onChange={(val) => onChange(field.key, val)}
            placeholder={field.placeholder}
            description={field.description}
            enumValues={field.enumValues}
            error={error}
            min={field.effectiveMin}
            max={field.effectiveMax}
            minLength={v?.minLength}
            maxLength={v?.maxLength}
            pattern={v?.pattern}
            step={
              field.type === "integer"
                ? (field.step ?? 1)
                : (field.step ?? (field.type === "number" ? "any" : undefined))
            }
          />
        );
      })}
    </>
  );
}
