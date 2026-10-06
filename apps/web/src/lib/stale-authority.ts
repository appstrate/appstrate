// SPDX-License-Identifier: Apache-2.0

/** What a refusal says about the caller's own standing: its session, and the listings its permissions derive from. */

import { queryClient } from "./query-client";
import { orgKeys } from "./query-keys";
import { authStore } from "../stores/auth-store";

const SPACE_LIST_KEY = ["get", "/api/spaces"] as const;
/** The member list, which displays the roles. */
const ORG_DETAIL_KEY = ["get", "/api/orgs/{orgId}"] as const;
/** The re-read requests: their own refusal re-reading them would never settle. */
const AUTHORITY_READ = /^\/api\/(orgs(\/[^/]+)?|spaces)$/;

/** The problem `code` cannot narrow the trigger and a 404 is routine, hence the window. */
export const AUTHORITY_REREAD_INTERVAL_MS = 10_000;
let lastReread = -Infinity;
let trailingReread: ReturnType<typeof setTimeout> | null = null;

function rereadAuthority(): void {
  const wait = lastReread + AUTHORITY_REREAD_INTERVAL_MS - Date.now();
  if (wait > 0) {
    // A refusal inside the window may be the one that matters.
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
  void queryClient.invalidateQueries({ queryKey: ORG_DETAIL_KEY });
}

let onSessionRefused: (() => void) | null = null;

/**
 * What a 401 does, registered by the auth seam (the client cannot import it
 * back). `hasSession`: `false` when there is none, `null` when it could not be asked.
 */
export function registerSessionCheck(deps: {
  hasSession: () => Promise<boolean | null>;
  endSession: () => Promise<void>;
}): void {
  let checking = false;
  onSessionRefused = () => {
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

/** A 401 checks the session; a 403 or a 404 (a space the caller may not enter) re-reads the listings. */
export function noteStaleAuthority(request: Request, response: Response): void {
  if (response.status === 401) {
    onSessionRefused?.();
    return;
  }
  if (response.status !== 403 && response.status !== 404) return;
  if (request.method === "GET" && AUTHORITY_READ.test(new URL(request.url).pathname)) return;
  rereadAuthority();
}
