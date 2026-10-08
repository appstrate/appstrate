// SPDX-License-Identifier: Apache-2.0
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import type { VariableField } from "./connection-variables-schema";

/**
 * The connection variables (AFPS §7.12) of the hosted connect form: the
 * non-secret values choosing where the connection points (e.g. an instance
 * URL), rendered above the credential fields. Controlled by the caller, like
 * `<CredentialFields>`; every variable is required, the server validates the
 * value itself.
 */

interface VariableFieldsProps {
  fields: VariableField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** Per-variable refusal, already a sentence, shown under its input. */
  errors: Record<string, string>;
}

export function VariableFields({ fields, values, onChange, errors }: VariableFieldsProps) {
  return (
    <>
      {fields.map((field) => {
        const id = `variable-${field.name}`;
        const error = errors[field.name];
        const describedBy = [
          field.description ? `${id}-description` : null,
          error ? `${id}-error` : null,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={field.name} className="space-y-1">
            <Label htmlFor={id} className={field.title ? "text-xs" : "font-mono text-xs"}>
              {field.title ?? field.name}
            </Label>
            <Input
              id={id}
              type="text"
              inputMode={field.format === "uri" ? "url" : undefined}
              required
              value={values[field.name] ?? ""}
              onChange={(e) => onChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy || undefined}
              data-testid={`variable-input-${field.name}`}
            />
            {field.description && (
              <p
                id={`${id}-description`}
                className="text-muted-foreground text-xs leading-snug"
                data-testid={`variable-description-${field.name}`}
              >
                {field.description}
              </p>
            )}
            {error && (
              <p
                id={`${id}-error`}
                className="text-xs text-red-400"
                data-testid={`variable-error-${field.name}`}
              >
                {error}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
