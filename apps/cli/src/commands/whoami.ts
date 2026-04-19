// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate whoami` — print the identity attached to the active profile.
 *
 * Calls `GET /api/profile` to verify the stored JWT is still valid AND
 * fetch the authoritative current identity. A revoked or expired token
 * surfaces as `AuthError` with a clear "re-login" message rather than
 * printing stale data read from `config.toml`. The email is read from
 * the server response — the locally-cached `profile.email` (persisted
 * at login from the decoded JWT) is kept on disk only as an offline
 * bootstrap hint and is deliberately NOT what we print, so a dashboard-
 * side email change is reflected on the next `whoami`. We cannot use
 * BA's `/api/auth/get-session` here: that endpoint is handled by BA's
 * own cookie-based session handler and does not know how to resolve
 * the Bearer JWT issued by `/api/auth/cli/token`.
 */

import { readConfig, resolveProfileName } from "../lib/config.ts";
import { apiFetch } from "../lib/api.ts";
import { formatError } from "../lib/ui.ts";

export interface WhoamiOptions {
  profile?: string;
}

interface ProfileResponse {
  id: string;
  displayName: string | null;
  language: string | null;
  email: string | null;
  name: string | null;
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
    const me = await apiFetch<ProfileResponse>(profileName, "/api/profile");

    // Name fallback: `displayName` (profile-owned, dashboard-editable) →
    // `name` (BA-owned `user.name`, set at signup). Both come from the
    // server in the same response so whoami always reflects dashboard
    // state, never the stale copy cached in config.toml.
    const nameLine = me.displayName ?? me.name;
    process.stdout.write(
      [
        `Profile:  ${profileName}`,
        `Instance: ${profile.instance}`,
        me.email ? `User:     ${me.email}` : null,
        nameLine ? `Name:     ${nameLine}` : null,
        profile.orgId ? `Org:      ${profile.orgId}` : null,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}
