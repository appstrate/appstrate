// SPDX-License-Identifier: Apache-2.0

/** Temporary exact-org allowlist for routing API-key chat models to Pi. */
export const PI_CHAT_ENGINE_ORG_IDS_ENV = "CHAT_PI_ENGINE_ORG_IDS";

export type SelectedChatEngine = "ai-sdk" | "pi";

/**
 * OAuth subscriptions already run on Pi. API-key models move only for an exact
 * organization id in the temporary allowlist. A wildcard is intentionally not
 * supported, so this guard cannot become a general migration by accident.
 */
export function selectChatEngine(input: {
  orgId: string;
  subscription: boolean;
  configuredOrgIds?: string;
}): SelectedChatEngine {
  if (input.subscription) return "pi";
  const orgIds = (input.configuredOrgIds ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "*");
  return orgIds.includes(input.orgId) ? "pi" : "ai-sdk";
}
