// SPDX-License-Identifier: Apache-2.0

import {
  getMcpServerBrowserCapability,
  getMcpServerRuntime,
  getMcpServerWorkspaceMount,
  type McpServerManifest,
  type McpServerWorkspaceMount,
} from "@appstrate/core/mcp-server";
import type { BrowserExecutionSpec, BrowserSessionMode } from "@appstrate/core/sidecar-types";

import { authorizeBrowserCapability } from "./browser-capability-grants.ts";
import {
  resolveMcpServerForSpawn,
  type McpServerResolution,
  type McpServerResolveFailure,
} from "./integration-service.ts";

export interface ResolvedLocalMcpServerExecution {
  readonly packageId: string;
  readonly version: string;
  readonly source: "system" | "version";
  readonly runtime: string;
  readonly entryPoint: string;
  readonly manifest: McpServerManifest;
  readonly workspaceMount?: McpServerWorkspaceMount;
  readonly browser?: BrowserExecutionSpec;
}

export type LocalMcpServerExecutionResolution =
  | { readonly ok: true; readonly execution: ResolvedLocalMcpServerExecution }
  | { readonly ok: false; readonly reason: McpServerResolveFailure };

export interface ResolveLocalMcpServerExecutionInput {
  readonly packageId: string;
  readonly orgId: string;
  readonly pin?: string | null;
  readonly sessionMode?: BrowserSessionMode;
  readonly connectionId?: string;
}

export type LocalMcpServerManifestResolver = (
  packageId: string,
  orgId: string,
  pin?: string | null,
) => Promise<McpServerResolution>;

export type BrowserCapabilityAuthorizer = typeof authorizeBrowserCapability;

/**
 * Resolve every execution-affecting property of a local MCP server at one
 * trust boundary. Agent runs and connect runs both consume this result; no
 * caller is allowed to reinterpret runtime, workspace, or browser metadata.
 */
export async function resolveLocalMcpServerExecution(
  input: ResolveLocalMcpServerExecutionInput,
  resolveManifest: LocalMcpServerManifestResolver = resolveMcpServerForSpawn,
  authorizeCapability: BrowserCapabilityAuthorizer = authorizeBrowserCapability,
): Promise<LocalMcpServerExecutionResolution> {
  const resolution = await resolveManifest(input.packageId, input.orgId, input.pin);
  if (!resolution.ok) return resolution;

  const manifest = resolution.manifest;
  const run = manifest.server;
  const version = resolution.version ?? manifest.version;
  const capability = getMcpServerBrowserCapability(manifest);
  const workspaceMount = getMcpServerWorkspaceMount(manifest);
  let browser: BrowserExecutionSpec | undefined;

  if (capability) {
    const authorization = authorizeCapability({
      packageId: input.packageId,
      version,
      capability,
    });
    browser = {
      purpose: capability.purpose,
      protocol: capability.protocol,
      profile: capability.profile,
      allowedOrigins: capability.origins,
      sessionMode: input.sessionMode ?? "none",
      trustedDriver: authorization.trustedDriver,
      ...(authorization.driverGrantId ? { driverGrantId: authorization.driverGrantId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    };
  }

  return {
    ok: true,
    execution: {
      packageId: input.packageId,
      version,
      source: resolution.source,
      runtime: getMcpServerRuntime(manifest) ?? run.type,
      entryPoint: run.entry_point,
      manifest,
      ...(workspaceMount ? { workspaceMount } : {}),
      ...(browser ? { browser } : {}),
    },
  };
}
