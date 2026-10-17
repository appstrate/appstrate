// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useRemovePackageFromSpace } from "../hooks/use-package-shares";
import { ConfirmModal } from "./confirm-modal";

export interface RemovalTarget {
  packageId: string;
  name: string;
  spaceId: string;
  spaceName: string;
}

/** Asks before taking a package out of a space: its settings there go, its schedules stop. */
export function RemoveFromSpaceConfirm({
  target,
  onClose,
  onRemoved,
}: {
  target: RemovalTarget | null;
  onClose: () => void;
  /** After the server removed it, once the dialog is closed. */
  onRemoved?: () => void;
}) {
  const { t } = useTranslation("settings");
  const removal = useRemovePackageFromSpace();
  return (
    <ConfirmModal
      open={target !== null}
      onClose={onClose}
      title={target ? t("catalogue.revokeTitle", { space: target.spaceName }) : ""}
      description={
        target ? t("catalogue.revokeConfirm", { name: target.name, space: target.spaceName }) : ""
      }
      confirmLabel={t("catalogue.revokeAction")}
      isPending={removal.isPending}
      onConfirm={() =>
        target &&
        removal.remove(target, {
          onSuccess: () => {
            onClose();
            onRemoved?.();
          },
        })
      }
    />
  );
}
