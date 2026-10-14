// SPDX-License-Identifier: Apache-2.0

import type { OrgModelInfo } from "../hooks/use-models.ts";

/**
 * A complete `OrgModel` row — a priced custom model bound to an organization key. Typed, not
 * cast: a required field added to the wire type stops this compiling. Suites override what
 * their case turns on.
 */
export function orgModelFixture(overrides: Partial<OrgModelInfo> = {}): OrgModelInfo {
  return {
    id: "mdl_1",
    label: "Claude Sonnet",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    pi_dialect: null,
    base_url: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-5",
    generation: null,
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    credentialId: "cred_org",
    binding: "org",
    billed_to: "org",
    cost: { input: 3, output: 15 },
    created_by: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}
