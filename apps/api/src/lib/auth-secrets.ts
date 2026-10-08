// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";

/** The auth keyring, current secret first: `BETTER_AUTH_SECRETS` values, else `BETTER_AUTH_SECRET`. */
export function authKeyring(): string[] {
  const env = getEnv();
  return env.BETTER_AUTH_SECRETS?.map((s) => s.value) ?? [env.BETTER_AUTH_SECRET];
}
