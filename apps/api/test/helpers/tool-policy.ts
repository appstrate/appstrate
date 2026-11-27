// SPDX-License-Identifier: Apache-2.0

/** Fixtures shared by the tests of the space tool policy: a tool descriptor and approval rows. */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { recordToolSnapshot } from "../../src/services/integration-tool-snapshots.ts";
import { db } from "./db.ts";

/** An MCP tool descriptor with no parameters; the description defaults to one derived from the name. */
export const tool = (name: string, description = `Tool ${name}`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

/** The fingerprint the platform computes for {@link tool}`(name, description)`. */
export const toolFingerprint = (name: string, description?: string): string =>
  toolDefinitionFingerprint(tool(name, description));

/** Where an approval lives: the space of an organization, on one integration. */
export interface ToolPolicyTarget {
  orgId: string;
  spaceId: string;
  packageId: string;
}

/** The policy target of `packageId` in a space of the test organization (its default space unless named). */
export const policyTarget = (
  ctx: { orgId: string; defaultSpaceId: string },
  packageId: string,
  spaceId: string = ctx.defaultSpaceId,
): ToolPolicyTarget => ({ orgId: ctx.orgId, spaceId, packageId });

/** Record what a server listed for an integration: org-wide unless a connection is named, complete unless `truncated`. */
export const snapshotTools = (
  target: { orgId: string; packageId: string },
  tools: readonly Tool[],
  opts: { connectionId?: string; truncated?: boolean } = {},
) =>
  recordToolSnapshot({
    orgId: target.orgId,
    packageId: target.packageId,
    connectionId: opts.connectionId ?? null,
    tools,
    truncated: opts.truncated ?? false,
  });

/** A listing too large for every definition to be kept: the tail of it lists a name and a fingerprint only. */
export const oversizedListing = (): Tool[] =>
  Array.from({ length: 400 }, (_, i) => tool(`t${i}`, "x".repeat(2000)));

export interface ApprovalRow {
  toolName: string;
  fingerprint: string;
  approvedAt?: Date;
}

/** Insert approval rows straight into the table, bypassing the approval route. */
export const insertToolApprovals = (target: ToolPolicyTarget, rows: readonly ApprovalRow[]) =>
  db.insert(spaceIntegrationToolApprovals).values(
    rows.map((row) => ({
      spaceId: target.spaceId,
      orgId: target.orgId,
      packageId: target.packageId,
      toolName: row.toolName,
      fingerprint: row.fingerprint,
      definition: {},
      ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
    })),
  );

/** Insert block rows straight into the table, bypassing the policy route. */
export const insertToolBlocks = (target: ToolPolicyTarget, toolNames: readonly string[]) =>
  db.insert(spaceIntegrationToolBlocks).values(
    toolNames.map((toolName) => ({
      spaceId: target.spaceId,
      orgId: target.orgId,
      packageId: target.packageId,
      toolName,
    })),
  );
