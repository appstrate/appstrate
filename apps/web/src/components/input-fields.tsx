// SPDX-License-Identifier: Apache-2.0

import { FormField } from "./form-field";
import { FileField } from "./file-field";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { schemaToFields, type SchemaWrapper } from "@appstrate/core/form";

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
            <div key={field.key} className="space-y-2">
              <Label htmlFor={id}>
                {field.label}
                {field.required ? " *" : ""}
              </Label>
              <Textarea
                id={id}
                value={String(values[field.key] ?? "")}
                onChange={(e) => onChange(field.key, e.target.value)}
                placeholder={field.placeholder}
                rows={6}
                className={cn("font-mono text-xs", error && "border-destructive")}
              />
              {field.description && (
                <p className="text-muted-foreground text-sm">{field.description}</p>
              )}
              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>
          );
        }

        // text, textarea, number, enum → FormField
        const formType =
          field.type === "number" ? "number" : field.type === "textarea" ? "textarea" : "text";

        return (
          <FormField
            key={field.key}
            id={id}
            label={field.label}
            required={field.required}
            type={formType}
            value={String(values[field.key] ?? "")}
            onChange={(v) => onChange(field.key, v)}
            placeholder={field.placeholder}
            description={field.description}
            enumValues={field.enumValues}
            error={error}
          />
        );
      })}
    </>
  );
}
