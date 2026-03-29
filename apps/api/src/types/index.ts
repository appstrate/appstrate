// Only re-export types actually imported through this path (backend-only consumers).
// All other shared types should be imported directly from "@appstrate/shared-types".
export type { OrgRole } from "@appstrate/shared-types";

// --- Flow Manifest Types ---
// Re-exported from @appstrate/validation. The FlowManifest type is Zod-inferred
// and covers all flow manifest fields (name, version, type, dependencies, input/output/config, timeout).

import type { FlowManifest } from "@appstrate/core/validation";
export type { FlowManifest };

import type { ToolMeta } from "../services/adapters/types.ts";
export type { ToolMeta };

export interface FlowProviderRequirement {
  id: string;
  description?: string;
  scopes?: string[];
}

/**
 * Resolved profile entry for a provider — carries both the profile ID and how it was resolved.
 *
 * Resolution order (highest priority first):
 * 1. Org profile binding (`source: "org_binding"`) — admin-configured via org_profile_provider_bindings
 * 2. Per-provider user override (`source: "user_profile"`) — user-selected via user_flow_provider_profiles
 * 3. Default user profile (`source: "user_profile"`) — actor's default connection profile
 */
export interface ProviderProfileEntry {
  profileId: string;
  source: "org_binding" | "user_profile";
}

/** Map of providerId → resolved profile entry. Built by resolveProviderProfiles(). */
export type ProviderProfileMap = Record<string, ProviderProfileEntry>;

// --- Loaded Package (manifest + prompt from DB) ---

export interface LoadedPackage {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  skills: ToolMeta[];
  tools: ToolMeta[];
  source: "system" | "local";
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    endUser?: { id: string; applicationId: string; name?: string | null; email?: string | null };
    flow: LoadedPackage;
    orgId: string;
    orgSlug: string;
    orgRole: import("@appstrate/shared-types").OrgRole;
    authMethod?: "session" | "api_key";
    apiKeyId?: string;
    applicationId?: string;
    requestId: string;
    apiVersion: string;
  };
};
