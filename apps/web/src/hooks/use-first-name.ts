// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "./use-auth";

/**
 * The caller's first name, for a greeting — the dashboard's and the chat's are
 * one sentence, so they read the name from one place. The profile's display
 * name wins over the account name; an email address (the account fallback when
 * no name was given) is not a name, so it yields none.
 */
export function useFirstName(): string {
  const { profile, user } = useAuth();
  const token = (profile?.displayName || user?.name || "").trim().split(/\s+/)[0] ?? "";
  return token.includes("@") ? "" : token;
}
