// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate logout` — revoke the active refresh-token family + wipe
 * local storage.
 *
 * Since issue #165 the CLI stores a rotating refresh token (30 d) +
 * a short-lived JWT access token (15 min). The correct server-side
 * revocation target is the refresh-token FAMILY — calling `/cli/revoke`
 * with the refresh token invalidates every rotation in the lineage
 * (RFC 6819 §5.2.2.3 shape) so a leaked-but-not-yet-rotated copy is
 * also killed. Local cleanup follows regardless of the server response
 * so the CLI returns to a clean state even when the instance is
 * unreachable.
 *
 * Backwards compatibility: a legacy 1.x credentials bundle (pre-#165,
 * no `refreshToken`) falls back to the original `/api/auth/sign-out`
 * path so upgrade users can cleanly sign out without first running
 * `appstrate login` on the new flow.
 */

import { intro, outro, formatError } from "../lib/ui.ts";
import { readConfig, resolveProfileName, deleteProfile } from "../lib/config.ts";
import { loadTokens, deleteTokens } from "../lib/keyring.ts";
import { apiFetchRaw, AuthError } from "../lib/api.ts";
import { revokeCliRefreshToken } from "../lib/device-flow.ts";
import { normalizeInstance } from "../lib/instance-url.ts";
import { getProfile } from "../lib/config.ts";

/** Canonical clientId for the official CLI. */
const CLI_CLIENT_ID = "appstrate-cli";

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

  // Issue #165: 2.x CLI with a refresh token → hit `/cli/revoke` so the
  // entire family dies server-side. Fallback to `/api/auth/sign-out`
  // for legacy 1.x credentials so upgrade users aren't stranded.
  if (tokens.refreshToken) {
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
  } else {
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
  }

  await deleteTokens(profileName);
  await deleteProfile(profileName);

  outro(`Signed out of "${profileName}".`);
}
