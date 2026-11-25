// SPDX-License-Identifier: Apache-2.0

/**
 * The tool catalog an integration really offers in a space: the manifest's declared tools, the
 * undeclared ones its server listed (the stored snapshots), judged against the space's approvals
 * and blocks. Every reader of "which tools may be used" goes through here.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  hiddenToolNames,
  resolveEffectiveToolCatalog,
  resolveIntegrationToolCatalog,
  type EffectiveToolEntry,
  type IntegrationManifest,
  type ToolSpacePolicy,
} from "@appstrate/core/integration";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { ApiError } from "../lib/errors.ts";
import { readToolSnapshots, type ToolSnapshot } from "./integration-tool-snapshots.ts";

/** Every approval and block row `spaceId` holds on `packageId`, approvals newest first. */
export async function readToolSpaceRows(spaceId: string, packageId: string) {
  const [approvals, blocks] = await Promise.all([
    db
      .select({
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
        definition: spaceIntegrationToolApprovals.definition,
        approved_by: spaceIntegrationToolApprovals.approvedBy,
        approved_at: spaceIntegrationToolApprovals.approvedAt,
      })
      .from(spaceIntegrationToolApprovals)
      .where(
        and(
          eq(spaceIntegrationToolApprovals.spaceId, spaceId),
          eq(spaceIntegrationToolApprovals.packageId, packageId),
        ),
      )
      .orderBy(desc(spaceIntegrationToolApprovals.approvedAt)),
    db
      .select({
        tool_name: spaceIntegrationToolBlocks.toolName,
        blocked_by: spaceIntegrationToolBlocks.blockedBy,
        blocked_at: spaceIntegrationToolBlocks.blockedAt,
      })
      .from(spaceIntegrationToolBlocks)
      .where(
        and(
          eq(spaceIntegrationToolBlocks.spaceId, spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  return { approvals, blocks };
}

/**
 * What `spaceId` approved and blocked among `packageId`'s tools, judged once for every reader: an
 * approval of a tool the manifest declares or hides stands for nothing (the manifest wins, even
 * over an approval recorded before it changed).
 */
export async function loadToolSpacePolicy(
  spaceId: string,
  packageId: string,
  manifest: IntegrationManifest,
): Promise<ToolSpacePolicy> {
  const { approvals, blocks } = await readToolSpaceRows(spaceId, packageId);
  const declared = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name),
  );
  const hidden = hiddenToolNames(manifest);
  return {
    approvals: approvals
      .filter((a) => !declared.has(a.tool_name) && !hidden.has(a.tool_name))
      .map(({ tool_name, fingerprint }) => ({ tool_name, fingerprint })),
    blocks: blocks.map((b) => b.tool_name),
  };
}

/** The refusal of a tool the space blocked, whichever door the call came through. */
export function toolBlockedInSpace(integrationId: string, toolName: string): ApiError {
  return new ApiError({
    status: 403,
    code: "tool_blocked_in_space",
    title: "Tool Blocked In This Space",
    detail: `Tool '${toolName}' of integration '${integrationId}' is blocked in this space.`,
  });
}

/** The refusal of raw HTTP to a remote integration's MCP endpoint: its tools are the way in. */
export function remoteMcpEndpointNotProxied(integrationId: string): ApiError {
  return new ApiError({
    status: 403,
    code: "remote_mcp_endpoint_not_proxied",
    title: "Remote MCP Endpoint Not Proxied",
    detail: `The MCP endpoint of integration '${integrationId}' is reachable through its tools only, which apply this space's tool policy.`,
  });
}

/** Tool name → the fingerprints approved for it, most recently approved first. */
export function approvedFingerprintsByTool(policy: ToolSpacePolicy): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  for (const { tool_name, fingerprint } of policy.approvals) {
    byTool.set(tool_name, [...(byTool.get(tool_name) ?? []), fingerprint]);
  }
  return byTool;
}

/** The undeclared tools the space approved a definition of and does not block. */
export function approvedToolNames(policy: ToolSpacePolicy): Set<string> {
  const blocked = new Set(policy.blocks);
  return new Set(policy.approvals.map((a) => a.tool_name).filter((name) => !blocked.has(name)));
}

/** The effective catalog, with the snapshots it was judged against. */
export async function loadEffectiveToolCatalog(input: {
  orgId: string;
  /** `null`: no space context, nothing approved or blocked. */
  spaceId: string | null;
  packageId: string;
  manifest: IntegrationManifest;
  connectionIds: readonly (string | null)[];
}): Promise<{ catalog: EffectiveToolEntry[]; snapshots: ToolSnapshot[] }> {
  const [policy, snapshots] = await Promise.all([
    input.spaceId === null
      ? null
      : loadToolSpacePolicy(input.spaceId, input.packageId, input.manifest),
    readToolSnapshots(input),
  ]);
  const catalog = resolveEffectiveToolCatalog({
    integration: input.manifest,
    policy,
    snapshots: snapshots.map((s) => ({
      truncated: s.truncated,
      tools: s.tools.map(({ name, fingerprint, changed_at }) => ({
        name,
        fingerprint,
        changed_at,
      })),
    })),
  });
  return { catalog, snapshots };
}
