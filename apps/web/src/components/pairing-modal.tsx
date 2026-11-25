// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { usePairingDismissConfirm } from "../hooks/use-pairing-dismiss-confirm";
import type { PairingTarget } from "../lib/oauth-pairing";
import { Modal } from "./modal";
import { OAuthPairingBody } from "./oauth-pairing-body";

/**
 * The OAuth pairing in its modal: closing it while a pairing is in flight asks
 * first. `children` sits above the pairing body.
 */
export function PairingModal({
  title,
  onClose,
  providerId,
  target,
  onConnected,
  children,
}: {
  title: string;
  onClose: () => void;
  providerId: string;
  target: PairingTarget;
  onConnected: (credentialId: string) => void;
  children?: ReactNode;
}) {
  const dismiss = usePairingDismissConfirm(onClose);
  return (
    <>
      <Modal onClose={dismiss.requestClose} title={title}>
        <div className="flex flex-col gap-4">
          {children}
          <OAuthPairingBody
            key={providerId}
            providerId={providerId}
            target={target}
            onConnected={onConnected}
            onBusyChange={dismiss.onBusyChange}
          />
        </div>
      </Modal>
      {dismiss.confirmDialog}
    </>
  );
}
