// SPDX-License-Identifier: Apache-2.0

// Skills a space imposes on its chat: platform authority, since members
// without `skills:*` are bound too; `latest` published, never the draft. Each
// is served as the MCP Skills extension serves it (`./served-skill.ts`): the
// same `SKILL.md` bytes, at the `skill://` URI `resources/read` answers.

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageDistTags, packages, packageVersions, spacePackages } from "@appstrate/db/schema";
import type { EnforcedChatSkill, EnforcedChatSkillRef } from "@appstrate/core/chat-contract";
import { asRecord } from "@appstrate/core/safe-json";
import { placementRowJoin } from "./package-placement.ts";
import { activePackagesFilter, latestTagJoin } from "./space-packages.ts";
import { skillFileUri } from "@appstrate/core/skill-uri";
import { readPackageSnapshot, resolvePackageFileValidator } from "./package-files.ts";
import { versionArtifactUnavailable } from "./package-versions.ts";
import { serveSkill, SKILL_ENTRY } from "./served-skill.ts";

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

/** The served `SKILL.md` of `version` and its `skill://` URI in `spaceId`. */
async function readServedSkillMd(
  orgId: string,
  spaceId: string,
  packageId: string,
  version: string,
): Promise<{ uri: string; content: string }> {
  // A published version's read keys off the package id alone; the draft columns stay unread.
  const pkg = {
    id: packageId,
    type: "skill" as const,
    orgId,
    draftManifest: null,
    draftContent: null,
  };
  const { files } = await readPackageSnapshot(pkg, await resolvePackageFileValidator(pkg, version));
  const served = serveSkill(packageId, files, version);
  if (!served.ok) {
    throw versionArtifactUnavailable(packageId, version, `skill to serve (${served.reason})`);
  }
  const { name, files: servedFiles } = served.skill;
  return {
    uri: skillFileUri({ spaceId, packageId, definition: "published", name, path: SKILL_ENTRY }),
    content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(servedFiles[SKILL_ENTRY]),
  };
}

/**
 * {@link listEnforcedChatSkills} with each served SKILL.md and its URI. `content`
 * and `uri` are `null` only when no version resolves; an unreadable or
 * unservable archive rejects, so a storage fault never drops the policy silently.
 */
export async function loadEnforcedChatSkills(
  orgId: string,
  spaceId: string,
): Promise<EnforcedChatSkill[]> {
  const refs = await listEnforcedChatSkills(orgId, spaceId);
  return Promise.all(
    refs.map(async (ref) => {
      const served = ref.version
        ? await readServedSkillMd(orgId, spaceId, ref.packageId, ref.version)
        : null;
      return { ...ref, uri: served?.uri ?? null, content: served?.content ?? null };
    }),
  );
}
