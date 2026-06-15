// SPDX-License-Identifier: Apache-2.0

/**
 * Session-level watcher that drives OAuth model-provider pairings to
 * completion even when the modal that started them has been closed.
 *
 * The pairing modal (`OAuthPairingBody`) registers the pairing in
 * `pairingStore` on mint and no longer cancels it on unmount — so closing
 * the modal mid-flow (tab switch, accidental dismiss) no longer kills the
 * token. This component, mounted once for all authenticated routes, polls
 * each pending pairing and fires the global success side effects (toast +
 * credential-list invalidation) the moment the helper consumes the token,
 * then drops it from the store. The TTL is the backstop for abandoned ones.
 *
 * Polling is scoped to the active org: the status route 404s cross-tenant
 * reads, so a pairing minted in another org resumes only once the user
 * switches back to it (still within its TTL).
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useModelProviderPairingStatus } from "../hooks/use-model-provider-pairing";
import { useCurrentOrgId } from "../hooks/use-org";
import {
  pairingStore,
  usePendingPairings,
  removePendingPairing,
  type PendingPairing,
} from "../stores/pairing-store";

/** Polls a single pairing; renders nothing. */
function PairingPoll({ pairing }: { pairing: PendingPairing }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const status = useModelProviderPairingStatus(pairing.id, { enabled: true });

  useEffect(() => {
    const s = status.data?.status;
    if (s === "consumed") {
      toast.success(t("credentials.oauth.callbackSuccess"));
      void qc.invalidateQueries({ queryKey: ["get", "/api/model-provider-credentials"] });
      removePendingPairing(pairing.id);
    } else if (s === "expired") {
      removePendingPairing(pairing.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.status]);

  return null;
}

export function PendingPairingsWatcher() {
  const pairings = usePendingPairings();
  const currentOrgId = useCurrentOrgId();

  // Drop time-expired pairings periodically so the poller list stays bounded
  // even when a tab is backgrounded across several TTLs.
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
