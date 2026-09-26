// SPDX-License-Identifier: Apache-2.0

/**
 * Space-enforced chat skills (issue #1586): the skills a space imposes on every
 * chat conversation held in it, flagged on their placement row
 * (`space_packages.chat_enforced`).
 *
 * Read with PLATFORM authority — the chat injects them for every member,
 * whatever their `skills:*` grants — and always at the `latest` published
 * version, never the draft: what a space imposes is the same for everyone.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageShares, spacePackages } from "@appstrate/db/schema";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  MAX_ENFORCED_CHAT_SKILLS,
  type EnforcedChatSkill,
} from "@appstrate/core/chat-contract";
import { asRecord } from "@appstrate/core/safe-json";
import { ApiError, conflict } from "../lib/errors.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { activePackagesFilter } from "./space-packages.ts";
import { loadPublishedDefinition, type PublishedDefinition } from "./package-versions.ts";

/**
 * The `latest` published SKILL.md of a skill, or `null` when nothing is
 * published (deleted, yanked) or the archive is unreadable — an enforced skill
 * in that state renders a notice rather than failing the turn. Any other
 * failure (database, storage outage) propagates.
 */
async function readPublishedSkill(
  packageId: string,
  executor?: DbOrTx,
): Promise<PublishedDefinition | null> {
  try {
    return await loadPublishedDefinition("skill", packageId, "latest", executor);
  } catch (err) {
    if (err instanceof ApiError && err.code === "version_artifact_unavailable") return null;
    throw err;
  }
}

/**
 * The space's ACTIVE skills whose placement is chat-enforced, sorted by id,
 * each at its latest published version. A skill switched off here keeps its
 * flag but is not returned, and comes back when switched on again.
 */
export async function loadEnforcedChatSkills(
  orgId: string,
  spaceId: string,
): Promise<EnforcedChatSkill[]> {
  const scope: SpaceScope = { orgId, spaceId };
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
    .where(and(activePackagesFilter(scope, "skill"), eq(spacePackages.chatEnforced, true)))
    .orderBy(packages.id);

  return Promise.all(
    rows.map(async ({ id, draftManifest }) => {
      const published = await readPublishedSkill(id);
      const draftName = asRecord(draftManifest).display_name;
      return {
        packageId: id,
        name: published?.name ?? (typeof draftName === "string" ? draftName : id),
        version: published?.version ?? null,
        content: published?.content ?? null,
      };
    }),
  );
}

/**
 * Serialize the enforcement writes of one space: the cap and budget checks
 * below must see every concurrent enforcement, or two could both pass.
 */
export function withChatEnforcementLock<T>(
  spaceId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`space-chat-enforced:${spaceId}`})::bigint)`,
    );
    return work(tx);
  });
}

/**
 * Refuse enforcing `packageId` here, AFTER its flag was written in `tx` under
 * {@link withChatEnforcementLock}, so a throw rolls the write back: 409 when it
 * has no published version, when the space's flagged skills exceed
 * {@link MAX_ENFORCED_CHAT_SKILLS}, or when their published SKILL.md bodies
 * exceed {@link CHAT_SKILLS_CONTENT_BUDGET_CHARS}. Every flagged row counts,
 * enabled or not: re-activating a skill brings its flag back unchecked.
 *
 * Every read goes through `tx`: a query on the root `db` would wait on this
 * very transaction under PGlite's single connection.
 */
export async function assertChatEnforceable(
  scope: SpaceScope,
  packageId: string,
  tx: Tx,
): Promise<void> {
  const own = await loadPublishedDefinition("skill", packageId, "latest", tx);
  if (!own) {
    throw conflict(
      "no_published_version",
      `Skill '${packageId}' has no published version to enforce — publish it first`,
    );
  }

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
      .map((row) => readPublishedSkill(row.packageId, tx)),
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
