// Only re-export types actually imported through this path (backend-only consumers).
// All other shared types should be imported directly from "@appstrate/shared-types".
export type { OrgRole } from "@appstrate/shared-types";

// --- Flow Manifest Types ---
// Re-exported from @appstrate/validation. The FlowManifest type is Zod-inferred
// and covers all flow manifest fields (name, version, type, requires, input/output/config, execution).

import type { FlowManifest } from "@appstrate/core/validation";
export type { FlowManifest };

export interface FlowProviderRequirement {
  id: string;
  provider: string;
  description?: string;
  scopes?: string[];
  connectionMode?: "user" | "admin";
}

// --- Loaded Flow (manifest + prompt from DB) ---

export interface SkillMeta {
  id: string;
  version?: string;
  name?: string;
  description?: string;
}

export interface ToolMeta {
  id: string;
  version?: string;
  name?: string;
  description?: string;
}

export interface LoadedFlow {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  skills: SkillMeta[];
  tools: ToolMeta[];
  source: "system" | "local";
}

// Hono context env — shared across all routers
export type AppEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
    flow: LoadedFlow;
    orgId: string;
    orgSlug: string;
    orgRole: import("@appstrate/shared-types").OrgRole;
    authMethod?: "session" | "api_key";
    apiKeyId?: string;
  };
};
