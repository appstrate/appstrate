// SPDX-License-Identifier: Apache-2.0

/**
 * The tool catalog an integration really offers in a space: the manifest's declared tools, the
 * undeclared ones its server listed (the stored snapshots), judged against the space's approvals
 * and blocks. Every reader of "which tools may be used" goes through here.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { isToolsWildcard } from "@appstrate/core/dependencies";
import {
  allowsUndeclaredTools,
  hiddenToolNames,
  judgeToolApprovals,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
  type IntegrationToolCatalogEntry,
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
import { ApiError } from "../lib/errors.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { syntheticToolNames } from "./integration-manifest-helpers.ts";
import { type ToolSnapshot, readToolSnapshots } from "./integration-tool-snapshot-reads.ts";

/** What a space decided about one integration's tools, as stored: approvals newest first. */
interface ToolSpaceRows {
  approvals: {
    tool_name: string;
    fingerprint: string;
    approved_at: Date;
    definition: ToolDefinition;
    approved_by: string | null;
  }[];
  blocks: { tool_name: string; blocked_by: string | null; blocked_at: Date }[];
}

interface RawToolPolicy {
  approvals: { tool_name: string; fingerprint: string }[];
  blocks: string[];
}

/**
 * The names and fingerprints of every space in `spaceIds` on `packageId`, unjudged (approvals
 * newest first): the lean read of every enforcement path, which never needs a definition.
 */
async function readRawToolPolicyForSpaces(
  orgId: string,
  spaceIds: readonly string[],
  packageId: string,
): Promise<Map<string, RawToolPolicy>> {
  const bySpace = new Map<string, RawToolPolicy>(
    spaceIds.map((id) => [id, { approvals: [], blocks: [] }]),
  );
  if (spaceIds.length === 0) return bySpace;
  const [approvals, blocks] = await Promise.all([
    db
      .select({
        spaceId: spaceIntegrationToolApprovals.spaceId,
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
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
  for (const { spaceId, tool_name } of blocks) bySpace.get(spaceId)?.blocks.push(tool_name);
  return bySpace;
}

/** The rows of one space, definitions and authors included: what the review surface shows. */
export async function readToolSpaceRows(
  scope: SpaceScope,
  packageId: string,
): Promise<ToolSpaceRows> {
  const { orgId, spaceId } = scope;
  const [approvals, blocks] = await Promise.all([
    db
      .select({
        tool_name: spaceIntegrationToolApprovals.toolName,
        fingerprint: spaceIntegrationToolApprovals.fingerprint,
        approved_at: spaceIntegrationToolApprovals.approvedAt,
        definition: spaceIntegrationToolApprovals.definition,
        approved_by: spaceIntegrationToolApprovals.approvedBy,
      })
      .from(spaceIntegrationToolApprovals)
      .where(
        and(
          eq(spaceIntegrationToolApprovals.orgId, orgId),
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
          eq(spaceIntegrationToolBlocks.orgId, orgId),
          eq(spaceIntegrationToolBlocks.spaceId, spaceId),
          eq(spaceIntegrationToolBlocks.packageId, packageId),
        ),
      ),
  ]);
  return { approvals, blocks };
}

/**
 * Judges a stored policy for every reader: an approval of a tool the manifest declares or hides,
 * or of any tool of an open catalog, stands for nothing (the manifest wins, even over an approval
 * recorded before it changed).
 */
export function judgeToolSpacePolicy(
  raw: ToolSpacePolicy,
  manifest: IntegrationManifest,
): ToolSpacePolicy {
  return { approvals: judgeToolApprovals(manifest, raw.approvals), blocks: raw.blocks };
}

/** The judged policy of every space in `spaceIds` on `packageId`: one query for approvals, one for blocks. */
export async function loadToolSpacePoliciesForSpaces(
  orgId: string,
  spaceIds: readonly string[],
  packageId: string,
  manifest: IntegrationManifest,
): Promise<Map<string, ToolSpacePolicy>> {
  const raw = await readRawToolPolicyForSpaces(orgId, spaceIds, packageId);
  return new Map([...raw].map(([id, policy]) => [id, judgeToolSpacePolicy(policy, manifest)]));
}

/** What the space approved and blocked among `packageId`'s tools, judged against the manifest. */
export async function loadToolSpacePolicy(
  scope: SpaceScope,
  packageId: string,
  manifest: IntegrationManifest,
): Promise<ToolSpacePolicy> {
  const policies = await loadToolSpacePoliciesForSpaces(
    scope.orgId,
    [scope.spaceId],
    packageId,
    manifest,
  );
  return policies.get(scope.spaceId)!;
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

/**
 * What the space's blocks take away from one `api_call` config, whichever door the call comes
 * through: blocking the call removes its upload too (an upload dispatches through its call);
 * blocking the upload alone leaves the call. The one rule the spawn spec and the credential proxy share.
 */
export function apiCallBlocks(
  cfg: { toolName: string; uploadToolName?: string; uploadProtocols: readonly string[] },
  blocks: readonly string[],
): { callBlocked: boolean; uploadBlocked: boolean } {
  const callBlocked = blocks.includes(cfg.toolName);
  const uploadBlocked =
    callBlocked ||
    (cfg.uploadProtocols.length > 0 &&
      cfg.uploadToolName !== undefined &&
      blocks.includes(cfg.uploadToolName));
  return { callBlocked, uploadBlocked };
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

/** The undeclared tools the space approved a definition of, blocked or not. */
export function allApprovedToolNames(policy: ToolSpacePolicy): Set<string> {
  return new Set(policy.approvals.map((a) => a.tool_name));
}

/** The undeclared tools the space approved a definition of and does not block. */
export function unblockedApprovedToolNames(policy: ToolSpacePolicy): Set<string> {
  const blocked = new Set(policy.blocks);
  return new Set([...allApprovedToolNames(policy)].filter((name) => !blocked.has(name)));
}

/** The tool names the manifest declares. */
export const declaredToolNames = (manifest: IntegrationManifest): string[] =>
  resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name);

/** A remote server whose undeclared tools need a space approval. */
export const isClosedRemoteCatalog = (manifest: IntegrationManifest): boolean =>
  manifest.source?.kind === "remote" && !allowsUndeclaredTools(manifest);

/**
 * The tool names an agent's selection names on `manifest`. A wildcard on a closed remote catalog
 * is not "every tool the server lists": it is what the manifest declares plus what the space
 * approved (bounded like the fingerprints map the sidecar validates), less the platform's own
 * tools. A wildcard elsewhere names none (the surface is not enumerated), else the explicit list.
 */
export function namedToolSelection(
  manifest: IntegrationManifest,
  selection: readonly string[] | "*" | undefined,
  policy: ToolSpacePolicy,
): readonly string[] {
  if (!isToolsWildcard(selection)) return selection ?? [];
  if (!isClosedRemoteCatalog(manifest)) return [];
  const platformTools = syntheticToolNames(manifest);
  return [
    ...declaredToolNames(manifest),
    ...[...unblockedApprovedToolNames(policy)].slice(0, OBSERVED_TOOLS_MAX_COUNT),
  ].filter((name) => !platformTools.has(name));
}

type EffectiveToolStatus = "available" | "missing" | "pending" | "blocked";
/** `declared`: in the manifest's catalog; `approved`: undeclared, approved in the space; `listed`: only the server lists it. */
type EffectiveToolOrigin = "declared" | "approved" | "listed";

/** A catalog entry with what the space policy and the live server listings say about it. */
export interface EffectiveToolEntry extends IntegrationToolCatalogEntry {
  status: EffectiveToolStatus;
  origin: EffectiveToolOrigin;
  /**
   * Declared tool: a listing carries a definition that changed since first seen (a signal only,
   * nothing acknowledges it). Undeclared approved tool: a listed fingerprint is not approved.
   */
  modified: boolean;
}

/** The space's decisions on one integration's tools, judged against its manifest. */
export interface ToolSpacePolicy {
  approvals: readonly { tool_name: string; fingerprint: string }[];
  blocks: readonly string[];
}

/** One stored listing of the server (one per connection). */
export interface ToolSnapshotView {
  tools: readonly {
    name: string;
    fingerprint: string;
    changed_at: string | null;
    /** What the server listed; absent past the snapshot's size cap. */
    definition?: { description?: unknown } | null;
  }[];
  truncated: boolean;
}

interface ResolveEffectiveToolCatalogInput {
  integration: IntegrationManifest;
  /** Judged by {@link loadToolSpacePolicy}; `null`: no space context, nothing approved or blocked. */
  policy: ToolSpacePolicy | null;
  snapshots: readonly ToolSnapshotView[];
}

/**
 * The catalog an agent can actually use in a space: the manifest's declared tools, plus the
 * undeclared ones the server lists, judged against the space's approvals and blocks.
 * Declared tools are never held back by a changed definition (`modified` only signals it);
 * on a closed catalog an undeclared tool needs an approval of its current fingerprint.
 * Declared tools first in catalog order, the rest by name.
 */
export function resolveEffectiveToolCatalog(
  input: ResolveEffectiveToolCatalogInput,
): EffectiveToolEntry[] {
  const { integration, policy, snapshots } = input;
  const declared = resolveIntegrationToolCatalog({ integration });
  const declaredNames = new Set(declared.map((e) => e.name));
  // Hidden tools are neither declared nor approvable: the server may list them, the space never sees them.
  const hidden = hiddenToolNames(integration);
  const open = allowsUndeclaredTools(integration);
  const blocked = new Set(policy?.blocks ?? []);

  const approvals = new Map<string, Set<string>>();
  for (const a of policy?.approvals ?? []) {
    const set = approvals.get(a.tool_name) ?? new Set<string>();
    set.add(a.fingerprint);
    approvals.set(a.tool_name, set);
  }

  const listings = new Map<string, ToolSnapshotView["tools"][number][]>();
  for (const snapshot of snapshots) {
    for (const tool of snapshot.tools) {
      const list = listings.get(tool.name) ?? [];
      list.push(tool);
      listings.set(tool.name, list);
    }
  }
  // Absence proves nothing once a listing was cut short, or when nothing was ever listed.
  const absenceIsMissing = snapshots.length > 0 && !snapshots.some((s) => s.truncated);

  const judge = (
    entry: IntegrationToolCatalogEntry,
    origin: EffectiveToolOrigin,
  ): EffectiveToolEntry => {
    const listed = listings.get(entry.name);
    let status: EffectiveToolStatus;
    let modified = false;
    if (!listed) {
      status = absenceIsMissing ? "missing" : "available";
    } else {
      const approved = approvals.get(entry.name);
      modified =
        origin === "declared"
          ? listed.some((l) => l.changed_at !== null)
          : approved !== undefined && listed.some((l) => !approved.has(l.fingerprint));
      if (origin === "declared" || open) {
        status = "available";
      } else if (approved && listed.some((l) => approved.has(l.fingerprint))) {
        status = "available";
      } else {
        status = "pending";
      }
    }
    if (blocked.has(entry.name)) status = "blocked";
    return { ...entry, status, origin, modified };
  };

  const undeclared = [...new Set([...listings.keys(), ...approvals.keys()])]
    .filter((name) => !declaredNames.has(name) && !hidden.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return [
    ...declared.map((entry) => judge(entry, "declared")),
    ...undeclared.map((name) =>
      judge(
        { name, ...listedDescription(listings.get(name)) },
        approvals.has(name) ? "approved" : "listed",
      ),
    ),
  ];
}

/** An undeclared tool's description is the server's: the first listing that carries one. */
function listedDescription(listed: readonly ToolSnapshotView["tools"][number][] | undefined): {
  description?: string;
} {
  for (const tool of listed ?? []) {
    const description = tool.definition?.description;
    if (typeof description === "string" && description.trim() !== "") return { description };
  }
  return {};
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
  const catalog = resolveEffectiveToolCatalog({ integration: input.manifest, policy, snapshots });
  return { catalog, snapshots };
}
