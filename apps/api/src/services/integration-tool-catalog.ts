// SPDX-License-Identifier: Apache-2.0

/**
 * The tool catalog an integration really offers in a space: the manifest's declared tools, the
 * undeclared ones its server listed (the stored snapshots), judged against the space's approvals
 * and blocks. Every reader of "which tools may be used" goes through here.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  allowsUndeclaredTools,
  hiddenToolNames,
  resolveEffectiveToolCatalog,
  resolveIntegrationToolCatalog,
  type EffectiveToolEntry,
  type IntegrationManifest,
  type ToolSpacePolicy,
} from "@appstrate/core/integration";
import { MAX_APPROVED_FINGERPRINTS_PER_TOOL } from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { ApiError } from "../lib/errors.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { readToolSnapshots, type ToolSnapshot } from "./integration-tool-snapshots.ts";

/** Every approval and block row the space holds on `packageId`, approvals newest first. */
export async function readToolSpaceRows(scope: SpaceScope, packageId: string) {
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
          eq(spaceIntegrationToolApprovals.orgId, scope.orgId),
          eq(spaceIntegrationToolApprovals.spaceId, scope.spaceId),
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
          eq(spaceIntegrationToolBlocks.orgId, scope.orgId),
          eq(spaceIntegrationToolBlocks.spaceId, scope.spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  return { approvals, blocks };
}

type ToolRows = Awaited<ReturnType<typeof readToolSpaceRows>>;

/**
 * Judges stored rows for every reader: an approval of a tool the manifest declares or hides, or of
 * any tool of an open catalog, stands for nothing (the manifest wins, even over an approval
 * recorded before it changed).
 */
export function judgeToolSpacePolicy(
  rows: { approvals: ToolRows["approvals"]; blocks: ToolRows["blocks"] },
  manifest: IntegrationManifest,
): ToolSpacePolicy {
  const blocks = rows.blocks.map((b) => b.tool_name);
  if (allowsUndeclaredTools(manifest)) return { approvals: [], blocks };
  const declared = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name),
  );
  const hidden = hiddenToolNames(manifest);
  return {
    approvals: rows.approvals
      .filter((a) => !declared.has(a.tool_name) && !hidden.has(a.tool_name))
      .map(({ tool_name, fingerprint }) => ({ tool_name, fingerprint })),
    blocks,
  };
}

/** What the space approved and blocked among `packageId`'s tools, judged by {@link judgeToolSpacePolicy}. */
export async function loadToolSpacePolicy(
  scope: SpaceScope,
  packageId: string,
  manifest: IntegrationManifest,
): Promise<ToolSpacePolicy> {
  return judgeToolSpacePolicy(await readToolSpaceRows(scope, packageId), manifest);
}

/** The rows of every space in `spaceIds` on `packageId`: one query each for approvals and blocks. */
export async function readToolSpaceRowsForSpaces(
  orgId: string,
  spaceIds: readonly string[],
  packageId: string,
): Promise<Map<string, ToolRows>> {
  const bySpace = new Map<string, ToolRows>(
    spaceIds.map((id) => [id, { approvals: [], blocks: [] }]),
  );
  if (spaceIds.length === 0) return bySpace;
  const [approvals, blocks] = await Promise.all([
    db
      .select({
        spaceId: spaceIntegrationToolApprovals.spaceId,
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
        definition: spaceIntegrationToolApprovals.definition,
        approved_by: spaceIntegrationToolApprovals.approvedBy,
        approved_at: spaceIntegrationToolApprovals.approvedAt,
      })
      .from(spaceIntegrationToolApprovals)
      .where(
        and(
          eq(spaceIntegrationToolApprovals.orgId, orgId),
          inArray(spaceIntegrationToolApprovals.spaceId, [...spaceIds]),
          eq(spaceIntegrationToolApprovals.packageId, packageId),
        ),
      )
      .orderBy(desc(spaceIntegrationToolApprovals.approvedAt)),
    db
      .select({
        spaceId: spaceIntegrationToolBlocks.spaceId,
        tool_name: spaceIntegrationToolBlocks.toolName,
        blocked_by: spaceIntegrationToolBlocks.blockedBy,
        blocked_at: spaceIntegrationToolBlocks.blockedAt,
      })
      .from(spaceIntegrationToolBlocks)
      .where(
        and(
          eq(spaceIntegrationToolBlocks.orgId, orgId),
          inArray(spaceIntegrationToolBlocks.spaceId, [...spaceIds]),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  for (const { spaceId, ...row } of approvals) bySpace.get(spaceId)?.approvals.push(row);
  for (const { spaceId, ...row } of blocks) bySpace.get(spaceId)?.blocks.push(row);
  return bySpace;
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

/**
 * Tool name → the fingerprints approved for it, most recently approved first, at most
 * `MAX_APPROVED_FINGERPRINTS_PER_TOOL` of them: what a spawn spec carries, so a concurrent
 * approval past the limit can never produce a spec the sidecar refuses.
 */
export function approvedFingerprintsByTool(policy: ToolSpacePolicy): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  for (const { tool_name, fingerprint } of policy.approvals) {
    const held = byTool.get(tool_name) ?? [];
    if (held.length < MAX_APPROVED_FINGERPRINTS_PER_TOOL)
      byTool.set(tool_name, [...held, fingerprint]);
  }
  return byTool;
}

/** The undeclared tools the space approved a definition of and does not block. */
export function approvedToolNames(policy: ToolSpacePolicy): Set<string> {
  const blocked = new Set(policy.blocks);
  return new Set(policy.approvals.map((a) => a.tool_name).filter((name) => !blocked.has(name)));
}

/** The effective catalog of `manifest` judged against a policy and the snapshots read. */
export function effectiveCatalogOf(
  manifest: IntegrationManifest,
  policy: ToolSpacePolicy | null,
  snapshots: readonly ToolSnapshot[],
): EffectiveToolEntry[] {
  return resolveEffectiveToolCatalog({
    integration: manifest,
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
      : loadToolSpacePolicy(
          { orgId: input.orgId, spaceId: input.spaceId },
          input.packageId,
          input.manifest,
        ),
    readToolSnapshots(input),
  ]);
  const catalog = effectiveCatalogOf(input.manifest, policy, snapshots);
  return { catalog, snapshots };
}
