// SPDX-License-Identifier: Apache-2.0

// Only re-export types actually imported through this path (backend-only consumers).
// All other shared types should be imported directly from "@appstrate/shared-types".
export type { OrgRole } from "@appstrate/shared-types";
import type { ProviderProfileSource } from "@appstrate/shared-types";
export type { ProviderProfileSource };

// --- Agent Manifest Types ---
// Re-exported from @appstrate/validation. The AgentManifest type is Zod-inferred
// and covers all agent manifest fields (name, version, type, dependencies, input/output/config, timeout).

import type { AgentManifest } from "@appstrate/core/validation";
export type { AgentManifest };

import type { ToolMeta } from "../services/adapters/types.ts";
export type { ToolMeta };

export interface AgentProviderRequirement {
  id: string;
  description?: string;
  scopes?: string[];
}

/**
 * Resolved profile entry for a provider — carries both the profile ID and how it was resolved.
 *
 * Resolution order (highest priority first):
 * 1. App profile binding (`source: "app_binding"`) — admin-configured via app_profile_provider_bindings
 * 2. Per-provider user override (`source: "user_profile"`) — user-selected via user_agent_provider_profiles
 * 3. Default user profile (`source: "user_profile"`) — actor's default connection profile
 */
export interface ProviderProfileEntry {
  profileId: string;
  source: ProviderProfileSource;
}

/** Map of providerId → resolved profile entry. Built by resolveProviderProfiles(). */
export type ProviderProfileMap = Record<string, ProviderProfileEntry>;

// --- Loaded Package (manifest + prompt from DB) ---

export interface LoadedPackage {
  id: string;
  manifest: AgentManifest;
  prompt: string;
  skills: ToolMeta[];
  tools: ToolMeta[];
  source: "system" | "local";
  updatedAt?: Date;
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    endUser?: {
      id: string;
      applicationId: string;
      name: string | null;
      email: string | null;
      role: string;
    };
    agent: LoadedPackage;
    orgId: string;
    orgSlug: string;
    orgRole: import("@appstrate/shared-types").OrgRole;
    permissions?: Set<string>;
    authMethod: "session" | "api_key" | "enduser_token";
    apiKeyId: string | null;
    applicationId: string; // from API key auth or resolved by app-context middleware (X-App-Id)
    requestId: string;
    apiVersion: string;
  };
};
