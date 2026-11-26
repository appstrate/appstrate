// SPDX-License-Identifier: Apache-2.0

/**
 * A space's decisions on the tools of a remote integration: which definitions it approved for
 * undeclared tools, and which tools it blocks. Reads judge against the stored snapshots of the
 * connections the detail view uses; every write is one the dashboard makes for a person.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import {
  allowsUndeclaredTools,
  hiddenToolNames,
  resolveEffectiveToolSelection,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import {
  MAX_APPROVED_FINGERPRINTS_PER_TOOL,
  OBSERVED_TOOLS_MAX_COUNT,
} from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import {
  spaceIntegrationToolApprovals,
  spaceIntegrationToolBlocks,
  type ToolDefinition,
} from "@appstrate/db/schema";
import type { Tx } from "../lib/db-helpers.ts";
import { conflict } from "../lib/errors.ts";
import type { SpaceScope } from "../lib/scope.ts";
import type { ConnectionCaller } from "./connection-reach.ts";
import {
  listReachableConnections,
  loadManifestOrThrow,
  toolSnapshotConnectionIds,
} from "./integration-connections.ts";
import { readIntegrationManifestForConnect } from "./integration-service.ts";
import {
  approvedNames,
  loadToolSpacePolicy,
  namedToolSelection,
  readToolSpaceRows,
} from "./integration-tool-catalog.ts";
import { readToolSnapshots } from "./integration-tool-snapshot-reads.ts";

export interface ToolPolicyTarget {
  scope: SpaceScope;
  packageId: string;
  caller: ConnectionCaller;
}

export interface ListedTool {
  name: string;
  fingerprint: string;
  definition: ToolDefinition | null;
}

/** The tool names the manifest declares, and those the platform withholds from every surface. */
function declaredAndHidden(manifest: IntegrationManifest) {
  return {
    declared: new Set(resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name)),
    hidden: hiddenToolNames(manifest),
  };
}

/** Every distinct (name, fingerprint) the caller's usable connections last listed. */
async function loadListedTools(target: ToolPolicyTarget) {
  const { scope, packageId } = target;
  const manifest = await loadManifestOrThrow(scope, packageId);
  const connections = await listReachableConnections(
    { spaceId: scope.spaceId, actor: target.caller.principal.actor },
    "usable",
    [packageId],
  );
  const snapshots = await readToolSnapshots({
    orgId: scope.orgId,
    packageId,
    connectionIds: toolSnapshotConnectionIds(manifest, connections),
  });
  const listed = new Map<string, ListedTool>();
  for (const snapshot of snapshots) {
    for (const { name, fingerprint, definition } of snapshot.tools) {
      const key = toolKey({ name, fingerprint });
      const known = listed.get(key);
      if (!known) listed.set(key, { name, fingerprint, definition });
      else known.definition ??= definition;
    }
  }
  return { manifest, listed, ...declaredAndHidden(manifest) };
}

/** What the space can review: the tools listed, its approvals and its blocks. */
export async function getToolPolicy(target: ToolPolicyTarget) {
  const [{ listed }, { approvals, blocks }] = await Promise.all([
    loadListedTools(target),
    readToolSpaceRows(target.scope, target.packageId),
  ]);
  return {
    listed: [...listed.values()],
    approvals: approvals.map((a) => ({ ...a, approved_at: a.approved_at.toISOString() })),
    blocks: blocks.map((b) => ({ ...b, blocked_at: b.blocked_at.toISOString() })),
  };
}

const namesOf = (tools: readonly { name: string }[]) => [...new Set(tools.map((t) => t.name))];

/** One tool at one definition: what an approval and a listing are keyed by. */
const toolKey = ({ name, fingerprint }: { name: string; fingerprint: string }) =>
  `${name}\u0000${fingerprint}`;

/**
 * Serialises the writers of a space's tool approvals and blocks of one integration for the rest of
 * the transaction. The limits are counted over rows that may not exist yet, which no row lock
 * covers: without it two concurrent writers both count under the limit and both insert past it.
 */
async function lockToolPolicy(tx: Tx, scope: SpaceScope, packageId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`tool-policy:${scope.spaceId}:${packageId}`})::bigint)`,
  );
}

/**
 * Approves the current definition of undeclared tools. Another fingerprint of the same tool stays
 * approved: two instances behind a templated URL each have theirs. Answers the rows it added.
 */
export async function approveTools(
  target: ToolPolicyTarget,
  tools: readonly { name: string; fingerprint: string }[],
  approvedBy: string,
): Promise<{ toolName: string; fingerprint: string }[]> {
  const { manifest, listed, declared, hidden } = await loadListedTools(target);
  if (allowsUndeclaredTools(manifest)) {
    throw conflict(
      "tool_catalog_open",
      `Integration '${target.packageId}' allows undeclared tools: none needs an approval.`,
      { tools: namesOf(tools) },
    );
  }
  const alreadyDeclared = namesOf(tools.filter((t) => declared.has(t.name)));
  if (alreadyDeclared.length > 0) {
    throw conflict(
      "tool_already_declared",
      `The manifest already declares ${alreadyDeclared.join(", ")}: a declared tool needs no approval.`,
      { tools: alreadyDeclared },
    );
  }
  const withheld = namesOf(tools.filter((t) => hidden.has(t.name)));
  if (withheld.length > 0) {
    throw conflict(
      "tool_hidden",
      `The platform withholds ${withheld.join(", ")} from every space: a hidden tool cannot be approved.`,
      { tools: withheld },
    );
  }
  const stale = namesOf(tools.filter((t) => !listed.has(toolKey(t))));
  if (stale.length > 0) {
    throw conflict(
      "tool_snapshot_stale",
      `The server no longer lists ${stale.join(", ")} at the definition reviewed: refresh the tool list and review it again.`,
      { tools: stale },
    );
  }
  const distinct = [...new Map(tools.map((t) => [toolKey(t), t])).values()];
  const definitions = distinct.map((t) => listed.get(toolKey(t))!.definition);
  const unreadable = namesOf(distinct.filter((_, i) => definitions[i] === null));
  if (unreadable.length > 0) {
    throw conflict(
      "tool_definition_unavailable",
      `The definition of ${unreadable.join(", ")} was too large to keep: it cannot be reviewed, so it cannot be approved.`,
      { tools: unreadable },
    );
  }
  // Counted and inserted under {@link lockToolPolicy}, so the limit is exact. What a run's spec
  // carries per tool: past it an approval would be silently left out.
  return db.transaction(async (tx) => {
    await lockToolPolicy(tx, target.scope, target.packageId);
    const held = await tx
      .select({
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
      })
      .from(spaceIntegrationToolApprovals)
      .where(
        and(
          eq(spaceIntegrationToolApprovals.orgId, target.scope.orgId),
          eq(spaceIntegrationToolApprovals.spaceId, target.scope.spaceId),
          eq(spaceIntegrationToolApprovals.packageId, target.packageId),
          inArray(
            spaceIntegrationToolApprovals.toolName,
            distinct.map((t) => t.name),
          ),
        ),
      );
    const fingerprints = new Map<string, Set<string>>();
    for (const { tool_name, fingerprint } of [
      ...held,
      ...distinct.map((t) => ({ tool_name: t.name, fingerprint: t.fingerprint })),
    ]) {
      fingerprints.set(tool_name, (fingerprints.get(tool_name) ?? new Set()).add(fingerprint));
    }
    const overLimit = namesOf(
      distinct.filter((t) => fingerprints.get(t.name)!.size > MAX_APPROVED_FINGERPRINTS_PER_TOOL),
    );
    if (overLimit.length > 0) {
      throw conflict(
        "tool_approvals_limit",
        `At most ${MAX_APPROVED_FINGERPRINTS_PER_TOOL} definitions of one tool can be approved, and a withdrawal removes every approved definition of the tool: withdraw the approvals of ${overLimit.join(", ")} first, then approve the definition to keep.`,
        { tools: overLimit },
      );
    }
    return tx
      .insert(spaceIntegrationToolApprovals)
      .values(
        distinct.map(({ name, fingerprint }, i) => ({
          spaceId: target.scope.spaceId,
          orgId: target.scope.orgId,
          packageId: target.packageId,
          toolName: name,
          fingerprint,
          definition: definitions[i]!,
          approvedBy,
        })),
      )
      .onConflictDoNothing()
      .returning({
        toolName: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
      });
  });
}

/** Withdraws every approval of the tool in the space; answers the rows withdrawn. */
export async function revokeToolApproval(
  scope: SpaceScope,
  packageId: string,
  toolName: string,
): Promise<{ toolName: string; fingerprint: string }[]> {
  return db
    .delete(spaceIntegrationToolApprovals)
    .where(
      and(
        eq(spaceIntegrationToolApprovals.orgId, scope.orgId),
        eq(spaceIntegrationToolApprovals.spaceId, scope.spaceId),
        eq(spaceIntegrationToolApprovals.packageId, packageId),
        eq(spaceIntegrationToolApprovals.toolName, toolName),
      ),
    )
    .returning({
      toolName: spaceIntegrationToolApprovals.toolName,
      fingerprint: spaceIntegrationToolApprovals.fingerprint,
    });
}

/**
 * Blocks tools in the space, declared or not; answers the names newly blocked. A space holds at
 * most `OBSERVED_TOOLS_MAX_COUNT` blocks per integration (the bound a spawn spec carries): past it,
 * `409 tool_blocks_limit`.
 */
export async function blockTools(
  scope: SpaceScope,
  packageId: string,
  names: readonly string[],
  blockedBy: string,
): Promise<string[]> {
  const wanted = [...new Set(names)];
  return db.transaction(async (tx) => {
    await lockToolPolicy(tx, scope, packageId);
    const held = await tx
      .select({ toolName: spaceIntegrationToolBlocks.toolName })
      .from(spaceIntegrationToolBlocks)
      .where(
        and(
          eq(spaceIntegrationToolBlocks.orgId, scope.orgId),
          eq(spaceIntegrationToolBlocks.spaceId, scope.spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      );
    const heldNames = new Set(held.map((r) => r.toolName));
    const fresh = wanted.filter((name) => !heldNames.has(name));
    if (heldNames.size + fresh.length > OBSERVED_TOOLS_MAX_COUNT) {
      throw conflict(
        "tool_blocks_limit",
        `A space blocks at most ${OBSERVED_TOOLS_MAX_COUNT} tools of one integration: lift a block before adding another.`,
        { tools: fresh },
      );
    }
    if (fresh.length === 0) return [];
    const inserted = await tx
      .insert(spaceIntegrationToolBlocks)
      .values(
        fresh.map((toolName) => ({
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
  });
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
        eq(spaceIntegrationToolBlocks.orgId, scope.orgId),
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
 * usable: what an export carries out of the space without the approval that backs it. The
 * selection is the one a run spawns with ({@link namedToolSelection}): a wildcard on a closed
 * remote catalog names every approved tool, and `default_tools` stand when the agent wrote none.
 */
export async function selectedApprovedTools(
  scope: SpaceScope,
  agentManifest: Record<string, unknown>,
): Promise<string[]> {
  const perIntegration = await Promise.all(
    parseManifestIntegrations(agentManifest).map(async (entry) => {
      const read = await readIntegrationManifestForConnect(scope, entry.id);
      if (!read.ok) return [];
      // Judged: an open catalog, a declared or a hidden tool stands on no approval.
      const policy = await loadToolSpacePolicy(scope, entry.id, read.manifest);
      const approved = approvedNames(policy);
      const selection = resolveEffectiveToolSelection(entry.tools, read.manifest);
      return namedToolSelection(read.manifest, selection, policy)
        .filter((tool) => approved.has(tool))
        .map((tool) => `${entry.id}:${tool}`);
    }),
  );
  return perIntegration.flat();
}
