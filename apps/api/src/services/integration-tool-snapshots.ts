// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote integration's tool catalog looked like when last listed: one row per (organization,
 * integration, connection or none), written by every listing of the server and read by whoever
 * needs the tools a server offered, not only the ones it offers right now.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { OBSERVED_TOOLS_MAX_COUNT } from "@appstrate/core/sidecar-types";
import { sanitiseToolDescriptor, toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { db } from "@appstrate/db/client";
import {
  integrationToolSnapshots,
  type ToolDefinition,
  type ToolSnapshotEntry,
} from "@appstrate/db/schema";
import { trackAudit } from "./audit.ts";
import { scheduleToolReviewNotifications } from "./state/notifications.ts";

/** Past this many serialised bytes of definitions in one snapshot, the rest keep only their identity. */
const MAX_DEFINITION_BYTES = 512 * 1024;

export interface ToolSnapshot {
  connectionId: string | null;
  listedAt: Date;
  truncated: boolean;
  tools: ToolSnapshotEntry[];
}

interface SnapshotTarget {
  orgId: string;
  packageId: string;
  connectionId: string | null;
}

const targetMatches = ({ orgId, packageId, connectionId }: SnapshotTarget) =>
  and(
    eq(integrationToolSnapshots.orgId, orgId),
    eq(integrationToolSnapshots.packageId, packageId),
    connectionId === null
      ? isNull(integrationToolSnapshots.connectionId)
      : eq(integrationToolSnapshots.connectionId, connectionId),
  );

/**
 * Records a listing of `tools` (as the server returned them) as the target's snapshot. A tool
 * seen before keeps its `first_seen_at`; one whose definition changed gets `changed_at`. A
 * truncated listing keeps the tools it did not return, a complete one replaces the set. Answers
 * the names that appeared and the names whose definition changed.
 *
 * The previous row is read under a row lock, so two listings of one target merge one after the
 * other, never over each other.
 */
export async function recordToolSnapshot(
  input: SnapshotTarget & { tools: readonly Tool[]; truncated: boolean },
): Promise<{ added: string[]; changed: string[] }> {
  const now = new Date();
  const listed = new Map<string, { fingerprint: string; definition: ToolDefinition }>();
  for (const tool of input.tools) {
    if (listed.has(tool.name)) continue;
    listed.set(tool.name, {
      fingerprint: toolDefinitionFingerprint(tool),
      definition: sanitiseToolDescriptor(tool).tool as ToolDefinition,
    });
  }

  const result = await db.transaction(async (tx) => {
    // The row to lock exists before it is read: a first listing of a target has none yet.
    await tx
      .insert(integrationToolSnapshots)
      .values({
        orgId: input.orgId,
        packageId: input.packageId,
        connectionId: input.connectionId,
      })
      .onConflictDoNothing();
    const [previous] = await tx
      .select({
        tools: integrationToolSnapshots.tools,
        truncated: integrationToolSnapshots.truncated,
      })
      .from(integrationToolSnapshots)
      .where(targetMatches(input))
      .for("update");
    const before = new Map((previous?.tools ?? []).map((entry) => [entry.name, entry]));

    const added: string[] = [];
    const changed: string[] = [];
    const merged: ToolSnapshotEntry[] = [];
    for (const [name, { fingerprint, definition }] of listed) {
      const known = before.get(name);
      if (!known) added.push(name);
      else if (known.fingerprint !== fingerprint) changed.push(name);
      merged.push({
        name,
        fingerprint,
        first_seen_at: known?.first_seen_at ?? now.toISOString(),
        changed_at:
          known && known.fingerprint !== fingerprint
            ? now.toISOString()
            : (known?.changed_at ?? null),
        definition,
      });
    }
    if (input.truncated) {
      // The tools this listing did not return stay, the most recently seen first, within the cap.
      const unlisted = [...before.values()]
        .filter((entry) => !listed.has(entry.name))
        .sort((a, b) =>
          (b.changed_at ?? b.first_seen_at).localeCompare(a.changed_at ?? a.first_seen_at),
        );
      merged.push(...unlisted.slice(0, Math.max(0, OBSERVED_TOOLS_MAX_COUNT - merged.length)));
    }

    // The same tools at the same definitions: only the listing time moved.
    const sameSet =
      previous !== undefined &&
      previous.truncated === input.truncated &&
      merged.length === before.size &&
      merged.every((entry) => before.get(entry.name)?.fingerprint === entry.fingerprint);
    if (sameSet) {
      await tx.update(integrationToolSnapshots).set({ listedAt: now }).where(targetMatches(input));
      return { added, changed };
    }

    const encoder = new TextEncoder();
    let bytes = 0;
    const tools = merged.map((entry) => {
      if (entry.definition === null) return entry;
      bytes += encoder.encode(JSON.stringify(entry.definition)).byteLength;
      return bytes > MAX_DEFINITION_BYTES ? { ...entry, definition: null } : entry;
    });

    await tx
      .update(integrationToolSnapshots)
      .set({ listedAt: now, truncated: input.truncated, tools })
      .where(targetMatches(input));
    return { added, changed };
  });
  const names = [...result.added, ...result.changed];
  // Off the listing's path: the fan-out reads policies and reach of every space, and logs its own
  // failures. Tracked so shutdown (and a test) can flush it.
  if (names.length > 0) {
    void trackAudit(
      scheduleToolReviewNotifications({
        orgId: input.orgId,
        packageId: input.packageId,
        connectionId: input.connectionId,
        names,
      }),
    );
  }
  return result;
}

/** The snapshots of the integration's targets named: a connection's, or `null` for the shared one. */
export async function readToolSnapshots(input: {
  orgId: string;
  packageId: string;
  connectionIds: readonly (string | null)[];
}): Promise<ToolSnapshot[]> {
  const connections = input.connectionIds.filter((id): id is string => id !== null);
  const targets = [
    ...(connections.length > 0
      ? [inArray(integrationToolSnapshots.connectionId, connections)]
      : []),
    ...(input.connectionIds.includes(null) ? [isNull(integrationToolSnapshots.connectionId)] : []),
  ];
  if (targets.length === 0) return [];
  return db
    .select({
      connectionId: integrationToolSnapshots.connectionId,
      listedAt: integrationToolSnapshots.listedAt,
      truncated: integrationToolSnapshots.truncated,
      tools: integrationToolSnapshots.tools,
    })
    .from(integrationToolSnapshots)
    .where(
      and(
        eq(integrationToolSnapshots.orgId, input.orgId),
        eq(integrationToolSnapshots.packageId, input.packageId),
        or(...targets),
      ),
    );
}
