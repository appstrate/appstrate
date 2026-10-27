// SPDX-License-Identifier: Apache-2.0

/**
 * Session-level watcher that drives OAuth model-provider pairings to
 * completion even when the modal that started them has been closed.
 *
 * The pairing modal (`OAuthPairingBody`) registers the pairing in
 * `pairingStore` on mint and does not cancel it on unmount — so closing
 * the modal mid-flow (tab switch, accidental dismiss) does not kill the
 * token. This component, mounted once for all authenticated routes, polls
 * each pending pairing and fires the global side effects — the success toast
 * and credential/model-list invalidation once the redeem produces a credential,
 * the failure toast when it is refused, unless a modal shows that pairing and
 * states it inline — then drops it from the store.
 *
 * Polling is scoped to the active org: the status route 404s cross-tenant
 * reads, so a pairing minted in another org resumes only once the user
 * switches back to it.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateCredentialsAndModels } from "../hooks/use-model-provider-credentials";
import { useModelProviderPairingStatus } from "../hooks/use-model-provider-pairing";
import { useCurrentOrgId } from "../hooks/use-org";
import {
  pairingStore,
  usePendingPairings,
  removePendingPairing,
  isPairingShown,
  type PendingPairing,
} from "../stores/pairing-store";

/** Polls a single pairing; renders nothing. */
function PairingPoll({ pairing }: { pairing: PendingPairing }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const { state } = useModelProviderPairingStatus(pairing.id);

  useEffect(() => {
    if (state === "pending") return;
    if (state === "connected") {
      toast.success(t("credentials.oauth.callbackSuccess"));
      void invalidateCredentialsAndModels(qc);
    } else if (state === "failed" && !isPairingShown(pairing.id)) {
      toast.error(t("credentials.oauth.pairingFailed"));
    }
    removePendingPairing(pairing.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return null;
}

export function PendingPairingsWatcher() {
  const pairings = usePendingPairings();
  const currentOrgId = useCurrentOrgId();

  useEffect(() => {
    pairingStore.getState().prune();
    const handle = window.setInterval(() => pairingStore.getState().prune(), 30_000);
    return () => window.clearInterval(handle);
  }, []);

  return (
    <>
      {pairings
        .filter((p) => p.orgId === currentOrgId)
        .map((p) => (
          <PairingPoll key={p.id} pairing={p} />
        ))}
    </>
  );
}
