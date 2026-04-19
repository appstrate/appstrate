// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate logout` — revoke the active session + wipe local storage.
 *
 * Calls Better Auth's sign-out endpoint (`POST /api/auth/sign-out`)
 * so the session row is deleted server-side before we forget it
 * locally. A non-200 response is logged but NOT fatal — the local
 * tokens still get wiped so the CLI returns to a clean state even
 * when the instance is unreachable.
 *
 * `/oauth2/revoke` is not used here because the device-flow access
 * token is a BA session, not an oauth-provider-minted token (see
 * preflight PF-3). Revoking via `/api/auth/sign-out` with the session
 * cookie is the correct path.
 */

import { intro, outro, formatError } from "../lib/ui.ts";
import { readConfig, resolveProfileName, deleteProfile } from "../lib/config.ts";
import { loadTokens, deleteTokens } from "../lib/keyring.ts";
import { apiFetchRaw, AuthError } from "../lib/api.ts";

export interface LogoutOptions {
  profile?: string;
}

export async function logoutCommand(opts: LogoutOptions): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  intro(`Appstrate logout — profile "${profileName}"`);

  const tokens = await loadTokens(profileName);
  if (!tokens) {
    // Already logged out — purge any lingering profile metadata and
    // finish cleanly. This path covers recovery after a half-completed
    // login where the config row was written but the keyring entry
    // didn't make it (or vice-versa).
    await deleteProfile(profileName);
    outro("Already signed out.");
    return;
  }

  // Best-effort server-side sign-out. An expired / already-revoked
  // session returns 401; unreachable instances throw. Either way we
  // proceed to the local cleanup below.
  try {
    const res = await apiFetchRaw(profileName, "/api/auth/sign-out", { method: "POST" });
    if (!res.ok && res.status !== 401) {
      process.stderr.write(
        `warning: sign-out returned HTTP ${res.status} (${res.statusText}); continuing with local cleanup.\n`,
      );
    }
  } catch (err) {
    if (!(err instanceof AuthError)) {
      process.stderr.write(
        `warning: could not reach the instance to sign out (${formatError(err)}); continuing with local cleanup.\n`,
      );
    }
  }

  await deleteTokens(profileName);
  await deleteProfile(profileName);

  outro(`Signed out of "${profileName}".`);
}
