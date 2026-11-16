// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { cn } from "@appstrate/ui/cn";
import { FormItem } from "../app-ui/form-item";
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
        return (
          <FormItem
            key={field.name}
            id={id}
            className={cn("gap-1 [&_label]:text-xs", !field.title && "[&_label]:font-mono")}
            label={field.title ?? field.name}
            hint={
              field.description ? (
                <span className="leading-snug" data-testid={`variable-description-${field.name}`}>
                  {field.description}
                </span>
              ) : undefined
            }
            error={
              error ? <span data-testid={`variable-error-${field.name}`}>{error}</span> : undefined
            }
          >
            <Input
              type="text"
              inputMode={field.format === "uri" ? "url" : undefined}
              required
              readOnly={readOnly}
              value={values[field.name] ?? ""}
              onChange={(e) => onChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              data-testid={`variable-input-${field.name}`}
            />
          </FormItem>
        );
      })}
    </>
  );
}
