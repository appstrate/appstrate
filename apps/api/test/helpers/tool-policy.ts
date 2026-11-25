// SPDX-License-Identifier: Apache-2.0

/** Fixtures shared by the tests of the space tool policy: a tool descriptor and approval rows. */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { spaceIntegrationToolApprovals } from "@appstrate/db/schema";
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
