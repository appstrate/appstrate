// SPDX-License-Identifier: Apache-2.0

// Skills a space imposes on its chat (#1586): platform authority, since members
// without `skills:*` are bound too; `latest` published, never the draft.

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  packageDistTags,
  packages,
  packageShares,
  packageVersions,
  spacePackages,
} from "@appstrate/db/schema";
import type { EnforcedChatSkill, EnforcedChatSkillRef } from "@appstrate/core/chat-contract";
import { asRecord } from "@appstrate/core/safe-json";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { activePackagesFilter, latestTagJoin } from "./space-packages.ts";
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
    .leftJoin(packageVersions, eq(packageVersions.id, packageDistTags.versionId))
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
