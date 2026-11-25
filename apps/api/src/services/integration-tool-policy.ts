// SPDX-License-Identifier: Apache-2.0

/**
 * A space's decisions on the tools of a remote integration: which definitions it approved for
 * undeclared tools, and which tools it blocks. Reads judge against the stored snapshots of the
 * connections the detail view uses; every write is one the dashboard makes for a person.
 */

import { and, eq } from "drizzle-orm";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { resolveIntegrationToolCatalog } from "@appstrate/core/integration";
import type { OrgRole } from "@appstrate/core/permissions";
import { db } from "@appstrate/db/client";
import {
  spaceIntegrationToolApprovals,
  spaceIntegrationToolBlocks,
  type ToolDefinition,
} from "@appstrate/db/schema";
import { ApiError, conflict } from "../lib/errors.ts";
import type { SpaceScope } from "../lib/scope.ts";
import type { ConnectionCaller } from "./connection-reach.ts";
import {
  listIntegrationConnections,
  loadManifestOrThrow,
  toolSnapshotConnectionIds,
} from "./integration-connections.ts";
import { readIntegrationManifestForConnect } from "./integration-service.ts";
import { loadEffectiveToolCatalog } from "./integration-tool-catalog.ts";
import { readToolSnapshots } from "./integration-tool-snapshots.ts";

export interface ToolPolicyTarget {
  scope: SpaceScope;
  packageId: string;
  caller: ConnectionCaller;
  orgRole: OrgRole | null;
}

export interface ListedTool {
  name: string;
  fingerprint: string;
  definition: ToolDefinition | null;
}

/** Every distinct (name, fingerprint) the caller's connections last listed, and the manifest's declared names. */
async function loadListedTools(target: ToolPolicyTarget) {
  const { scope, packageId } = target;
  const manifest = await loadManifestOrThrow(scope, packageId);
  const connections = await listIntegrationConnections(
    scope,
    packageId,
    target.caller,
    target.orgRole,
  );
  const snapshots = await readToolSnapshots({
    orgId: scope.orgId,
    packageId,
    connectionIds: toolSnapshotConnectionIds(manifest, connections),
  });
  const listed = new Map<string, ListedTool>();
  for (const snapshot of snapshots) {
    for (const { name, fingerprint, definition } of snapshot.tools) {
      const key = `${name}\u0000${fingerprint}`;
      const known = listed.get(key);
      if (!known) listed.set(key, { name, fingerprint, definition });
      else known.definition ??= definition;
    }
  }
  const declared = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name),
  );
  return { listed, declared };
}

/** What the space can review: the tools listed, its approvals and its blocks. */
export async function getToolPolicy(target: ToolPolicyTarget) {
  const { scope, packageId } = target;
  const [{ listed }, approvals, blocks] = await Promise.all([
    loadListedTools(target),
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
          eq(spaceIntegrationToolApprovals.spaceId, scope.spaceId),
          eq(spaceIntegrationToolApprovals.packageId, packageId),
        ),
      ),
    db
      .select({
        tool_name: spaceIntegrationToolBlocks.toolName,
        blocked_by: spaceIntegrationToolBlocks.blockedBy,
        blocked_at: spaceIntegrationToolBlocks.blockedAt,
      })
      .from(spaceIntegrationToolBlocks)
      .where(
        and(
          eq(spaceIntegrationToolBlocks.spaceId, scope.spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  return {
    listed: [...listed.values()],
    approvals: approvals.map((a) => ({ ...a, approved_at: a.approved_at.toISOString() })),
    blocks: blocks.map((b) => ({ ...b, blocked_at: b.blocked_at.toISOString() })),
  };
}

const namesOf = (tools: readonly { name: string }[]) => [...new Set(tools.map((t) => t.name))];

/**
 * Approves the current definition of undeclared tools. Another fingerprint of the same tool stays
 * approved: two instances behind a templated URL each have theirs. Answers the rows it added.
 */
export async function approveTools(
  target: ToolPolicyTarget,
  tools: readonly { name: string; fingerprint: string }[],
  approvedBy: string | null,
): Promise<{ toolName: string; fingerprint: string }[]> {
  const { listed, declared } = await loadListedTools(target);
  const alreadyDeclared = namesOf(tools.filter((t) => declared.has(t.name)));
  if (alreadyDeclared.length > 0) {
    throw new ApiError({
      status: 400,
      code: "tool_already_declared",
      title: "Tool Already Declared",
      detail: `The manifest already declares ${alreadyDeclared.join(", ")}: a declared tool needs no approval.`,
      extensions: { tools: alreadyDeclared },
    });
  }
  const stale = namesOf(tools.filter((t) => !listed.has(`${t.name}\u0000${t.fingerprint}`)));
  if (stale.length > 0) {
    throw conflict(
      "tool_snapshot_stale",
      `The server no longer lists ${stale.join(", ")} at the definition reviewed: refresh the tool list and review it again.`,
      { tools: stale },
    );
  }
  const distinct = [...new Map(tools.map((t) => [`${t.name}\u0000${t.fingerprint}`, t])).values()];
  const inserted = await db
    .insert(spaceIntegrationToolApprovals)
    .values(
      distinct.map(({ name, fingerprint }) => ({
        spaceId: target.scope.spaceId,
        orgId: target.scope.orgId,
        packageId: target.packageId,
        toolName: name,
        fingerprint,
        definition: listed.get(`${name}\u0000${fingerprint}`)!.definition,
        approvedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({
      toolName: spaceIntegrationToolApprovals.toolName,
      fingerprint: spaceIntegrationToolApprovals.fingerprint,
    });
  return inserted;
}

/** Withdraws every approval of the tool in the space; answers whether there was any. */
export async function revokeToolApproval(
  scope: SpaceScope,
  packageId: string,
  toolName: string,
): Promise<boolean> {
  const deleted = await db
    .delete(spaceIntegrationToolApprovals)
    .where(
      and(
        eq(spaceIntegrationToolApprovals.spaceId, scope.spaceId),
        eq(spaceIntegrationToolApprovals.packageId, packageId),
        eq(spaceIntegrationToolApprovals.toolName, toolName),
      ),
    )
    .returning({ id: spaceIntegrationToolApprovals.id });
  return deleted.length > 0;
}

/** Blocks tools in the space, declared or not; answers the names newly blocked. */
export async function blockTools(
  scope: SpaceScope,
  packageId: string,
  names: readonly string[],
  blockedBy: string | null,
): Promise<string[]> {
  const inserted = await db
    .insert(spaceIntegrationToolBlocks)
    .values(
      [...new Set(names)].map((toolName) => ({
        spaceId: scope.spaceId,
        orgId: scope.orgId,
        packageId,
        toolName,
        blockedBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ toolName: spaceIntegrationToolBlocks.toolName });
  return inserted.map((r) => r.toolName);
}

/** Lifts the block on a tool; answers whether there was one. */
export async function unblockTool(
  scope: SpaceScope,
  packageId: string,
  toolName: string,
): Promise<boolean> {
  const deleted = await db
    .delete(spaceIntegrationToolBlocks)
    .where(
      and(
        eq(spaceIntegrationToolBlocks.spaceId, scope.spaceId),
        eq(spaceIntegrationToolBlocks.packageId, packageId),
        eq(spaceIntegrationToolBlocks.toolName, toolName),
      ),
    )
    .returning({ id: spaceIntegrationToolBlocks.id });
  return deleted.length > 0;
}

/**
 * `<integrationId>:<tool>` for each tool an agent selects that only this space's approval makes
 * usable: what an export carries out of the space without the approval that backs it.
 */
export async function selectedApprovedTools(
  target: Omit<ToolPolicyTarget, "packageId">,
  agentManifest: Record<string, unknown>,
): Promise<string[]> {
  const { scope } = target;
  const selections = parseManifestIntegrations(agentManifest).filter(
    (entry) => Array.isArray(entry.tools) && entry.tools.length > 0,
  );
  const perIntegration = await Promise.all(
    selections.map(async (entry) => {
      const read = await readIntegrationManifestForConnect(scope, entry.id);
      if (!read.ok) return [];
      const connections = await listIntegrationConnections(
        scope,
        entry.id,
        target.caller,
        target.orgRole,
      );
      const { catalog } = await loadEffectiveToolCatalog({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        packageId: entry.id,
        manifest: read.manifest,
        connectionIds: toolSnapshotConnectionIds(read.manifest, connections),
      });
      const approved = new Set(catalog.filter((e) => e.origin === "approved").map((e) => e.name));
      return (entry.tools as string[])
        .filter((tool) => approved.has(tool))
        .map((tool) => `${entry.id}:${tool}`);
    }),
  );
  return perIntegration.flat();
}
