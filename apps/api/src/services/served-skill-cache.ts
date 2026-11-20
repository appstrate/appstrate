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
  load: (key: string, read: () => Promise<ServedSkill | null>) => Promise<ServedSkill | null>;
}

/**
 * The key of a published version of a skill. The archive integrity
 * tells apart two archives published under one version, by a package deleted
 * and created again.
 */
export function servedSkillCacheKey(packageId: string, version: string, integrity: string): string {
  return JSON.stringify([packageId, version, integrity]);
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
  const pending = new Map<string, Promise<ServedSkill | null>>();
  let total = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    total -= entry.bytes;
  };

  return {
    async load(key, read) {
      const entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
        return entry.skill;
      }
      const loading = pending.get(key);
      if (loading) return loading;
      const result = read()
        .then((skill) => {
          if (!skill) return null;
          const bytes = servedBytes(skill);
          if (bytes <= maxBytes) {
            for (const oldest of entries.keys()) {
              if (total + bytes <= maxBytes) break;
              remove(oldest);
            }
            entries.set(key, { skill, bytes });
            total += bytes;
          }
          return skill;
        })
        .finally(() => pending.delete(key));
      pending.set(key, result);
      return result;
    },
  };
}
