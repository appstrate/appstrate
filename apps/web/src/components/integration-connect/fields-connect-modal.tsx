// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Modal } from "../modal";
import { CredentialFields } from "./credential-fields";
import {
  useConnectIntegrationFields,
  type IntegrationConnection,
  type IntegrationManifestAuth,
} from "../../hooks/use-integrations";

/**
 * Inline credentials-entry modal for non-OAuth integration auths
 * (api_key / basic / mtls / custom). Extracted from
 * `pages/integration-detail.tsx` so agent-driven connect surfaces can
 * reuse it without navigating to the integration page. The credential field
 * rendering is shared with the standalone hosted connect page via
 * `<CredentialFields>` (one renderer — no drift).
 */
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
        <CredentialFields auth={auth} values={values} onChange={setValues} />
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
