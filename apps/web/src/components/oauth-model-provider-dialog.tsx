// SPDX-License-Identifier: Apache-2.0

/**
 * Modal that walks the user through connecting an OAuth model provider.
 *
 * Why a helper, not a browser-only flow:
 *   The public OAuth client_ids baked into the official CLIs only
 *   allowlist `http://localhost:PORT/...` redirect_uris. A platform-hosted
 *   callback is rejected at the provider's authorize step. So instead we
 *   delegate the loopback OAuth dance to the user's terminal via the
 *   `npx @appstrate/connect-helper <token>` one-shot helper.
 *
 * Flow:
 *   On open, the dialog mints a one-shot pairing token via
 *   `POST /api/model-providers-oauth/pairing`, surfaces the resulting
 *   `npx @appstrate/connect-helper <token>` command, and polls the
 *   pairing status until it flips to `consumed` (helper completed +
 *   credentials saved). On modal close we DELETE the pairing so the
 *   token can't be reused.
 *
 * No ToS gate here — OAuth providers are opt-in at the `MODULES` env-var
 * level (operator-controlled at install time). Anything reaching this
 * dialog has already been explicitly enabled.
 *
 * The credential label is picked by the helper (`--label` flag or its own
 * default from `DEFAULT_LABEL[slug]`) — the dashboard never sends one, so
 * there's no label input here.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import {
  useCreateModelProviderPairing,
  useModelProviderPairingStatus,
  useCancelModelProviderPairing,
} from "../hooks/use-model-provider-pairing";

interface Props {
  open: boolean;
  providerId: string;
  onClose: () => void;
  /**
   * Fires once the helper has consumed the pairing token and the platform
   * has persisted the credential. Callers can use this to refresh their
   * credential list and auto-select the freshly-created row.
   */
  onConnected?: () => void;
}

export function OAuthModelProviderDialog({ open, providerId, onClose, onConnected }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<{ id: string; command: string } | null>(null);

  const createPairing = useCreateModelProviderPairing();
  const cancelPairing = useCancelModelProviderPairing();
  const pairingStatus = useModelProviderPairingStatus(pairing?.id ?? null, {
    enabled: open && !!pairing,
  });

  // Cancel pairing on close. We keep this in a ref so the cleanup effect
  // can read the latest pairing without re-running on every state update.
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  const cancelMutateRef = useRef(cancelPairing.mutate);
  cancelMutateRef.current = cancelPairing.mutate;

  function reset() {
    setCopied(false);
    setPairing(null);
  }

  function handleClose() {
    // Best-effort cancellation — DELETE failure is non-fatal (token TTL
    // expires the row regardless). React Query's mutation is fire-and-forget.
    if (pairingRef.current) {
      cancelMutateRef.current(pairingRef.current.id, {
        onError: () => {
          /* swallow — TTL is the safety net */
        },
      });
    }
    reset();
    onClose();
  }

  // When the helper completes + the platform persists the credential, the
  // pairing flips to `consumed`. Surface the success toast, invalidate the
  // model-provider-credentials query so the caller's list refreshes, and
  // close. The pairing row is already consumed server-side — no DELETE
  // needed on success (the cleanup worker reaps it later).
  //
  // The close is deferred via `queueMicrotask` so we don't trigger a
  // setState cascade from within the effect body (handleClose → reset
  // sets two states; the react-hooks rule flags synchronous setState here).
  useEffect(() => {
    if (!open) return;
    if (pairingStatus.data?.status !== "consumed") return;
    toast.success(t("providerKeys.oauth.callbackSuccess"));
    qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    onConnected?.();
    queueMicrotask(handleClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairingStatus.data?.status, open]);

  // Mint the pairing token as soon as the dialog opens — there's no
  // intermediate consent step anymore. Re-fires when reopened after a close.
  useEffect(() => {
    if (!open || pairing || createPairing.isPending) return;
    void generatePairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    <Modal
      open={open}
      onClose={handleClose}
      title={t("providerKeys.oauth.cliStageTitle")}
      actions={
        <Button variant="ghost" onClick={handleClose}>
          {t("providerKeys.oauth.close")}
        </Button>
      }
    >
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
    </Modal>
  );
}
