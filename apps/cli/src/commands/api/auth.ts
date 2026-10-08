// SPDX-License-Identifier: Apache-2.0

import { readConfig, resolveProfileName } from "../../lib/config.ts";
import {
  resolveAuthContext,
  resolveApiKeyAuthContext,
  explicitApiKey,
  AuthError,
  ApiError,
} from "../../lib/api.ts";
import type { ApiCommandOptions } from "./types.ts";

type AuthContext = Awaited<ReturnType<typeof resolveAuthContext>>;

/**
 * The credential an `appstrate api` call sends: an explicit API key (`profileName`
 * stays undefined), else the auth profile with a fresh access token. Returns the
 * message to print when neither resolves.
 */
export async function resolveApiAuth(
  opts: Pick<ApiCommandOptions, "apiKey" | "profile">,
): Promise<{ auth: AuthContext; profileName: string | undefined } | { error: string }> {
  try {
    const apiKey = explicitApiKey(opts.apiKey);
    if (apiKey) {
      return { auth: await resolveApiKeyAuthContext(apiKey, opts.profile), profileName: undefined };
    }
    const profileName = resolveProfileName(opts.profile, await readConfig());
    return { auth: await resolveAuthContext(profileName), profileName };
  } catch (err) {
    if (err instanceof AuthError || err instanceof ApiError) return { error: err.message };
    throw err;
  }
}
