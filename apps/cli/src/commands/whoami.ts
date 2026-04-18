// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate whoami` — print the identity attached to the active profile.
 *
 * Pulls the BA session via `GET /api/auth/get-session` so a revoked or
 * expired token surfaces as `AuthError` with a clear "re-login" message
 * rather than printing stale data read from `config.toml`.
 */

import { readConfig, resolveProfileName } from "../lib/config.ts";
import { apiFetch } from "../lib/api.ts";
import { formatError } from "../lib/ui.ts";

export interface WhoamiOptions {
  profile?: string;
}

interface SessionResponse {
  user: {
    id: string;
    email: string;
    name?: string;
  } | null;
  session: {
    id: string;
    expiresAt: string;
  } | null;
}

export async function whoamiCommand(opts: WhoamiOptions): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);
  const profile = config.profiles[profileName];

  if (!profile) {
    process.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    process.exit(1);
  }

  try {
    const session = await apiFetch<SessionResponse | null>(profileName, "/api/auth/get-session");
    if (!session?.user) {
      process.stderr.write(
        `No active session for "${profileName}". Run: appstrate login --profile ${profileName}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(
      [
        `Profile:  ${profileName}`,
        `Instance: ${profile.instance}`,
        `User:     ${session.user.email}`,
        session.user.name ? `Name:     ${session.user.name}` : null,
        profile.orgId ? `Org:      ${profile.orgId}` : null,
        session.session?.expiresAt
          ? `Expires:  ${new Date(session.session.expiresAt).toISOString()}`
          : null,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}
