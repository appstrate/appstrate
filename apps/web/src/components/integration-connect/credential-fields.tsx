// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Textarea } from "@appstrate/ui/components/textarea";
import type { IntegrationManifestAuth } from "../../hooks/use-integrations";

/**
 * Presentational credential-field renderer for non-OAuth integration auths
 * (api_key / basic / mtls / custom). Rendered by the standalone hosted connect
 * page (issue #769) — the single credential-entry surface, so there is exactly
 * ONE credential renderer with no per-surface drift.
 */

/** Derive the credential field names from an auth manifest. */
function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties);
  }
  if (auth.type === "api_key") return ["api_key"];
  if (auth.type === "basic") return ["username", "password"];
  // AFPS §7.5 — mtls credential schema SHOULD describe a client cert and
  // private key (chain optional). When the manifest omits explicit
  // `credentials.schema.properties`, fall back to the two canonical fields so
  // the form still renders inputs.
  if (auth.type === "mtls") return ["client_cert", "client_key"];
  return [];
}

// Fields whose value is multi-line by nature (PEM-encoded cert/key blobs, RSA
// private keys, certificate chains). Detected by name so arbitrary
// manifest-declared properties get the right input affordance without each
// integration opting in.
const MULTILINE_FIELD_PATTERN = /cert|certificate|private_key|^key$|_key$/i;

const SENSITIVE_KEYWORDS = ["password", "secret", "token", "key"];

interface CredentialFieldsProps {
  auth: IntegrationManifestAuth;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function CredentialFields({ auth, values, onChange }: CredentialFieldsProps) {
  const { t } = useTranslation("settings");
  const fields = deriveFieldNames(auth);

  return (
    <>
      {fields.map((field) => {
        const isSensitive = SENSITIVE_KEYWORDS.some((k) => field.toLowerCase().includes(k));
        const isMultiline = MULTILINE_FIELD_PATTERN.test(field);
        // Fall back to the raw field name when no localized label is
        // registered — keeps the form usable for arbitrary manifest-declared
        // properties without a translation entry.
        const labelKey = `integration.connect.fields.${field}.label`;
        const labelText = t(labelKey, { defaultValue: field });
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
                value={values[field] ?? ""}
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
                value={values[field] ?? ""}
                onChange={(e) => onChange({ ...values, [field]: e.target.value })}
                autoComplete="off"
                data-testid={`field-input-${field}`}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
