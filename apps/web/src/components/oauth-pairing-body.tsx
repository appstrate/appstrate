// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing-token UI shared by the unified credential modal when the user
 * selects an OAuth model provider. Mints a one-shot pairing via
 * `POST /api/model-providers-oauth/pairing`, surfaces the `npx
 * @appstrate/connect-helper <token>` command, polls until the helper
 * consumes the token, then notifies the caller via `onConnected`.
 *
 * The pairing is registered in `pairingStore` on mint and is deliberately
 * NOT cancelled on unmount: closing this modal mid-flow (tab switch,
 * accidental dismiss) used to delete the pending token, so a connection
 * completed afterwards was silently dropped. `<PendingPairingsWatcher>`
 * now owns the global success side effects (toast + credential-list
 * invalidation) and polls the pairing to completion regardless of whether
 * this body is still mounted; abandoned tokens are reaped by their TTL.
 * Same for a provider switch (parent re-keys this body): the prior pairing
 * is left for the watcher/TTL rather than cancelled — the user only ran the
 * helper for whichever provider they actually copied the command for.
 *
 * Why an extracted body and not a standalone modal: the credential
 * surface has a single entry point now ("Add credential" → modal →
 * pick provider). The pairing flow renders inside that same shell;
 * keeping it self-contained lets the parent swap bodies without
 * re-mounting the Modal.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import {
  useCreateModelProviderPairing,
  useModelProviderPairingStatus,
} from "../hooks/use-model-provider-pairing";
import { addPendingPairing } from "../stores/pairing-store";
import { getCurrentOrgId } from "../stores/org-store";

interface OAuthPairingBodyProps {
  providerId: string;
  /**
   * Fires once the helper has consumed the pairing token and the platform
   * has persisted the credential. Caller is responsible for closing the
   * surrounding modal.
   */
  onConnected?: (credentialId: string) => void;
  /**
   * Reports whether a pairing is in flight (minted, not yet
   * consumed/expired). Hosts use it to confirm-on-close so an accidental
   * dismiss doesn't drop the visible command mid-connection.
   */
  onBusyChange?: (busy: boolean) => void;
}

export function OAuthPairingBody({ providerId, onConnected, onBusyChange }: OAuthPairingBodyProps) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; command: string } | null>(null);

  const createPairing = useCreateModelProviderPairing();
  const pairingStatus = useModelProviderPairingStatus(pairing?.id ?? null, {
    enabled: !!pairing,
  });

  // Whether this pairing is registered with `<PendingPairingsWatcher>`
  // (needs an org context at mint). When it is, the watcher owns the global
  // success side effects; when it isn't, the watcher never polls it, so this
  // body must fire them itself. `fired` guards single-shot completion.
  const registeredRef = useRef(false);
  const firedRef = useRef(false);

  // Mint as soon as the body mounts. The provider can change while open
  // (parent re-keys this component) — that path drops + re-creates.
  useEffect(() => {
    if (pairing || createPairing.isPending) return;
    void generatePairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notify the parent for in-context behavior (auto-select the new
  // credential, close the modal). The global success side effects — toast
  // and credential-list invalidation — are normally owned by
  // `<PendingPairingsWatcher>` so they fire even when this modal was already
  // closed. If the pairing was NOT registered with the watcher (no org
  // context at mint), the watcher never polls it, so own those side effects
  // here instead. Deferred via queueMicrotask so the parent's
  // setState-on-close doesn't tear into this effect.
  useEffect(() => {
    if (pairingStatus.data?.status !== "consumed") return;
    if (firedRef.current) return;
    firedRef.current = true;
    if (!registeredRef.current) {
      toast.success(t("credentials.oauth.callbackSuccess"));
      void qc.invalidateQueries({ queryKey: ["get", "/api/model-provider-credentials"] });
    }
    const credentialId = pairingStatus.data.credentialId;
    if (credentialId && onConnected) queueMicrotask(() => onConnected(credentialId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingStatus.data?.status, pairingStatus.data?.credentialId]);

  // Report "busy" while a token is minted and still pending — hosts use it
  // to confirm before an accidental dismiss. Ref keeps the latest callback
  // without making it an effect dependency; reset to false on unmount.
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const status = pairingStatus.data?.status;
  const busy = !!pairing && status !== "consumed" && status !== "expired";
  useEffect(() => {
    onBusyChangeRef.current?.(busy);
  }, [busy]);
  useEffect(() => () => onBusyChangeRef.current?.(false), []);

  const isExpired = status === "expired";
  const command = pairing?.command ?? "";

  async function generatePairing() {
    firedRef.current = false;
    registeredRef.current = false;
    try {
      const res = await createPairing.mutateAsync({ body: { providerId } });
      setPairing({ id: res.id, command: res.command });
      // Register so `<PendingPairingsWatcher>` can poll this to completion
      // even if the modal is closed before the helper redeems the token.
      // Only non-secret fields are stored — never the command/token. Without
      // an org context the watcher can't scope the poll, so this body keeps
      // ownership of the success side effects (see the consumed effect).
      const orgId = getCurrentOrgId();
      if (orgId) {
        addPendingPairing({ id: res.id, providerId, expiresAt: res.expiresAt, orgId });
        registeredRef.current = true;
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? getErrorMessage(err) : t("credentials.oauth.pairingCreateFailed"),
      );
    }
  }

  async function handleRegenerate() {
    setPairing(null);
    await generatePairing();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("credentials.oauth.copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{t("credentials.oauth.cliInstructions")}</p>

      {createPairing.isPending || (!pairing && !isExpired) ? (
        <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-md p-3 text-xs">
          <Spinner />
          <span>{t("credentials.oauth.generatingCommand")}</span>
        </div>
      ) : isExpired ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p>{t("credentials.oauth.pairingExpired")}</p>
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
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner />
            <span>{t("credentials.oauth.cliWaiting")}</span>
          </div>
        </>
      )}
    </div>
  );
}
