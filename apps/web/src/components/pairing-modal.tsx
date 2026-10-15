// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import type { PairingTarget } from "../lib/oauth-pairing";
import { Modal } from "./modal";
import { OAuthPairingBody } from "./oauth-pairing-body";

/**
 * The OAuth pairing in its modal: closing it while a pairing is in flight asks
 * first. `children` sits above the pairing body; `showPairing` off leaves only
 * those (a credential with nothing to re-pair).
 */
export function PairingModal({
  title,
  onClose,
  providerId,
  target,
  onConnected,
  showPairing = true,
  children,
}: {
  title: string;
  onClose: () => void;
  providerId: string;
  target: PairingTarget;
  onConnected: (credentialId: string) => void;
  showPairing?: boolean;
  children?: ReactNode;
}) {
  const dismiss = usePairingDismissConfirm(onClose);
  return (
    <>
      <Modal open onClose={dismiss.requestClose} title={title}>
        <div className="space-y-4">
          {children}
          {showPairing && (
            <OAuthPairingBody
              key={providerId}
              providerId={providerId}
              target={target}
              onConnected={onConnected}
              onBusyChange={dismiss.onBusyChange}
            />
          )}
        </div>
      </Modal>
      {dismiss.confirmDialog}
    </>
  );
}
