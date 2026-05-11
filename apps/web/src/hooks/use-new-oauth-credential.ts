// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import { useModelProviderCredentials } from "./use-model-provider-credentials";

/**
 * Resolve the credential id minted by a fresh OAuth pairing.
 *
 * `OAuthModelProviderDialog.onConnected` fires after the helper consumes the
 * pairing token, but the pairing-status response does not carry the resulting
 * `model_provider_credentials.id`. Callers diff the credential list against a
 * pre-OAuth snapshot to find the new row:
 *
 *   const { captureBeforeConnect, findAfterConnect } = useNewOAuthCredential();
 *   // before opening the OAuth dialog
 *   captureBeforeConnect();
 *   // in dialog.onConnected
 *   const newId = await findAfterConnect("codex");
 */
export function useNewOAuthCredential() {
  const credentialsQuery = useModelProviderCredentials();
  const snapshotRef = useRef<Set<string>>(new Set());

  const captureBeforeConnect = () => {
    snapshotRef.current = new Set((credentialsQuery.data ?? []).map((k) => k.id));
  };

  const findAfterConnect = async (providerId: string): Promise<string | null> => {
    const refreshed = await credentialsQuery.refetch();
    const candidates = (refreshed.data ?? []).filter(
      (k) =>
        !snapshotRef.current.has(k.id) && k.authMode === "oauth2" && k.providerId === providerId,
    );
    if (candidates.length === 0) return null;
    // Newest first — the import route always inserts, never upserts.
    const sorted = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted[0]?.id ?? null;
  };

  return { captureBeforeConnect, findAfterConnect };
}
