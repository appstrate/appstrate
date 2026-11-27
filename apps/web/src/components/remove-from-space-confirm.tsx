// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useRemovePackageFromSpace } from "../hooks/use-package-shares";
import { ConfirmModal } from "./confirm-modal";

export interface RemovalTarget {
  packageId: string;
  name: string;
  /** A space id. */
  target: string;
  /** What the dialog calls the target (a space name). */
  targetLabel: string;
}

/** Asks before taking a package out of a space: its settings there go, its schedules stop. */
export function RemoveFromSpaceConfirm({
  removal,
  onClose,
  onRemoved,
}: {
  removal: RemovalTarget | null;
  onClose: () => void;
  /** After the server removed it, once the dialog is closed; passing it means the caller leaves the page. */
  onRemoved?: () => void;
}) {
  const { t } = useTranslation("settings");
  const removing = useRemovePackageFromSpace();
  return (
    <ConfirmModal
      open={removal !== null}
      onClose={onClose}
      title={removal ? t("catalogue.revokeTitle", { space: removal.targetLabel }) : ""}
      description={
        removal
          ? t("catalogue.revokeConfirm", { name: removal.name, space: removal.targetLabel })
          : ""
      }
      confirmLabel={t("catalogue.revokeAction")}
      isPending={removing.isPending}
      onConfirm={() =>
        removal &&
        removing.remove(removal, {
          leavesPage: onRemoved !== undefined,
          onSuccess: () => {
            // The row leaving a list is the answer; only a page that is left needs saying.
            if (onRemoved) toast.success(t("catalogue.revoked", { space: removal.targetLabel }));
            onClose();
            onRemoved?.();
          },
        })
      }
    />
  );
}
