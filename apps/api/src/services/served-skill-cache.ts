// SPDX-License-Identifier: Apache-2.0

/**
 * The skills served for published versions (`./served-skills.ts`), kept in memory:
 * a published version is immutable, so an entry never goes stale and needs no
 * invalidation. The cache is bounded by the bytes of the files it holds and
 * evicts the least recently used skill first. It holds served content only;
 * whoever reads it has already applied the access rule.
 */

import type { ServedSkill } from "./served-skill.ts";

export interface ServedSkillCache {
  get: (key: string) => ServedSkill | undefined;
  set: (key: string, skill: ServedSkill) => void;
}

/**
 * The key of a published version of a skill in a space. The archive integrity
 * tells apart two archives published under one version, by a package deleted
 * and created again.
 */
export function servedSkillCacheKey(
  spaceId: string,
  packageId: string,
  version: string,
  integrity: string,
): string {
  return JSON.stringify([spaceId, packageId, version, integrity]);
}

function servedBytes(skill: ServedSkill): number {
  let bytes = 0;
  for (const file of Object.values(skill.files)) bytes += file.byteLength;
  return bytes;
}

/** A least-recently-used cache holding at most `maxBytes` of skill files; a larger skill is not kept. */
export function createServedSkillCache(maxBytes: number): ServedSkillCache {
  // A Map iterates in insertion order: re-inserting on use keeps the least recently used first.
  const entries = new Map<string, { skill: ServedSkill; bytes: number }>();
  let total = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    total -= entry.bytes;
  };

  return {
    get: (key) => {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.skill;
    },
    set: (key, skill) => {
      remove(key);
      const bytes = servedBytes(skill);
      if (bytes > maxBytes) return;
      for (const oldest of entries.keys()) {
        if (total + bytes <= maxBytes) break;
        remove(oldest);
      }
      entries.set(key, { skill, bytes });
      total += bytes;
    },
  };
}
