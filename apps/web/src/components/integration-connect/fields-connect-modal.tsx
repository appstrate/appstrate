// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "../modal";
import {
  useConnectIntegrationFields,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";

/**
 * Inline credentials-entry modal for non-OAuth integration auths
 * (api_key / basic / custom). Extracted from `pages/integration-detail.tsx`
 * so agent-driven connect surfaces can reuse it without navigating to
 * the integration page.
 */

export function deriveFieldNames(auth: IntegrationManifestAuth): string[] {
  const schema = auth.credentials?.schema as { properties?: Record<string, unknown> } | undefined;
  if (schema?.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties);
  }
  if (auth.type === "api_key") return ["api_key"];
  if (auth.type === "basic") return ["username", "password"];
  return [];
}

interface FieldsConnectModalProps {
  open: boolean;
  onClose: () => void;
  packageId: string;
  authKey: string;
  auth: IntegrationManifestAuth;
  displayName: string;
}

export function FieldsConnectModal({
  open,
  onClose,
  packageId,
  authKey,
  auth,
  displayName,
}: FieldsConnectModalProps) {
  const { t } = useTranslation("settings");
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useConnectIntegrationFields();
  const fields = deriveFieldNames(auth);
  const sensitiveKeywords = ["password", "secret", "token", "key"];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      { packageId, authKey, credentials: values },
      {
        onSuccess: () => {
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
          return (
            <div key={field} className="space-y-1">
              <Label htmlFor={`field-${field}`} className="font-mono text-xs">
                {field}
              </Label>
              <Input
                id={`field-${field}`}
                type={isSensitive ? "password" : "text"}
                value={values[field] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                autoComplete="off"
                data-testid={`field-input-${field}`}
              />
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
