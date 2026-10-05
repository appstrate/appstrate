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

/** openapi-react-query key prefixes of the two listings that carry the caller's permissions. */
const SPACE_LIST_KEY = ["get", "/api/spaces"] as const;
const AUTHORITY_PATHS = new Set(["/api/orgs", "/api/spaces"]);

let onSessionRefused: (() => void) | null = null;

/**
 * The auth seam (`hooks/use-auth.ts`) registers its resync here: it imports
 * the API client, so the client's middleware cannot import it back.
 */
export function setSessionRefusedHandler(handler: () => void): void {
  onSessionRefused = handler;
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
  // `cancelRefetch: false`: a burst of refusals shares one re-read.
  void queryClient.invalidateQueries({ queryKey: orgKeys.all }, { cancelRefetch: false });
  void queryClient.invalidateQueries({ queryKey: SPACE_LIST_KEY }, { cancelRefetch: false });
}
