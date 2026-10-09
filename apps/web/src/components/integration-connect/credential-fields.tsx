// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Textarea } from "@appstrate/ui/components/textarea";
import type { IntegrationManifestAuth } from "../../hooks/use-integrations";
import { deriveFieldNames, fieldSchemas } from "./credential-schema";

/**
 * Presentational credential-field renderer for non-OAuth integration auths
 * (api_key / basic / mtls / custom). Rendered by the standalone hosted connect
 * page (issue #769) — the single credential-entry surface, so there is exactly
 * ONE credential renderer with no per-surface drift.
 */

// Fields whose value is multi-line by nature (PEM-encoded certs, private keys,
// certificate chains), detected by name so manifest-declared properties get the
// right affordance. The key names are explicit: a `*_key` suffix also matches
// single-line secrets like `api_key`, which must stay masked.
const MULTILINE_FIELD_PATTERN = /cert|^(?:private_key|client_key|key)$/i;

// Public keys (SSH `host_key`, `*public_key*`) are not secret: never masked.
const PUBLIC_KEY_PATTERN = /^host_key$|public_key/i;

const SENSITIVE_KEYWORDS = ["password", "secret", "token", "key"];

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
        const isPublicKey = PUBLIC_KEY_PATTERN.test(field);
        const isSensitive =
          !isPublicKey && SENSITIVE_KEYWORDS.some((k) => field.toLowerCase().includes(k));
        const isMultiline = MULTILINE_FIELD_PATTERN.test(field);
        const schema = schemas[field];
        // Three sources, most specific first: a localized override, then the
        // manifest's own `title`, then the raw name.
        const labelKey = `integration.connect.fields.${field}.label`;
        const labelText = t(labelKey, { defaultValue: schema?.title ?? field });
        const description = schema?.description;
        // Controlled by the caller alone: a declared default reaches the input
        // through `initialCredentialValues`, which is also what submits it.
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
                type={isSensitive ? "password" : "text"}
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
