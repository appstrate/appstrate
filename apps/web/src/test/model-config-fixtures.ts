// SPDX-License-Identifier: Apache-2.0

import type { ModelConfigInfo } from "../hooks/use-model-configs.ts";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials.ts";

const CREATED = "2026-11-01T10:00:00.000Z";

/** A complete `ModelConfig`: Anthropic's, served by an organization key, open to members. */
export function modelConfigFixture(overrides: Partial<ModelConfigInfo> = {}): ModelConfigInfo {
  return {
    id: "cfg_1",
    provider_id: "anthropic",
    provider_name: "Anthropic",
    label: "Anthropic",
    base_url: null,
    personal_connections_allowed: true,
    accepts: [
      { provider_id: "anthropic", display_name: "Anthropic", auth_mode: "api_key" },
      { provider_id: "claude-code", display_name: "Claude Code", auth_mode: "oauth2" },
    ],
    org_connection: "active",
    personal_connection_count: 0,
    model_count: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

/** A complete `ModelProviderCredential`: the organization's API key of `cfg_1`. */
export function connectionFixture(
  overrides: Partial<ModelProviderCredentialInfo> = {},
): ModelProviderCredentialInfo {
  return {
    id: "cred_org",
    label: "Clé équipe",
    apiShape: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    providerId: "anthropic",
    source: "custom",
    authMode: "api_key",
    owner_type: "org",
    owner_id: null,
    owner_name: null,
    created_by: null,
    allowed_actions: ["edit", "delete", "test"],
    config_id: "cfg_1",
    serves_model_ids: [],
    needs_reconnection: false,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}
