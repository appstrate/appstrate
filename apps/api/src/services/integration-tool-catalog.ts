// SPDX-License-Identifier: Apache-2.0

/**
 * The tool catalog an integration really offers in a space: the manifest's declared tools, the
 * undeclared ones its server listed (the stored snapshots), judged against the space's approvals
 * and blocks. Every reader of "which tools may be used" goes through here.
 */

import { and, desc, eq } from "drizzle-orm";
import {
  resolveEffectiveToolCatalog,
  type EffectiveToolEntry,
  type IntegrationManifest,
  type ToolSpacePolicy,
} from "@appstrate/core/integration";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { ApiError } from "../lib/errors.ts";
import { readToolSnapshots, type ToolSnapshot } from "./integration-tool-snapshots.ts";

/** What `spaceId` approved and blocked among `packageId`'s tools. */
export async function loadToolSpacePolicy(
  spaceId: string,
  packageId: string,
): Promise<ToolSpacePolicy> {
  const [approvals, blocks] = await Promise.all([
    db
      .select({
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
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
      .select({ toolName: spaceIntegrationToolBlocks.toolName })
      .from(spaceIntegrationToolBlocks)
      .where(
        and(
          eq(spaceIntegrationToolBlocks.spaceId, spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  return { approvals, blocks: blocks.map((b) => b.toolName) };
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

/** Tool name → the fingerprints approved for it, most recently approved first. */
export function approvedFingerprintsByTool(policy: ToolSpacePolicy): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  for (const { tool_name, fingerprint } of policy.approvals) {
    byTool.set(tool_name, [...(byTool.get(tool_name) ?? []), fingerprint]);
  }
  return byTool;
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
    input.spaceId === null ? null : loadToolSpacePolicy(input.spaceId, input.packageId),
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
