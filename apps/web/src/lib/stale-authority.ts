// SPDX-License-Identifier: Apache-2.0

/**
 * What a refusal says about the caller's OWN standing, beyond the request it
 * refused. The SPA holds two copies of that standing — the session it believes
 * is alive, and the org/space listings every `can()` gate and the space scope
 * are derived from — and neither is re-read on its own, so a session that
 * expired or a role an admin changed meanwhile would otherwise read as an empty
 * list until the next full reload.
 */

import { queryClient } from "./query-client";
import { orgKeys } from "./query-keys";
import { authStore } from "../stores/auth-store";

/** openapi-react-query key prefix of the space listing; the org one is `orgKeys.all`. */
const SPACE_LIST_KEY = ["get", "/api/spaces"] as const;
const AUTHORITY_PATHS = new Set(["/api/orgs", "/api/spaces"]);

/**
 * At most one re-read per window. The server's problem `code` cannot narrow the
 * trigger — a lost membership, a missing permission and a plain missing row all
 * answer `forbidden` / `not_found` — and a 404 is routine (an unset config, a
 * detail refetched after its delete, every denial under a role preview).
 */
export const AUTHORITY_REREAD_INTERVAL_MS = 10_000;
let lastReread = -Infinity;
let trailingReread: ReturnType<typeof setTimeout> | null = null;

function rereadAuthority(): void {
  const wait = lastReread + AUTHORITY_REREAD_INTERVAL_MS - Date.now();
  if (wait > 0) {
    // A refusal inside the window may be the one that matters: one re-read
    // when it closes, however many arrive.
    trailingReread ??= setTimeout(() => {
      trailingReread = null;
      rereadAuthority();
    }, wait);
    return;
  }
  if (trailingReread) clearTimeout(trailingReread);
  trailingReread = null;
  lastReread = Date.now();
  void queryClient.invalidateQueries({ queryKey: orgKeys.all });
  void queryClient.invalidateQueries({ queryKey: SPACE_LIST_KEY });
}

let onSessionRefused: (() => void) | null = null;

/**
 * The auth seam (`hooks/use-auth.ts`) registers its handler here: it imports
 * the API client, so the client's middleware cannot import it back.
 */
export function setSessionRefusedHandler(handler: () => void): void {
  onSessionRefused = handler;
}

/**
 * What a 401 does while a user is signed in. Better Auth stays the sole
 * authority on whether a session exists: `hasSession` answers `false` only when
 * it says there is none, and `null` when it could not be asked (network, 429,
 * 5xx) — which ends nothing, a session is not revoked on a hiccup. One check at
 * a time: every query on screen fails together.
 */
export function createSessionRefusedHandler(deps: {
  hasSession: () => Promise<boolean | null>;
  endSession: () => Promise<void>;
}): () => void {
  let checking = false;
  return () => {
    if (checking || !authStore.getState().user) return;
    checking = true;
    void deps
      .hasSession()
      .catch(() => null)
      .then(async (alive) => {
        if (alive !== false) return;
        await deps.endSession();
        // The next user must not be shown what this session had loaded.
        queryClient.clear();
      })
      .finally(() => {
        checking = false;
      });
  };
}

/**
 * Response middleware hook. A 401 hands over to the auth seam. A 403 or a 404
 * (the API answers 404 for a space the caller may not enter, so that an id is
 * never confirmed) re-reads the two listings: a role that shrank flips the
 * route gates, a space that is gone is dropped by `useSpaceResolver`, an org
 * that is gone by `useOrg`. The listings themselves are skipped — their own
 * refusal re-reading them would never settle.
 */
export function noteStaleAuthority(request: Request, response: Response): void {
  if (response.status === 401) {
    onSessionRefused?.();
    return;
  }
  if (response.status !== 403 && response.status !== 404) return;
  if (AUTHORITY_PATHS.has(new URL(request.url).pathname)) return;
  rereadAuthority();
}
