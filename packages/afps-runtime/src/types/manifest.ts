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
  mcpServerManifestSchema,
  integrationManifestSchema,
  createSchemas,
} from "@afps-spec/schema";

import type { z } from "zod";
import {
  agentManifestSchema,
  skillManifestSchema,
  mcpServerManifestSchema,
  integrationManifestSchema,
} from "@afps-spec/schema";

/**
 * TypeScript types inferred from the AFPS 2.0 manifest schemas. The 1.x
 * `tool`/`provider` package types were replaced by `mcp-server` (MCPB) and
 * `integration` (§3.4/§3.5).
 */
export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type McpServerManifest = z.infer<typeof mcpServerManifestSchema>;
export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;
