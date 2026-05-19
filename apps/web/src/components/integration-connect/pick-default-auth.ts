// SPDX-License-Identifier: Apache-2.0

/**
 * Pick the default authKey to attempt a connection on for a multi-auth
 * integration. Preference: first oauth2, fall back to the first declared
 * auth. Returns null when the integration declares no auths.
 *
 * Shared by the missing-connections modal (412 recovery) and the agent
 * integrations block on the package detail page — both need the same
 * "one-click connect" heuristic when the user hasn't picked an auth yet.
 */
export function pickDefaultAuth(
  auths: Record<string, { type: string }> | undefined,
): string | null {
  if (!auths) return null;
  const keys = Object.keys(auths);
  if (keys.length === 0) return null;
  const oauth = keys.find((k) => auths[k]?.type === "oauth2");
  return oauth ?? keys[0]!;
}
