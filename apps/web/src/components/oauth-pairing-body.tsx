// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing-token UI the credential modal renders for an OAuth model provider. Closing the modal
 * or switching provider cancels nothing: `<PendingPairingsWatcher>` polls the pairing to its end
 * and owns the global side effects.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw } from "lucide-react";
import { toastError } from "../lib/mutation-error";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import {
  useCreateModelProviderPairing,
  useModelProviderPairingStatus,
} from "../hooks/use-model-provider-pairing";
import { useCurrentOrgId } from "../hooks/use-org";
import { addPendingPairing, markPairingShown, resumablePairing } from "../stores/pairing-store";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { pairingRequestBody, type PairingTarget } from "../lib/oauth-pairing";

interface OAuthPairingBodyProps {
  providerId: string;
  /** A new subscription and its owner, or the existing credential to reconnect. */
  target: PairingTarget;
  /**
   * Fires once the helper has consumed the pairing token and the platform
   * has persisted the credential. Caller is responsible for closing the
   * surrounding modal.
   */
  onConnected?: (credentialId: string) => void;
  /**
   * Reports whether a pairing is in flight (minted, its outcome not
   * yet known). Hosts use it to confirm-on-close so an accidental
   * dismiss doesn't drop the visible command mid-connection.
   */
  onBusyChange?: (busy: boolean) => void;
}

export function OAuthPairingBody(props: OAuthPairingBodyProps) {
  const orgId = useCurrentOrgId();
  if (!orgId) return null;
  return <PairingBody {...props} orgId={orgId} />;
}

function PairingBody({
  providerId,
  target,
  onConnected,
  onBusyChange,
  orgId,
}: OAuthPairingBodyProps & { orgId: string }) {
  const { t } = useTranslation(["settings", "common"]);
  const { copied, copy } = useCopyToClipboard();
  const [pairing, setPairing] = useState(() => resumablePairing({ orgId, providerId, target }));
  const pairingId = pairing?.id ?? null;

  const createPairing = useCreateModelProviderPairing();
  const { state, credentialId } = useModelProviderPairingStatus(pairingId);

  const firedRef = useRef(false);

  useEffect(() => {
    if (pairing || createPairing.isPending) return;
    void generatePairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => (pairingId ? markPairingShown(pairingId) : undefined), [pairingId]);

  // Notify the parent for in-context behavior (auto-select the resulting
  // credential, close the modal). Deferred via queueMicrotask so the parent's
  // setState-on-close doesn't tear into this effect.
  useEffect(() => {
    if (state !== "connected" || !credentialId) return;
    if (firedRef.current) return;
    firedRef.current = true;
    if (onConnected) queueMicrotask(() => onConnected(credentialId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, credentialId]);

  // Report "busy" while a token is minted and its outcome awaited — hosts use it
  // to confirm before an accidental dismiss. Ref keeps the latest callback
  // without making it an effect dependency; reset to false on unmount.
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const busy = !!pairing && state === "pending";
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);

  // A refused redeem ends like an expired token: the command is spent.
  const isSpent = state === "expired" || state === "failed" || state === "lost";
  const command = pairing?.command ?? "";

  async function generatePairing() {
    firedRef.current = false;
    try {
      const res = await createPairing.mutateAsync({
        body: pairingRequestBody({ providerId, ...target }),
      });
      setPairing({ id: res.id, command: res.command });
      addPendingPairing(
        { id: res.id, providerId, target, expiresAt: res.expiresAt, orgId },
        res.command,
      );
    } catch (err) {
      toastError(err);
    }
  }

  async function handleRegenerate() {
    setPairing(null);
    await generatePairing();
  }

  const handleCopy = () => void copy(command);

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{t("credentials.oauth.cliInstructions")}</p>

      {createPairing.isPending || !pairing ? (
        <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-md p-3 text-xs">
          <Spinner />
          <span>{t("credentials.oauth.generatingCommand")}</span>
        </div>
      ) : isSpent ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p>
            {t(
              state === "failed"
                ? "credentials.oauth.pairingFailed"
                : "credentials.oauth.pairingExpired",
            )}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={handleRegenerate}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("credentials.oauth.regenerateCommand")}
          </Button>
        </div>
      ) : (
        <>
          <div className="bg-muted relative flex items-center gap-2 rounded-md p-3 font-mono text-xs">
            <code className="flex-1 break-all whitespace-pre-wrap">{command}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              aria-label={t("credentials.oauth.copyCommand")}
              className="shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1.5">
                {copied ? t("credentials.oauth.copied") : t("credentials.oauth.copy")}
              </span>
            </Button>
          </div>
          <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
            <li>{t("credentials.oauth.cliStepNode")}</li>
            <li>{t("credentials.oauth.cliStepBrowser")}</li>
            <li>{t("credentials.oauth.cliStepKeepOpen")}</li>
          </ul>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner />
            <span>{t("credentials.oauth.cliWaiting")}</span>
          </div>
        </>
      )}
    </div>
  );
}
