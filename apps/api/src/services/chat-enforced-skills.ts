// SPDX-License-Identifier: Apache-2.0

// Skills a space imposes on its chat (#1586): platform authority, since members
// without `skills:*` are bound too; `latest` published, never the draft.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  packageDistTags,
  packages,
  packageShares,
  packageVersions,
  spacePackages,
} from "@appstrate/db/schema";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  MAX_ENFORCED_CHAT_SKILLS,
  type EnforcedChatSkill,
  type EnforcedChatSkillRef,
} from "@appstrate/core/chat-contract";
import { asRecord } from "@appstrate/core/safe-json";
import { conflict } from "../lib/errors.ts";
import type { Tx } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { activePackagesFilter, latestTagJoin, updateSpacePackage } from "./space-packages.ts";
import { loadPublishedDefinition } from "./package-versions.ts";

/** The space's ACTIVE flagged skills, sorted by id, named from their `latest` published version. */
export async function listEnforcedChatSkills(
  orgId: string,
  spaceId: string,
): Promise<EnforcedChatSkillRef[]> {
  const rows = await db
    .select({
      id: packages.id,
      version: packageVersions.version,
      manifest: packageVersions.manifest,
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    // A yanked target does not resolve as `latest` (`resolveVersionFromCatalog`).
    .leftJoin(
      packageVersions,
      and(eq(packageVersions.id, packageDistTags.versionId), eq(packageVersions.yanked, false)),
    )
    .where(
      and(activePackagesFilter({ orgId, spaceId }, "skill"), eq(spacePackages.chatEnforced, true)),
    )
    .orderBy(packages.id);

  return rows.map(({ id, version, manifest }) => {
    const { display_name } = asRecord(manifest);
    return {
      packageId: id,
      name: typeof display_name === "string" ? display_name : id,
      version: version ?? null,
    };
  });
}

/**
 * {@link listEnforcedChatSkills} with each SKILL.md. `content: null` only when no
 * version resolves; an unreadable archive rejects, so a storage fault never
 * drops the policy silently.
 */
export async function loadEnforcedChatSkills(
  orgId: string,
  spaceId: string,
): Promise<EnforcedChatSkill[]> {
  const refs = await listEnforcedChatSkills(orgId, spaceId);
  return Promise.all(
    refs.map(async (ref) => {
      const published = ref.version
        ? await loadPublishedDefinition("skill", ref.packageId, ref.version)
        : null;
      return { ...ref, content: published?.content ?? null };
    }),
  );
}

type PlacementSettings = Parameters<typeof updateSpacePackage>[2];

/**
 * Enforcing writes first and checks after, under a per-space lock: concurrent
 * enforcements cannot both pass the cap, an unplaced 404 precedes any 409, and
 * a refusal rolls the whole patch back.
 */
export async function updatePlacementSettings(
  scope: SpaceScope,
  packageId: string,
  updates: PlacementSettings,
): Promise<{ chatEnforcedChanged: boolean }> {
  if (!updates.chatEnforced) {
    return updateSpacePackage(scope, packageId, updates, { requirePlacement: true });
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`space-chat-enforced:${scope.spaceId}`})::bigint)`,
    );
    const result = await updateSpacePackage(scope, packageId, updates, {
      requirePlacement: true,
      tx,
    });
    if (result.chatEnforcedChanged) await assertChatEnforceable(scope, packageId, tx);
    return result;
  });
}

// Every read goes through `tx`: under PGlite's single connection a query on
// the root `db` would wait on this very transaction.
async function assertChatEnforceable(scope: SpaceScope, packageId: string, tx: Tx) {
  const own = await loadPublishedDefinition("skill", packageId, "latest", tx);
  if (!own) {
    throw conflict(
      "no_published_version",
      `Skill '${packageId}' has no published version to enforce — publish it first`,
    );
  }

  // Every flagged row counts, enabled or not: re-activation brings the flag back unchecked.
  const flagged = await tx
    .select({ packageId: spacePackages.packageId })
    .from(spacePackages)
    .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.chatEnforced, true)));
  if (flagged.length > MAX_ENFORCED_CHAT_SKILLS) {
    throw conflict(
      "enforced_skills_limit",
      `A space enforces at most ${MAX_ENFORCED_CHAT_SKILLS} skills in its chat`,
      { limit: MAX_ENFORCED_CHAT_SKILLS },
    );
  }

  const others = await Promise.all(
    flagged
      .filter((row) => row.packageId !== packageId)
      .map((row) => loadPublishedDefinition("skill", row.packageId, "latest", tx)),
  );
  const total = others.reduce(
    (sum, skill) => sum + (skill?.content.length ?? 0),
    own.content.length,
  );
  if (total > CHAT_SKILLS_CONTENT_BUDGET_CHARS) {
    throw conflict(
      "enforced_skills_budget",
      `The enforced skills would total ${total} characters; the chat budget is ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}`,
      { budget: CHAT_SKILLS_CONTENT_BUDGET_CHARS, total },
    );
  }
}
