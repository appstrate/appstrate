// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "../modal";
import {
  useConnectIntegrationFields,
  type IntegrationConnection,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";

/**
 * Inline credentials-entry modal for non-OAuth integration auths
 * (api_key / basic / mtls / custom). Extracted from
 * `pages/integration-detail.tsx` so agent-driven connect surfaces can
 * reuse it without navigating to the integration page.
 */

function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties);
  }
  if (auth.type === "api_key") return ["api_key"];
  if (auth.type === "basic") return ["username", "password"];
  // AFPS §7.5 — mtls credential schema SHOULD describe client cert
  // and private key (chain optional). When the manifest omits an
  // explicit `credentials.schema.properties`, fall back to these two
  // canonical fields so the modal still renders input fields.
  if (auth.type === "mtls") return ["client_cert", "client_key"];
  return [];
}

// Fields whose value is multi-line by nature (PEM-encoded cert/key
// blobs, RSA private keys, certificate chains). Detected by name so
// arbitrary manifest-declared properties get the right input affordance
// without each integration having to opt in.
const MULTILINE_FIELD_PATTERN = /cert|certificate|private_key|^key$|_key$/i;

interface FieldsConnectModalProps {
  open: boolean;
  onClose: () => void;
  packageId: string;
  authKey: string;
  auth: IntegrationManifestAuth;
  displayName: string;
  /**
   * Existing connection id to UPDATE in place (renew). Omitted on a fresh
   * connect — the write then INSERTs a new row. Mirrors the OAuth path's
   * `connectionId` so a non-OAuth renew (api_key/PAT/custom) reuses the dead
   * row instead of creating a duplicate.
   */
  connectionId?: string;
  /** Fired with the created connection on a successful connect (before close). */
  onConnected?: (connection: IntegrationConnection) => void;
}

export function FieldsConnectModal({
  open,
  onClose,
  packageId,
  authKey,
  auth,
  displayName,
  connectionId,
  onConnected,
}: FieldsConnectModalProps) {
  const { t } = useTranslation("settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useConnectIntegrationFields();
  const fields = deriveFieldNames(auth);
  const sensitiveKeywords = ["password", "secret", "token", "key"];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      {
        params: { path: { packageId, authKey } },
        body: { credentials: values, ...(connectionId ? { connection_id: connectionId } : {}) },
      },
      {
        onSuccess: (connection) => {
          onConnected?.(connection);
          setValues({});
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("integration.connect.modal.title", { display: displayName })}
    >
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-muted-foreground text-sm">
          {t("integration.connect.modal.subtitle", { type: auth.type })}
        </p>
        {fields.map((field) => {
          const isSensitive = sensitiveKeywords.some((k) => field.toLowerCase().includes(k));
          const isMultiline = MULTILINE_FIELD_PATTERN.test(field);
          // Fallback to the raw field name when no localized label is
          // registered — keeps the modal usable for arbitrary
          // manifest-declared properties without a translation entry.
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
                  onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
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
                  onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                  autoComplete="off"
                  data-testid={`field-input-${field}`}
                />
              )}
            </div>
          );
        })}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("integration.connect.btn.cancel")}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {t("integration.connect.btn.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
