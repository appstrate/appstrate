// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing-token UI shared by the unified credential modal when the user
 * selects an OAuth model provider. Mints a one-shot pairing via
 * `POST /api/model-providers-oauth/pairing`, surfaces the `npx
 * @appstrate/connect-helper <token>` command, polls until the helper
 * consumes the token, then notifies the caller via `onConnected`.
 *
 * On unmount (modal close, provider change, etc.) the host calls
 * `cancelPairing` via the returned imperative handle so the token can't
 * be reused — TTL is the safety net regardless.
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
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import {
  useCreateModelProviderPairing,
  useModelProviderPairingStatus,
  useCancelModelProviderPairing,
} from "../hooks/use-model-provider-pairing";

interface OAuthPairingBodyProps {
  providerId: string;
  /**
   * Fires once the helper has consumed the pairing token and the platform
   * has persisted the credential. Caller is responsible for closing the
   * surrounding modal.
   */
  onConnected?: (credentialId: string) => void;
}

export function OAuthPairingBody({ providerId, onConnected }: OAuthPairingBodyProps) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; command: string } | null>(null);

  const createPairing = useCreateModelProviderPairing();
  const cancelPairing = useCancelModelProviderPairing();
  const pairingStatus = useModelProviderPairingStatus(pairing?.id ?? null, {
    enabled: !!pairing,
  });

  // Cancel pairing on unmount. Refs so cleanup reads the latest pairing
  // and mutation without re-running on every state update.
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  const cancelMutateRef = useRef(cancelPairing.mutate);
  cancelMutateRef.current = cancelPairing.mutate;

  useEffect(() => {
    return () => {
      const current = pairingRef.current;
      if (!current) return;
      // Best-effort — TTL eventually reaps the row.
      cancelMutateRef.current(current.id, { onError: () => {} });
    };
  }, []);

  // Mint as soon as the body mounts. The provider can change while open
  // (parent re-keys this component) — that path drops + re-creates.
  useEffect(() => {
    if (pairing || createPairing.isPending) return;
    void generatePairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface success exactly once: invalidate the credential list and
  // notify the parent. Deferred via queueMicrotask so the parent's
  // setState-on-close doesn't tear into this effect.
  useEffect(() => {
    if (pairingStatus.data?.status !== "consumed") return;
    toast.success(t("providerKeys.oauth.callbackSuccess"));
    qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    const credentialId = pairingStatus.data.credentialId;
    if (credentialId && onConnected) queueMicrotask(() => onConnected(credentialId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingStatus.data?.status, pairingStatus.data?.credentialId]);

  const isExpired = pairingStatus.data?.status === "expired";
  const command = pairing?.command ?? "";

  async function generatePairing() {
    try {
      const res = await createPairing.mutateAsync({ providerId });
      setPairing({ id: res.id, command: res.command });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("providerKeys.oauth.pairingCreateFailed"));
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
      toast.error(t("providerKeys.oauth.copyFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{t("providerKeys.oauth.cliInstructions")}</p>

      {createPairing.isPending || (!pairing && !isExpired) ? (
        <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-md p-3 text-xs">
          <Spinner />
          <span>{t("providerKeys.oauth.generatingCommand")}</span>
        </div>
      ) : isExpired ? (
        <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p>{t("providerKeys.oauth.pairingExpired")}</p>
          <Button type="button" variant="outline" size="sm" onClick={handleRegenerate}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t("providerKeys.oauth.regenerateCommand")}
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
              aria-label={t("providerKeys.oauth.copyCommand")}
              className="shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1.5">
                {copied ? t("providerKeys.oauth.copied") : t("providerKeys.oauth.copy")}
              </span>
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">{t("providerKeys.oauth.cliHint")}</p>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner />
            <span>{t("providerKeys.oauth.cliWaiting")}</span>
          </div>
        </>
      )}
    </div>
  );
}
