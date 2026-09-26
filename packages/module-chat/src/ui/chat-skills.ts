// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { z } from "zod";
import { parseSkillList, type SkillHint } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";

/** The space's active skills, the ones the picker chooses from. */
export async function fetchSkills(getHeaders: GetHeaders | null | undefined): Promise<SkillHint[]> {
  const res = await fetch("/api/packages/skills", {
    credentials: "include",
    headers: { ...getHeaders?.() },
  });
  if (!res.ok) throw new Error(`Failed to load skills (HTTP ${res.status})`);
  return parseSkillList(await res.json());
}

/** The fields read off a row of `GET /api/chat/enforced-skills`. */
const enforcedSkillRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
});

/**
 * The skills the space imposes on every conversation, names only. Read through
 * the chat module (`chat:write`), not the skills listing, so a member without
 * `skills:read` still learns what the space requires. A malformed row is
 * dropped.
 */
export async function fetchEnforcedSkills(
  getHeaders: GetHeaders | null | undefined,
): Promise<SkillHint[]> {
  const res = await fetch("/api/chat/enforced-skills", {
    credentials: "include",
    headers: { ...getHeaders?.() },
  });
  if (!res.ok) throw new Error(`Failed to load the enforced skills (HTTP ${res.status})`);
  const data = ((await res.json()) as { data?: unknown } | null)?.data;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const parsed = enforcedSkillRowSchema.safeParse(row);
    if (!parsed.success) return [];
    const { id, name, version } = parsed.data;
    return [{ packageId: id, display_name: name, version }];
  });
}

/**
 * The user's own pins: an enforced skill is injected whatever the selection,
 * so a pin naming one is neither counted against the cap nor sent again.
 */
export function ownPins(pinned: readonly string[], enforced: ReadonlySet<string>): string[] {
  return pinned.filter((id) => !enforced.has(id));
}

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`), so a dead pin can still be removed. An enforced skill
 * is neither: the picker lists it apart, locked.
 */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
  enforced: ReadonlySet<string> = new Set(),
): { skill: SkillHint; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.packageId));
  const dead = ownPins(pinned, enforced).filter((id) => !listed.has(id));
  return [
    ...catalogue
      .filter((skill) => !enforced.has(skill.packageId))
      .map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({ skill: { packageId: id }, available: false })),
  ];
}
