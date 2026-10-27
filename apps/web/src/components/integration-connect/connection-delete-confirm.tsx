// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ConfirmModal } from "../confirm-modal";
import { ConnectionDeleteImpact } from "./connection-delete-impact";
import { ConnectionTeardownSteps } from "./connection-teardown-steps";
import {
  useConnectionDeleteImpact,
  useDisconnectIntegrationConnection,
} from "../../hooks/use-me-connections";
import { isQueryInFlight } from "../../lib/query-state";

/**
 * Confirmation of a connection's deletion, the same words on every surface. The blast radius is
 * `ConnectionDeleteImpact`: the caller's own pins and schedules the delete rewrites, and the count
 * of other people's schedules it disables. It is read only while the dialog is open, and the
 * button waits for it.
 */
export function ConnectionDeleteConfirm({
  connectionId,
  name,
  open,
  onClose,
}: {
  connectionId: string;
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const disconnect = useDisconnectIntegrationConnection();
  const deleteImpact = useConnectionDeleteImpact(open ? connectionId : undefined);
  return (
    <ConfirmModal
      open={open}
      onClose={onClose}
      title={t("integration.connection.deleteTitle", { name })}
      description={t("integration.connection.deleteConfirm")}
      confirmLabel={t("btn.delete", { ns: "common" })}
      isPending={disconnect.isPending}
      confirmDisabled={isQueryInFlight(deleteImpact)}
      onConfirm={() =>
        disconnect.mutate({ params: { path: { connectionId } } }, { onSuccess: onClose })
      }
    >
      {open && (
        <>
          <ConnectionDeleteImpact impact={deleteImpact} />
          <ConnectionTeardownSteps connectionId={connectionId} />
        </>
      )}
    </ConfirmModal>
  );
}
