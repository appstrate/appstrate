// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import type { VariableField } from "./connection-variables-schema";

/** The hosted connect form's connection variables, controlled like `<CredentialFields>`. */

interface VariableFieldsProps {
  fields: VariableField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  /** Per-variable refusal, already a sentence, shown under its input. */
  errors: Record<string, string>;
  /** A reconnect: the connection stays bound to its instance (AFPS §7.12). */
  readOnly?: boolean;
}

export function VariableFields({
  fields,
  values,
  onChange,
  errors,
  readOnly = false,
}: VariableFieldsProps) {
  const { t } = useTranslation("settings");
  return (
    <>
      {readOnly && fields.length > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="variables-locked-hint">
          {t("integration.connect.variables.locked")}
        </p>
      )}
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
              readOnly={readOnly}
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
