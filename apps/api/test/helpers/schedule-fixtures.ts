// SPDX-License-Identifier: Apache-2.0

/**
 * Agent fixtures for the schedule write routes.
 *
 * A schedule is validated at the write — and fired on every tick — against the
 * manifest `resolveAgentRunVersion` selects, and with no `version_override`
 * that selector means the PUBLISHED version, never the draft. `seedAgent`
 * writes `packages.draft_manifest` only, so an agent seeded that way has
 * nothing to schedule against at all: the write answers 404
 * `no_published_version`, exactly as `POST …/run` does.
 *
 * Hence the two helpers. {@link publishAndInstall} makes a seeded agent
 * schedulable, so a test about something else (a body field, an actor, a cron)
 * is not silently testing "never published". {@link seedDivergedAgent}
 * publishes ONE manifest and then leaves a DIFFERENT one in the draft: without
 * that, draft and published are byte-identical and a test claiming the route
 * reads the published manifest passes just as well when it reads the draft.
 */

import { eq } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { db } from "./db.ts";
import { seedAgent } from "./seed.ts";
import { createVersionFromDraft } from "../../src/services/package-versions.ts";
import { installPackage } from "../../src/services/space-packages.ts";

/** Minimal agent manifest — `version` is what publish snapshots under. */
function agentManifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: id,
    version: "1.0.0",
    type: "agent",
    description: "Schedule fixture agent",
    ...extra,
  };
}

/**
 * Publish an already-seeded agent's draft as a version, and install it in the
 * space. The pair a schedule needs: the published version is what the
 * fire path executes, the installation is what the runtime gate requires.
 */
export async function publishAndInstall(args: {
  id: string;
  orgId: string;
  spaceId: string;
  userId: string;
}): Promise<void> {
  const published = await createVersionFromDraft({
    packageId: args.id,
    orgId: args.orgId,
    userId: args.userId,
  });
  if ("error" in published) {
    throw new Error(`fixture failed to publish ${args.id}: ${published.error}`);
  }
  await installPackage({ orgId: args.orgId, spaceId: args.spaceId }, args.id);
}

/**
 * Seed an agent, publish its draft, and install it. After this the draft and
 * the published version are identical — use {@link seedDivergedAgent} when the
 * difference between the two is the point of the test.
 */
export async function seedSchedulableAgent(args: {
  id: string;
  orgId: string;
  spaceId: string;
  userId: string;
  manifest?: Record<string, unknown>;
  content?: string;
}): Promise<void> {
  await seedAgent({
    id: args.id,
    orgId: args.orgId,
    createdBy: args.userId,
    draftManifest: args.manifest ?? agentManifest(args.id),
    draftContent: args.content ?? "Do the thing.",
  });
  await publishAndInstall(args);
}

/**
 * Seed an agent whose PUBLISHED manifest and DRAFT manifest differ.
 *
 * `published` is snapshotted first (that is what a schedule with no
 * `version_override` fires), then `draft` overwrites the working copy. Both
 * may carry the same `version`: the published snapshot already exists by then,
 * and keeping the label equal proves the route picked a manifest by SOURCE
 * rather than by version string.
 */
export async function seedDivergedAgent(args: {
  id: string;
  orgId: string;
  spaceId: string;
  userId: string;
  published: Record<string, unknown>;
  draft: Record<string, unknown>;
}): Promise<void> {
  await seedSchedulableAgent({
    id: args.id,
    orgId: args.orgId,
    spaceId: args.spaceId,
    userId: args.userId,
    manifest: args.published,
  });
  await db.update(packages).set({ draftManifest: args.draft }).where(eq(packages.id, args.id));
}
