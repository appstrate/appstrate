// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import { isSecretField } from "@appstrate/core/form";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Textarea } from "@appstrate/ui/components/textarea";
import type { IntegrationManifestAuth } from "../../hooks/use-integrations";
import { deriveFieldNames, fieldSchemas } from "./credential-schema";

// Multi-line by nature (PEM certs/keys), detected by name. No generic `*_key` suffix: it would
// also match single-line secrets like `api_key`. Masking is the manifest's to say.
const MULTILINE_FIELD_PATTERN = /cert|private_key|public_key|^(?:client_key|key)$/i;

interface CredentialFieldsProps {
  auth: IntegrationManifestAuth;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function CredentialFields({ auth, values, onChange }: CredentialFieldsProps) {
  const { t } = useTranslation("settings");
  const fields = deriveFieldNames(auth);
  const schemas = fieldSchemas(auth);

  return (
    <>
      {fields.map((field) => {
        const isMultiline = MULTILINE_FIELD_PATTERN.test(field);
        const schema = schemas[field];
        // Localized override, then the manifest's `title`, then the raw name.
        const labelKey = `integration.connect.fields.${field}.label`;
        const labelText = t(labelKey, { defaultValue: schema?.title ?? field });
        const description = schema?.description;
        // Defaults reach the input through `initialCredentialValues`, which also submits them.
        const value = values[field] ?? "";
        return (
          <div key={field} className="space-y-1">
            <Label
              htmlFor={`field-${field}`}
              className={labelText === field ? "font-mono text-xs" : "text-xs"}
            >
              {labelText}
            </Label>
            {isMultiline ? (
              <Textarea
                id={`field-${field}`}
                value={value}
                onChange={(e) => onChange({ ...values, [field]: e.target.value })}
                autoComplete="off"
                rows={6}
                className="font-mono text-xs"
                data-testid={`field-input-${field}`}
              />
            ) : (
              <Input
                id={`field-${field}`}
                type={schema && isSecretField(schema) ? "password" : "text"}
                value={value}
                onChange={(e) => onChange({ ...values, [field]: e.target.value })}
                autoComplete="off"
                data-testid={`field-input-${field}`}
              />
            )}
            {description && (
              <p
                className="text-muted-foreground text-xs leading-snug"
                data-testid={`field-description-${field}`}
              >
                {description}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
