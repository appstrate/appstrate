// SPDX-License-Identifier: Apache-2.0

/**
 * Guards an OAuth-pairing modal against accidental dismissal: while the pairing body reports busy
 * (token minted, still pending), a close attempt opens a confirmation. Purely UX — the connection
 * is not lost either way (`<PendingPairingsWatcher>` completes it in the background).
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmModal } from "../components/confirm-modal";

interface PairingDismissConfirm {
  onBusyChange: (busy: boolean) => void;
  /** Wire to the host `<Modal onClose>` and any explicit close button. */
  requestClose: () => void;
  confirmDialog: ReactNode;
}

export function usePairingDismissConfirm(close: () => void): PairingDismissConfirm {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const requestClose = () => {
    if (busy) setConfirmOpen(true);
    else close();
  };

  const confirmDialog = (
    <ConfirmModal
      open={confirmOpen}
      variant="default"
      title={t("credentials.oauth.dismissConfirmTitle")}
      description={t("credentials.oauth.dismissConfirmDescription")}
      confirmLabel={t("credentials.oauth.dismissConfirmConfirm")}
      onClose={() => setConfirmOpen(false)}
      onConfirm={() => {
        setConfirmOpen(false);
        close();
      }}
    />
  );

  return { onBusyChange: setBusy, requestClose, confirmDialog };
}
