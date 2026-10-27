// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useRemovePackageFromSpace } from "../hooks/use-package-shares";
import { ConfirmModal } from "./confirm-modal";

export interface RemovalTarget {
  packageId: string;
  name: string;
  /** A `shareTargetHandle`: a space id, or a user id for a person's personal space. */
  target: string;
  /** What the dialog calls the target (a space name, or "l'espace personnel de X"). */
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
            onClose();
            onRemoved?.();
          },
        })
      }
    />
  );
}
