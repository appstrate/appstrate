// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS manifest Zod schemas, re-exported from the canonical spec package.
 *
 * The `@afps-spec/schema` package owns the manifest shape; the runtime
 * does not redefine it. Re-exports here exist so consumers of
 * `@appstrate/afps-runtime` do not need a direct dependency on the spec
 * package for common manifest validation.
 *
 * Upstream: https://github.com/appstrate/afps-spec
 */

export {
  agentManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  providerManifestSchema,
  providerDefinition,
  providerConfiguration,
  authModeEnum,
  createSchemas,
} from "@afps-spec/schema";

import type { z } from "zod";
import {
  agentManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  providerManifestSchema,
} from "@afps-spec/schema";

/**
 * TypeScript types inferred from the AFPS v1 manifest schemas.
 */
export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
