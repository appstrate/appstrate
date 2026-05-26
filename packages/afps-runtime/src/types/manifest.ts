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

/**
 * The `_meta` key carrying an mcp-server's portable AFPS identity (§3.4).
 *
 * Mirrors `@appstrate/core/mcp-server`'s `MCP_SERVER_META_KEY`. Defined locally
 * (rather than imported from core) because afps-runtime is the portable bundle
 * runner and deliberately depends only on `@afps-spec/schema`, never on the
 * platform's `@appstrate/core`.
 */
export const MCP_SERVER_META_KEY = "dev.afps/mcp-server";

/**
 * Read an mcp-server's AFPS package identity from
 * `_meta["dev.afps/mcp-server"].name`. The top-level `name` of an mcp-server
 * manifest is MCPB-governed (an unscoped server slug), NOT the AFPS scoped
 * identity (§3.4 / §2.2) — so callers that need the `@scope/name` identity of
 * an mcp-server package MUST read it from here.
 *
 * Mirrors `@appstrate/core/mcp-server`'s `getMcpServerAfpsName`.
 */
export function getMcpServerAfpsName(manifest: unknown): string | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> } | null | undefined)?._meta;
  const afps = meta?.[MCP_SERVER_META_KEY] as { name?: unknown } | undefined;
  return typeof afps?.name === "string" ? afps.name : undefined;
}
