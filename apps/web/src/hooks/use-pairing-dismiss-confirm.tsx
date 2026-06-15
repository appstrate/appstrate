// SPDX-License-Identifier: Apache-2.0

/**
 * Guards an OAuth-pairing modal against accidental dismissal while a
 * connection is in progress. Wraps the host's real close handler: if the
 * pairing body reports it is busy (a token has been minted and is still
 * pending), a close attempt opens a confirmation instead of closing.
 *
 * The connection is NOT lost either way — `<PendingPairingsWatcher>`
 * completes it in the background — so this is purely UX (don't make the
 * user re-open the flow and re-copy the command after a stray click). The
 * confirmation copy says as much.
 *
 * Usage in a host that renders an `<OAuthPairingBody>` inside a `<Modal>`:
 *
 *   const dismiss = usePairingDismissConfirm(() => setOpen(false));
 *   <Modal onClose={dismiss.requestClose} ...>
 *     <OAuthPairingBody onBusyChange={dismiss.onBusyChange} ... />
 *   </Modal>
 *   {dismiss.confirmDialog}
 */

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmModal } from "../components/confirm-modal";

export interface PairingDismissConfirm {
  /** Pass to `<OAuthPairingBody onBusyChange>`. */
  onBusyChange: (busy: boolean) => void;
  /** Wire to the host `<Modal onClose>` and any explicit close button. */
  requestClose: () => void;
  /** Render somewhere in the host tree. */
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
