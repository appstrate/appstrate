// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CONNECT_POPUP_FEATURES,
  connectPopupName,
  listenConnectCompletion,
} from "@appstrate/core/connect-handshake";
import { ApiError } from "../../api/errors";
import { toastError } from "../../lib/mutation-error";
import {
  invalidateIntegrationQueries,
  useInitiateIntegrationConnect,
} from "../../hooks/use-integrations";

const CONNECT_POPUP_TIMEOUT_MS = 5 * 60_000;
const POPUP_POLL_INTERVAL_MS = 500;

/**
 * Hosted-connect-portal flow via popup, auth-type-agnostic (the server dispatches `connect_url`).
 * On reconnect/upgrade (`connectionId`) the backend unions scopes with the granted set.
 * Completion is event-driven (`appstrate:integration_connection`), or popup close (cancel
 * fallback); a success never closes the popup (an SSH install block stays until dismissed).
 * `openPopup` resolves `true` once caches are invalidated, `false` after a failure it toasted.
 */
export function useHostedConnectPopup() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const initiateConnect = useInitiateIntegrationConnect();

  const openPopup = useCallback(
    async (input: {
      packageId: string;
      authKey: string;
      scopes?: string[];
      forceAccountSelect?: boolean;
      connectionId?: string;
    }): Promise<boolean> => {
      try {
        // Synchronous: some browsers block popups opened in async callbacks.
        const popup = window.open("", connectPopupName(input.packageId), CONNECT_POPUP_FEATURES);
        if (!popup) {
          throw new Error("popup_blocked");
        }
        let scopesDenied: string[];
        try {
          const session = await initiateConnect.mutateAsync({
            params: { path: { packageId: input.packageId, authKey: input.authKey } },
            body: {
              scopes: input.scopes ?? [],
              ...(input.forceAccountSelect ? { force_account_select: true } : {}),
              ...(input.connectionId ? { connection_id: input.connectionId } : {}),
            },
          });
          popup.location.href = session.connect_url;
          scopesDenied = await new Promise<string[]>((resolve, reject) => {
            const cleanup = () => {
              clearInterval(poll);
              clearTimeout(timer);
              stopListening();
            };
            // Both carriers fan out to every listener: filter by package. Success only; an
            // `ok: false` completion is settled by the popup-close poll below.
            const stopListening = listenConnectCompletion(
              { packageId: input.packageId },
              (completion) => {
                if (completion.ok !== true) return;
                cleanup();
                resolve(completion.scopesDenied ?? []);
              },
              window,
            );
            const timer = setTimeout(() => {
              cleanup();
              try {
                popup.close();
              } catch {
                /* ignore */
              }
              reject(new Error("connect_timeout"));
            }, CONNECT_POPUP_TIMEOUT_MS);
            // Close-without-signal = user cancel.
            const poll = setInterval(() => {
              if (popup.closed) {
                cleanup();
                resolve([]);
              }
            }, POPUP_POLL_INTERVAL_MS);
          });
        } catch (err) {
          try {
            popup.close();
          } catch {
            /* ignore */
          }
          throw err;
        }
        await invalidateIntegrationQueries(qc);
        if (scopesDenied.length > 0) {
          toast.warning(t("integration.popup.scopesDenied", { scopes: scopesDenied.join(", ") }));
        }
        return true;
      } catch (err) {
        if (err instanceof Error && err.message === "popup_blocked") {
          toast.error(t("integration.popup.blocked"));
          return false;
        }
        if (err instanceof Error && err.message === "connect_timeout") {
          toast.error(t("integration.popup.timeout"));
          return false;
        }
        // The space's admin gate: retrying cannot help, so the reason is the message.
        if (err instanceof ApiError && err.code === "connection_blocked_by_admin") {
          toastError(err);
          return false;
        }
        // Callers never handle a rejected openPopup().
        toast.error(t("integration.popup.failed"));
        return false;
      }
    },
    [initiateConnect, qc, t],
  );

  return { openPopup, isPending: initiateConnect.isPending };
}
