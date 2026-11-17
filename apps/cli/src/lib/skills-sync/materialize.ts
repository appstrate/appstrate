// SPDX-License-Identifier: Apache-2.0

/**
 * Directory names of `appstrate code sync`: the collision fallback for a skill
 * whose served name is taken. Pure, so a re-run names every skill identically.
 */

import { isValidSkillName, SKILL_NAME_MAX_LENGTH } from "@appstrate/afps-shared/companion-files";
import { toSlug } from "@appstrate/core/naming";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";

export const SKILL_ENTRY = PACKAGE_CONTENT_ENTRY.skill!.path;

class SkillMaterializeError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillMaterializeError";
  }
}

/**
 * `<scope>-<name>`, then `-2`, `-3`, … until free, applied to the later of two
 * claimants. The counter is load-bearing: `<scope>-<name>` can itself collide,
 * and a duplicate would abort the whole sync on the `wx` write.
 */
export function collisionSlug(packageId: string, taken: ReadonlySet<string>): string {
  const withoutAt = packageId.replace(/^@/, "").replace("/", "-");
  return freeSlug(withoutAt, taken, packageId);
}

function freeSlug(raw: string, taken: ReadonlySet<string>, source: string): string {
  const base = toSlug(raw, SKILL_NAME_MAX_LENGTH).replace(/-+$/, "");
  if (!isValidSkillName(base)) {
    throw new SkillMaterializeError(
      `Cannot derive a collision-free skill directory name from "${source}"`,
      "Agent Skills names are 1-64 characters of [a-z0-9-].",
    );
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    // Trim the BASE, not the suffix: a truncated counter would collide again.
    const head = base.slice(0, SKILL_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate) && isValidSkillName(candidate)) return candidate;
  }
}
