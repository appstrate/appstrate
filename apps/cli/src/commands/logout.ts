// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate logout` — revoke the active refresh-token family + wipe
 * local storage.
 *
 * The CLI stores a rotating refresh token (30 d) + a short-lived JWT
 * access token (15 min). The correct server-side revocation target is
 * the refresh-token FAMILY — calling `/cli/revoke` with the refresh
 * token invalidates every rotation in the lineage (RFC 6819 §5.2.2.3
 * shape) so a leaked-but-not-yet-rotated copy is also killed. Local
 * cleanup follows regardless of the server response so the CLI returns
 * to a clean state even when the instance is unreachable.
 */

import { intro, outro, formatError } from "../lib/ui.ts";
import { readConfig, resolveProfileName, deleteProfile } from "../lib/config.ts";
import { loadTokens, deleteTokens } from "../lib/keyring.ts";
import { _awaitRefreshQuiesce } from "../lib/api.ts";
import { revokeCliRefreshToken } from "../lib/device-flow.ts";
import { normalizeInstance } from "../lib/instance-url.ts";
import { getProfile } from "../lib/config.ts";
import { CLI_CLIENT_ID } from "../lib/cli-client.ts";

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

  // Hit `/cli/revoke` so the entire refresh-token family dies
  // server-side.
  try {
    const profile = await getProfile(profileName);
    if (profile) {
      await revokeCliRefreshToken(
        normalizeInstance(profile.instance),
        CLI_CLIENT_ID,
        tokens.refreshToken,
      );
    }
  } catch (err) {
    // Non-fatal: the refresh-token family may already be revoked on
    // the server (reuse detection, or a prior partial logout). The
    // local wipe below returns us to a consistent clean state.
    process.stderr.write(
      `warning: could not revoke refresh token server-side (${formatError(err)}); continuing with local cleanup.\n`,
    );
  }

  // If a parallel apiFetchRaw is mid-rotation right now, its trailing
  // `saveTokens` would otherwise write fresh credentials back to disk
  // AFTER our deleteTokens ran. Wait for the refresh to settle — the
  // server-side revoke above means that rotation will fail with
  // `invalid_grant` anyway and wipe local state, but we still sequence
  // our final delete last so the on-disk end state is deterministic.
  await _awaitRefreshQuiesce(profileName);

  await deleteTokens(profileName);
  await deleteProfile(profileName);

  outro(`Signed out of "${profileName}".`);
}
