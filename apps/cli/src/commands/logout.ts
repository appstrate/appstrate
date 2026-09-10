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
import { withSyncLock } from "../lib/skills-sync/lock.ts";
import { cleanupProfileSkills } from "../lib/skills-sync/cleanup.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";

interface LogoutOptions {
  profile?: string;
}

export async function logoutCommand(
  opts: LogoutOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  intro(`Appstrate logout — profile "${profileName}"`, io);

  let hadTokens = false;
  const clearCredentials = async (): Promise<void> => {
    await _awaitRefreshQuiesce(profileName);
    try {
      await deleteTokens(profileName);
    } finally {
      await deleteProfile(profileName);
    }
  };
  let credentialsCleared = false;
  try {
    await withSyncLock(
      async () => {
        try {
          const tokens = await loadTokens(profileName);
          hadTokens = !!tokens;
          const profile = await getProfile(profileName);
          if (tokens && profile) {
            await revokeCliRefreshToken(
              normalizeInstance(profile.instance),
              CLI_CLIENT_ID,
              tokens.refreshToken,
            );
          }
        } catch (err) {
          io.stderr.write(
            `warning: could not revoke refresh token server-side (${formatError(err)}); continuing with local cleanup.\n`,
          );
        } finally {
          await clearCredentials();
          credentialsCleared = true;
        }
        const cleanup = await cleanupProfileSkills(profileName);
        if (cleanup.pluginReset)
          io.stderr.write(
            "Appstrate plugin reset. Run `claude plugin update appstrate@appstrate` and restart Claude, or start a new session with automatic plugin refresh enabled.\n",
          );
        for (const failure of cleanup.warnings)
          io.stderr.write(
            `warning: ${failure}. Retry appstrate logout --profile ${profileName}.\n`,
          );
      },
      { io },
    );
  } catch (err) {
    io.stderr.write(
      `warning: could not complete skills cleanup (${formatError(err)}). Retry appstrate logout --profile ${profileName}.\n`,
    );
  } finally {
    // A lock failure cannot keep the user signed in. An in-flight sync checks
    // its profile again before swapping, so deleting it also cancels stale work.
    if (!credentialsCleared) await clearCredentials();
  }
  outro(hadTokens ? `Signed out of "${profileName}".` : "Already signed out.", io);
}
